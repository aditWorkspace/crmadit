import type { gmail_v1 } from 'googleapis';
import { getGmailClientForMember } from './client';
import { isOutreachThread, extractCompanyFromSubject, isBounceEmail } from './matcher';
import { parseCalendarInvite } from './calendar-parser';
import { isCalendarNoise, hasNonInviteIcsMethod } from './calendar-noise';
import { createAdminClient } from '@/lib/supabase/admin';
import { syncCalendarLeads } from '@/lib/google/calendar-sync';
import { callAI } from '@/lib/ai/openrouter';
import { QWEN_FREE_MODEL, STAGE_ORDER } from '@/lib/constants';
import { classifySchedulingIntent } from './scheduling-classifier';
import { normalizeName } from '@/lib/name-utils';
import { cancelQueuedAutoSendForLead } from '@/lib/automation/cancel-queued-autosend';
import { tagInboundForReview } from '@/lib/automation/inbox-mentions';
import { triageInboundEmail } from '@/lib/ai/inbox-triage';
import { companyFromDomain } from '@/lib/leads/contact-utils';
import { upsertLeadContact, collectExternalParticipants } from '@/lib/leads/upsert-contact';

/** Returns true if `proposed` stage is forward from `current` in the pipeline. */
function isForwardStage(current: string, proposed: string): boolean {
  const ci = STAGE_ORDER.indexOf(current as (typeof STAGE_ORDER)[number]);
  const pi = STAGE_ORDER.indexOf(proposed as (typeof STAGE_ORDER)[number]);
  if (ci === -1 || pi === -1) return false;
  return pi > ci;
}

interface EmailHeader {
  from: string;
  to: string;
  cc: string;
  subject: string;
  date: string;
  /** Raw RFC 5322 Message-Id header. Globally unique and identical in every
   *  mailbox that holds the message, so it survives cross-account threading.
   *  Stored as "<xxx@domain>" including angle brackets. */
  rfcMessageId: string;
}

function parseHeaders(headers: Array<{ name?: string | null; value?: string | null }>): EmailHeader {
  const get = (name: string) =>
    headers.find(h => h.name?.toLowerCase() === name.toLowerCase())?.value || '';
  // Gmail sometimes uses "Message-ID", sometimes "Message-Id" — case-insensitive get handles both.
  const rawMsgId = get('Message-Id');
  // Normalize: ensure angle brackets, trim whitespace, drop anything after whitespace (some
  // senders pack comments after the id, which are illegal but common).
  const rfcMessageId = rawMsgId
    ? (rawMsgId.trim().startsWith('<') ? rawMsgId.trim().split(/\s+/)[0] : `<${rawMsgId.trim().split(/\s+/)[0]}>`)
    : '';
  return {
    from: get('From'),
    to: get('To'),
    cc: get('Cc'),
    subject: get('Subject'),
    date: get('Date'),
    rfcMessageId,
  };
}

function extractEmail(headerValue: string): string {
  const match = headerValue.match(/<([^>]+)>/);
  return match ? match[1].toLowerCase() : headerValue.toLowerCase().trim();
}

function extractName(headerValue: string): string {
  const match = headerValue.match(/^([^<]+)</);
  return match ? match[1].trim().replace(/^"|"$/g, '') : '';
}

function getBodyPreview(message: gmail_v1.Schema$Message): string {
  const payload = message.payload;
  if (!payload) return '';

  let data: string | null | undefined = null;

  if (payload.body?.data) {
    data = payload.body.data;
  } else if (payload.parts) {
    const findText = (parts: gmail_v1.Schema$MessagePart[]): string | null => {
      for (const part of parts) {
        if (part.mimeType === 'text/plain' && part.body?.data) return part.body.data;
        if (part.parts) { const found = findText(part.parts); if (found) return found; }
      }
      return null;
    };
    data = findText(payload.parts);
  }

  if (!data) return '';

  try {
    const decoded = Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf-8');
    return decoded.slice(0, 500);
  } catch {
    return '';
  }
}

export interface SyncResult {
  synced: number;
  created_leads: number;
  errors: string[];
  duration_ms: number;
  calendar_events_detected: number;
  calendar_leads_created: number;
  calendar_leads_updated: number;
}

/**
 * Load every team member's email → id map. Used to recognize any co-founder's
 * outbound email during a sync — not just the syncing member's. Without this,
 * a thread where Srijay syncs while Adit also replied would mis-label Adit's
 * messages as `email_inbound` and attribute them to the prospect.
 */
async function loadTeamEmails(
  supabase: ReturnType<typeof import('@/lib/supabase/admin').createAdminClient>,
): Promise<Map<string, string>> {
  const { data } = await supabase.from('team_members').select('id, email');
  const map = new Map<string, string>();
  for (const m of data ?? []) {
    if (m?.email) map.set(m.email.toLowerCase(), m.id);
  }
  return map;
}

export async function runInitialSync(teamMemberId: string): Promise<SyncResult> {
  const start = Date.now();
  const result: SyncResult = { synced: 0, created_leads: 0, errors: [], duration_ms: 0, calendar_events_detected: 0, calendar_leads_created: 0, calendar_leads_updated: 0 };

  const supabase = createAdminClient();

  // Bug #9 fix — track sync status
  await supabase.from('email_sync_state').upsert(
    { team_member_id: teamMemberId, status: 'syncing', error_message: null, updated_at: new Date().toISOString() },
    { onConflict: 'team_member_id' }
  );

  let gmail;
  try {
    ({ gmail } = await getGmailClientForMember(teamMemberId));
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    result.errors.push(errorMsg);
    result.duration_ms = Date.now() - start;
    await supabase.from('email_sync_state').upsert(
      { team_member_id: teamMemberId, status: 'failed', error_message: errorMsg, updated_at: new Date().toISOString() },
      { onConflict: 'team_member_id' }
    );
    return result;
  }

  const { data: member } = await supabase
    .from('team_members')
    .select('id, email, name')
    .eq('id', teamMemberId)
    .single();

  if (!member) {
    result.errors.push('Team member not found');
    result.duration_ms = Date.now() - start;
    return result;
  }

  const profileRes = await gmail.users.getProfile({ userId: 'me' });
  const gmailEmail = profileRes.data.emailAddress?.toLowerCase() || member.email.toLowerCase();
  const teamEmails = await loadTeamEmails(supabase);

  const threadIds = new Set<string>();
  let pageToken: string | undefined;

  do {
    const listRes = await gmail.users.messages.list({
      userId: 'me',
      // Match both strict ("...at <Company>") and loose ("Berkeley student
      // interested in product prioritization") subject forms — processMessage
      // re-validates with isOutreachThread before doing anything.
      q: '(subject:"product prioritization" OR subject:"customer feedback workflow") newer_than:30d -from:me',
      maxResults: 100,
      pageToken,
    });

    for (const msg of listRes.data.messages || []) {
      if (msg.threadId) threadIds.add(msg.threadId);
    }
    pageToken = listRes.data.nextPageToken || undefined;
  } while (pageToken);

  for (const threadId of threadIds) {
    try {
      const threadRes = await gmail.users.threads.get({
        userId: 'me',
        id: threadId,
        format: 'full',
      });

      const messages = threadRes.data.messages || [];
      for (const message of messages) {
        if (!message.id) continue;
        try {
          await processMessage(supabase, message, gmailEmail, member, teamEmails, result);
        } catch (err) {
          result.errors.push(`Message ${message.id}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    } catch (err) {
      result.errors.push(`Thread ${threadId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const finalProfile = await gmail.users.getProfile({ userId: 'me' });
  const historyId = finalProfile.data.historyId;

  await supabase
    .from('team_members')
    .update({ gmail_history_id: historyId, last_gmail_sync: new Date().toISOString() })
    .eq('id', teamMemberId);

  await supabase
    .from('email_sync_state')
    .upsert(
      { team_member_id: teamMemberId, last_sync_at: new Date().toISOString(), history_id: historyId, total_synced: result.synced, status: 'completed', error_message: null, updated_at: new Date().toISOString() },
      { onConflict: 'team_member_id' }
    );

  // Calendar sync: import meetings from past 7 days + upcoming 30 days as leads
  try {
    const calResult = await syncCalendarLeads(teamMemberId);
    result.calendar_leads_created = calResult.leads_created;
    result.calendar_leads_updated = calResult.leads_updated;
    result.calendar_events_detected += calResult.events_scanned;
    result.errors.push(...calResult.errors.map(e => `[calendar] ${e}`));
  } catch (err) {
    result.errors.push(`[calendar] ${err instanceof Error ? err.message : String(err)}`);
  }

  result.duration_ms = Date.now() - start;
  return result;
}

export async function runIncrementalSync(teamMemberId: string): Promise<SyncResult> {
  const start = Date.now();
  const result: SyncResult = { synced: 0, created_leads: 0, errors: [], duration_ms: 0, calendar_events_detected: 0, calendar_leads_created: 0, calendar_leads_updated: 0 };

  const supabase = createAdminClient();
  const { data: member } = await supabase
    .from('team_members')
    .select('id, email, name, gmail_history_id')
    .eq('id', teamMemberId)
    .single();

  if (!member) {
    result.errors.push('Team member not found');
    result.duration_ms = Date.now() - start;
    return result;
  }

  if (!member.gmail_history_id) return runInitialSync(teamMemberId);

  const { gmail } = await getGmailClientForMember(teamMemberId);

  const profileRes = await gmail.users.getProfile({ userId: 'me' });
  const gmailEmail = profileRes.data.emailAddress?.toLowerCase() || member.email.toLowerCase();
  const teamEmails = await loadTeamEmails(supabase);

  let pageToken: string | undefined;
  const processedMessageIds = new Set<string>();

  do {
    let historyRes;
    try {
      historyRes = await gmail.users.history.list({
        userId: 'me',
        startHistoryId: member.gmail_history_id,
        historyTypes: ['messageAdded'],
        maxResults: 500,
        pageToken,
      });
    } catch (err: unknown) {
      // Handle stale/invalid history ID — fall back to full sync
      const errObj = err as { code?: number; status?: number; message?: string };
      const errStr = String(err);
      if (errObj.code === 404 || errObj.status === 404 || errStr.includes('Invalid startHistoryId') || errStr.includes('notFound')) {
        console.warn(`[sync] History ID stale for ${teamMemberId}, falling back to initial sync`);
        return runInitialSync(teamMemberId);
      }
      throw err;
    }

    const historyList = historyRes.data.history || [];
    pageToken = historyRes.data.nextPageToken || undefined;

    for (const historyItem of historyList) {
      for (const { message } of historyItem.messagesAdded || []) {
        if (!message?.id || processedMessageIds.has(message.id)) continue;
        processedMessageIds.add(message.id);

        try {
          const msgRes = await gmail.users.messages.get({ userId: 'me', id: message.id, format: 'full' });
          await processMessage(supabase, msgRes.data, gmailEmail, member, teamEmails, result);
        } catch (err) {
          result.errors.push(`Message ${message.id}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }

    if (historyRes.data.historyId) {
      await supabase
        .from('team_members')
        .update({ gmail_history_id: historyRes.data.historyId, last_gmail_sync: new Date().toISOString() })
        .eq('id', teamMemberId);

      await supabase
        .from('email_sync_state')
        .upsert(
          { team_member_id: teamMemberId, last_sync_at: new Date().toISOString(), history_id: historyRes.data.historyId, updated_at: new Date().toISOString() },
          { onConflict: 'team_member_id' }
        );
    }
  } while (pageToken);

  // Calendar sync on every incremental run — detect new/updated events
  try {
    const calResult = await syncCalendarLeads(teamMemberId);
    result.calendar_leads_created = calResult.leads_created;
    result.calendar_leads_updated = calResult.leads_updated;
    result.calendar_events_detected += calResult.events_scanned;
    result.errors.push(...calResult.errors.map(e => `[calendar] ${e}`));
  } catch (err) {
    result.errors.push(`[calendar] ${err instanceof Error ? err.message : String(err)}`);
  }

  result.duration_ms = Date.now() - start;
  return result;
}

/**
 * Find a lead by the prospect's email address — searches globally across
 * ALL owners so that shared calendar invites / CC'd emails don't create
 * duplicates. Returns the lead id if found.
 */
async function findLeadByContactEmail(
  supabase: ReturnType<typeof import('@/lib/supabase/admin').createAdminClient>,
  contactEmail: string,
  _memberId?: string          // kept for call-site compat; no longer used
): Promise<string | null> {
  const { data } = await supabase
    .from('leads')
    .select('id')
    .eq('contact_email', contactEmail)
    .eq('is_archived', false)
    .not('stage', 'in', '("dead")')
    .order('updated_at', { ascending: false })   // prefer most-recently-active lead
    .limit(1)
    .maybeSingle();
  return data?.id ?? null;
}

async function processMessage(
  supabase: ReturnType<typeof import('@/lib/supabase/admin').createAdminClient>,
  message: gmail_v1.Schema$Message,
  gmailEmail: string,
  member: { id: string; email: string; name: string },
  teamEmails: Map<string, string>,
  result: SyncResult
) {
  const headers = parseHeaders(message.payload?.headers || []);
  const fromEmail = extractEmail(headers.from);
  const toEmail = extractEmail(headers.to);
  // Any team member's email counts as outbound — not just the syncing member.
  // Without this, Adit's replies synced through Srijay's Gmail would be
  // mislabeled `email_inbound` and render under the prospect's name.
  const isOutbound = teamEmails.has(fromEmail) || fromEmail === gmailEmail;
  // Attribute the interaction to the actual sender so MessageCard shows the
  // right name/color. Falls back to the syncing member for inbound + for
  // co-founder outbounds we somehow can't map.
  const senderMemberId = isOutbound
    ? (teamEmails.get(fromEmail) ?? member.id)
    : member.id;
  const contactEmail = isOutbound ? toEmail : fromEmail;

  // Fast-path: if this message has already been synced, skip the heavy work
  // (lead lookups, AI classification, stage logic) but still backfill any
  // missing lead_contacts entries — the participant capture was added later
  // than the interaction insert, and full resyncs need to retroactively
  // populate contacts on historical messages without re-running everything.
  if (message.id) {
    const { data: existing } = await supabase
      .from('interactions')
      .select('lead_id')
      .eq('gmail_message_id', message.id)
      .maybeSingle();
    if (existing?.lead_id) {
      await captureThreadParticipants(
        supabase,
        existing.lead_id as string,
        headers,
        teamEmails,
        isOutbound ? 'cc' : 'reply'
      );
      return;
    }
  }

  // ── Bounce/NDR detection — skip entirely, and dead any matched lead ────────
  if (isBounceEmail(headers.subject)) {
    // Try to find and mark the lead dead so it's not worked further
    const company = extractCompanyFromSubject(headers.subject);
    if (company) {
      const { data: bouncedLead } = await supabase
        .from('leads')
        .select('id, stage')
        .eq('company_name', company)
        .eq('is_archived', false)
        .not('stage', 'in', '("dead","active_user")')
        .limit(1)
        .maybeSingle();

      if (bouncedLead) {
        await supabase.from('leads').update({ stage: 'dead', updated_at: new Date().toISOString() }).eq('id', bouncedLead.id);
        await supabase.from('interactions').insert({
          lead_id: bouncedLead.id,
          team_member_id: member.id,
          type: 'note',
          subject: 'Email bounced — undeliverable',
          body: `NDR received: ${headers.subject}`,
          gmail_message_id: message.id,
          occurred_at: message.internalDate ? new Date(parseInt(message.internalDate)).toISOString() : new Date().toISOString(),
          metadata: { bounce: true },
        }).then(({ error: bounceErr }) => {
          if (bounceErr && (bounceErr as { code?: string }).code !== '23505') {
            console.error('[sync] Failed to insert bounce interaction:', bounceErr.message);
          }
        });
      }
    }
    return;
  }

  // ── Path 0: Calendar-system noise ──────────────────────────────────────────
  // "Declined: …", "Updated invitation: …", "Accepted: …", emails from
  // calendar-notification@google.com, and any ICS with METHOD=REPLY/CANCEL
  // all short-circuit here. Path 1 below still runs for genuine new invites
  // (METHOD=REQUEST/PUBLISH) — those carry real scheduling info we want.
  const bodyPreview = getBodyPreview(message);
  if (
    isCalendarNoise(headers.from, headers.subject, bodyPreview) ||
    hasNonInviteIcsMethod(message)
  ) {
    return;
  }

  // ── Path 1: Calendar invite detection ─────────────────────────────────────
  const calendarEvent = parseCalendarInvite(message);
  if (calendarEvent) {
    const allEmails = [calendarEvent.organizerEmail, ...calendarEvent.attendeeEmails];
    const matchesLead = allEmails.some(e => e === contactEmail) || allEmails.includes(contactEmail);

    if (matchesLead) {
      const leadId = await findLeadByContactEmail(supabase, contactEmail, member.id);
      if (leadId) {
        // Advance to scheduled and set call time
        const { data: lead } = await supabase
          .from('leads')
          .select('stage')
          .eq('id', leadId)
          .single();

        if (lead && ['replied', 'scheduling'].includes(lead.stage)) {
          await supabase
            .from('leads')
            .update({
              call_scheduled_for: calendarEvent.startTime.toISOString(),
              stage: 'scheduled',
              priority: 'high',
              updated_at: new Date().toISOString(),
            })
            .eq('id', leadId);

          const { error: calErr } = await supabase.from('interactions').insert({
            lead_id: leadId,
            team_member_id: member.id,
            type: 'other',
            subject: `Calendar: ${calendarEvent.summary}`,
            body: `Call scheduled for ${calendarEvent.startTime.toISOString()}`,
            gmail_message_id: message.id,
            occurred_at: calendarEvent.startTime.toISOString(),
            metadata: { auto_stage: true, calendar_event: true },
          });
          // 23505 = unique_violation on gmail_message_id (already processed)
          if (calErr && (calErr as { code?: string }).code !== '23505') {
            result.errors.push(`Calendar interaction insert: ${calErr.message}`);
          }

          // Bug #8 fix — log auto-stage transition to activity_log
          await supabase.from('activity_log').insert({
            lead_id: leadId,
            team_member_id: member.id,
            action: 'auto_stage_changed',
            details: { from: lead.stage, to: 'scheduled', trigger: 'calendar_invite', event_summary: calendarEvent.summary },
          }).then(({ error: logErr }) => { if (logErr) console.error('[sync] Failed to log auto-stage change:', logErr.message); });

          result.calendar_events_detected++;
        }
      }
    }
    // Calendar invites are processed separately — don't fall through to email processing
    return;
  }

  // ── Path 2: Outreach thread (subject pattern match) ───────────────────────
  if (isOutreachThread(headers.subject)) {
    // Strict patterns capture company from "<topic> at <Company>". Loose
    // patterns match the topic phrase alone — for those we derive the company
    // from the prospect's email domain (e.g. rahiman@5centscdn.com → "5centscdn").
    let company = extractCompanyFromSubject(headers.subject);
    if (!company) company = companyFromDomain(contactEmail);
    if (!company) return;

    const contactName = isOutbound ? extractName(headers.to) : extractName(headers.from);
    const occurredAt = message.internalDate
      ? new Date(parseInt(message.internalDate)).toISOString()
      : new Date().toISOString();
    const threadId = message.threadId || undefined;

    let leadId: string | null = null;

    // Check globally — any owner — to prevent duplicates from shared threads
    const { data: existingLead } = await supabase
      .from('leads')
      .select('id, stage, first_reply_at, our_first_response_at, owned_by')
      .eq('company_name', company)
      .eq('is_archived', false)
      .order('updated_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (existingLead) {
      leadId = existingLead.id;

      const updates: Record<string, unknown> = { last_contact_at: occurredAt };
      if (!isOutbound && !existingLead.first_reply_at) {
        updates.first_reply_at = occurredAt;
        if (isForwardStage(existingLead.stage, 'replied')) {
          updates.stage = 'replied';
        }
      }
      if (isOutbound && !existingLead.our_first_response_at && existingLead.first_reply_at) {
        updates.our_first_response_at = occurredAt;
      }

      // Detect scheduling signals in email content to advance stage
      if (['replied', 'scheduling'].includes(existingLead.stage)) {
        try {
          const signal = await classifySchedulingIntent(headers.subject, bodyPreview);
          if (signal === 'booking_confirmed' && isForwardStage(existingLead.stage, 'scheduling')) {
            updates.stage = 'scheduling'; // Calendar sync will advance to 'scheduled' with actual datetime
          } else if (signal === 'scheduling_intent' && isForwardStage(existingLead.stage, 'scheduling')) {
            updates.stage = 'scheduling';
          }
        } catch {
          // Classifier failure should never block email sync
        }
      }

      await supabase.from('leads').update(updates).eq('id', leadId);

      // Log auto-stage transition when email triggers stage change
      if (updates.stage && updates.stage !== existingLead.stage) {
        await supabase.from('activity_log').insert({
          lead_id: leadId,
          team_member_id: member.id,
          action: 'auto_stage_changed',
          details: { from: existingLead.stage, to: updates.stage, trigger: 'email_sync', contact_email: contactEmail },
        }).then(({ error: logErr }) => { if (logErr) console.error('[sync] Failed to log auto-stage change:', logErr.message); });
      }
    } else if (!isOutbound) {
      const { data: newLead, error: createErr } = await supabase
        .from('leads')
        .insert({
          contact_name: normalizeName(contactName || company),
          contact_email: contactEmail,
          company_name: normalizeName(company, true),
          owned_by: member.id,
          sourced_by: member.id,
          stage: 'replied',
          first_reply_at: occurredAt,
          last_contact_at: occurredAt,
          tags: [],
          poc_status: 'not_started',
          heat_score: 50,
          is_archived: false,
        })
        .select('id')
        .single();

      if (!createErr && newLead) {
        leadId = newLead.id;
        result.created_leads++;
      }
    }

    if (!leadId) return;
    await upsertInteraction(supabase, {
      lead_id: leadId,
      team_member_id: isOutbound ? senderMemberId : member.id,
      type: isOutbound ? 'email_outbound' : 'email_inbound',
      subject: headers.subject,
      body: bodyPreview,
      gmail_message_id: message.id ?? undefined,
      gmail_thread_id: threadId,
      rfc_message_id: headers.rfcMessageId || undefined,
      occurred_at: message.internalDate
        ? new Date(parseInt(message.internalDate)).toISOString()
        : new Date().toISOString(),
    }, result);
    await captureThreadParticipants(supabase, leadId, headers, teamEmails, isOutbound ? 'cc' : 'reply');
    return;
  }

  // ── Path 3: Contact-email match (any thread with known contact) ───────────
  // Syncs BOTH inbound AND outbound for threads that don't match outreach pattern
  // but are linked to existing leads via contact_email
  const leadId = await findLeadByContactEmail(supabase, contactEmail, member.id);
  if (!leadId) return;

  const occurredAt = message.internalDate
    ? new Date(parseInt(message.internalDate)).toISOString()
    : new Date().toISOString();
  const threadId = message.threadId || undefined;

  // Update lead timestamps and detect scheduling signals
  const { data: lead } = await supabase
    .from('leads')
    .select('first_reply_at, our_first_response_at, stage')
    .eq('id', leadId)
    .single();

  const updates: Record<string, unknown> = { last_contact_at: occurredAt };

  if (!isOutbound) {
    // Inbound: update first_reply_at and potentially advance stage
    if (lead && !lead.first_reply_at) {
      updates.first_reply_at = occurredAt;
      if (!lead.stage || isForwardStage(lead.stage, 'replied')) {
        updates.stage = 'replied';
      }
    }

    // Detect scheduling signals in inbound emails
    if (lead && ['replied', 'scheduling'].includes(lead.stage)) {
      try {
        const signal = await classifySchedulingIntent(headers.subject, bodyPreview);
        if (signal === 'booking_confirmed' && isForwardStage(lead.stage, 'scheduling')) {
          updates.stage = 'scheduling';
        } else if (signal === 'scheduling_intent' && isForwardStage(lead.stage, 'scheduling')) {
          updates.stage = 'scheduling';
        }
      } catch {
        // Classifier failure should never block email sync
      }
    }
  } else {
    // Outbound: update our_first_response_at if this is our first reply
    if (lead && !lead.our_first_response_at && lead.first_reply_at) {
      updates.our_first_response_at = occurredAt;
    }
  }

  await supabase.from('leads').update(updates).eq('id', leadId);

  // Log auto-stage changes
  if (updates.stage && lead) {
    await supabase.from('activity_log').insert({
      lead_id: leadId,
      team_member_id: member.id,
      action: 'auto_stage_changed',
      details: { from: lead.stage, to: updates.stage, trigger: 'contact_email_match', contact_email: contactEmail },
    }).then(({ error: logErr }) => { if (logErr) console.error('[sync] Failed to log auto-stage change:', logErr.message); });
  }

  await upsertInteraction(supabase, {
    lead_id: leadId,
    team_member_id: isOutbound ? senderMemberId : member.id,
    type: isOutbound ? 'email_outbound' : 'email_inbound',
    subject: headers.subject,
    body: bodyPreview,
    gmail_message_id: message.id ?? undefined,
    gmail_thread_id: threadId,
    rfc_message_id: headers.rfcMessageId || undefined,
    occurred_at: occurredAt,
  }, result);
  await captureThreadParticipants(supabase, leadId, headers, teamEmails, isOutbound ? 'cc' : 'reply');
}

// Walks the From/To/Cc on a synced email and ensures every external (non-
// founder, non-role-based) participant has a row in `lead_contacts` for the
// given lead. This is what powers "search by name finds the lead" when the
// thread picks up new participants over time (forwards, CCs, etc).
async function captureThreadParticipants(
  supabase: ReturnType<typeof import('@/lib/supabase/admin').createAdminClient>,
  leadId: string,
  headers: EmailHeader,
  teamEmails: Map<string, string>,
  source: 'cc' | 'reply' | 'matcher'
): Promise<void> {
  const teamEmailSet = new Set(teamEmails.keys());
  const externals = collectExternalParticipants(headers.from, headers.to, headers.cc, teamEmailSet);
  for (const p of externals) {
    await upsertLeadContact(supabase, {
      leadId,
      email: p.email,
      name: p.name,
      source,
    });
  }
}

async function summarizeEmail(subject: string, body: string): Promise<string | null> {
  if (!body.trim()) return null;
  try {
    return await callAI({
      model: QWEN_FREE_MODEL,
      systemPrompt: 'Summarize this email in one concise sentence (max 120 chars). Plain text, no quotes.',
      userMessage: `Subject: ${subject}\n\n${body.slice(0, 800)}`,
    });
  } catch {
    return null;
  }
}

async function upsertInteraction(
  supabase: ReturnType<typeof import('@/lib/supabase/admin').createAdminClient>,
  data: {
    lead_id: string;
    team_member_id: string;
    type: string;
    subject: string;
    body: string;
    gmail_message_id?: string;
    gmail_thread_id?: string;
    /** RFC 5322 Message-Id header (with angle brackets). Stored inside
     *  metadata so reply composers can use it as the real In-Reply-To
     *  target — the Gmail API's internal id is NOT a valid Message-Id and
     *  making one up (`<apiId@gmail.com>`) breaks threading across accounts. */
    rfc_message_id?: string;
    occurred_at: string;
  },
  result: SyncResult
) {
  // Auto-summarize inbound emails for faster scanning
  let summary: string | null = null;
  if (data.type === 'email_inbound' && data.body) {
    summary = await summarizeEmail(data.subject, data.body);
  }

  const { rfc_message_id, ...row } = data;
  const initialMetadata: Record<string, unknown> = {};
  if (rfc_message_id) initialMetadata.rfc_message_id = rfc_message_id;

  const { data: inserted, error } = await supabase
    .from('interactions')
    .insert({
      ...row,
      summary: summary || undefined,
      metadata: initialMetadata,
    })
    .select('id')
    .single();

  // 23505 = unique_violation on gmail_message_id — expected deduplication
  if (!error || (error as { code?: string }).code === '23505') {
    if (!error) {
      result.synced++;
      if (data.type === 'email_inbound') {
        await cancelQueuedAutoSendForLead(
          data.lead_id,
          'Cancelled: prospect replied before scheduled send',
          supabase,
        );

        // Run AI triage: decides whether this inbound needs a founder reply
        // and extracts any durable product insight. Best-effort — any failure
        // leaves metadata empty, and downstream filters fail-open (so a
        // classifier hiccup never hides a real reply).
        let needsResponse = true;
        try {
          if (inserted?.id) {
            const triage = await runTriageAndPersist(
              supabase,
              inserted.id,
              data.lead_id,
              data.gmail_thread_id,
              data.subject,
              data.body,
            );
            needsResponse = triage.needs_response;
          }
        } catch (triageErr) {
          console.error('[sync] inbound triage failed:', triageErr);
        }

        // Tag the lead owner with a notification-bell mention — only when
        // triage says this inbound actually needs a response. Acks and OOO
        // auto-replies shouldn't light up the bell.
        if (needsResponse) {
          try {
            const { data: lead } = await supabase
              .from('leads')
              .select('owned_by')
              .eq('id', data.lead_id)
              .maybeSingle();
            if (lead?.owned_by) {
              await tagInboundForReview({
                supabase,
                leadId: data.lead_id,
                ownerId: lead.owned_by,
                threadId: data.gmail_thread_id,
                subject: data.subject,
                bodyPreview: data.body,
              });
            }
          } catch (mentionErr) {
            console.error('[sync] inbound mention failed:', mentionErr);
          }
        }
      }
    }
  } else {
    throw new Error(error.message);
  }
}

/**
 * Fetch thread context + lead, run triage, persist to interactions.metadata,
 * and append any extracted knowledge snippet. Returns the triage result so
 * the caller can decide whether to fire the mention notification.
 */
async function runTriageAndPersist(
  supabase: ReturnType<typeof import('@/lib/supabase/admin').createAdminClient>,
  interactionId: string,
  leadId: string,
  threadId: string | undefined,
  subject: string,
  body: string,
): Promise<{ needs_response: boolean }> {
  // Most-recent outbound on this thread, if any — gives the classifier
  // context for "did we ask a question that this reply answers?"
  let priorOutbound: string | null = null;
  if (threadId) {
    const { data: prior } = await supabase
      .from('interactions')
      .select('body')
      .eq('gmail_thread_id', threadId)
      .eq('type', 'email_outbound')
      .order('occurred_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    priorOutbound = prior?.body ?? null;
  }

  const { data: lead } = await supabase
    .from('leads')
    .select('stage, contact_name, company_name')
    .eq('id', leadId)
    .maybeSingle();

  const triage = await triageInboundEmail({
    inboundSubject: subject,
    inboundBody: body,
    priorOutboundBody: priorOutbound,
    leadStage: lead?.stage ?? null,
    contactName: lead?.contact_name ?? null,
    companyName: lead?.company_name ?? null,
  });

  // Merge into existing metadata so we don't trash the rfc_message_id that
  // the initial insert stored. Read-modify-write within a single sync run is
  // race-safe — no other writer mutates this row in the same window.
  const { data: existingRow } = await supabase
    .from('interactions')
    .select('metadata')
    .eq('id', interactionId)
    .maybeSingle();

  const merged = {
    ...((existingRow?.metadata as Record<string, unknown> | null) ?? {}),
    triage: {
      needs_response: triage.needs_response,
      reason: triage.reason,
      brief: triage.brief,
    },
  };

  await supabase
    .from('interactions')
    .update({ metadata: merged })
    .eq('id', interactionId);

  if (triage.knowledge) {
    const when = new Date().toISOString().slice(0, 10);
    const who = [lead?.contact_name, lead?.company_name].filter(Boolean).join(' @ ') || 'email';
    const snippet = `\n---\n### ${when} — ${who} (inbox)\n- ${triage.knowledge.snippet}\n`;
    try {
      await supabase.rpc('append_knowledge_doc', {
        p_doc_type: triage.knowledge.type,
        p_content: snippet,
      });
    } catch (kErr) {
      console.error('[sync] knowledge append failed:', kErr);
    }
  }

  return { needs_response: triage.needs_response };
}
