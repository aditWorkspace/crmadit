import type { gmail_v1 } from 'googleapis';
import { getGmailClientForMember } from './client';
import { isOutreachThread, extractCompanyFromSubject, isBounceEmail } from './matcher';
import { parseCalendarInvite } from './calendar-parser';
import { createAdminClient } from '@/lib/supabase/admin';
import { syncCalendarLeads } from '@/lib/google/calendar-sync';
import { callAI } from '@/lib/ai/openrouter';
import { QWEN_FREE_MODEL, STAGE_ORDER } from '@/lib/constants';
import { classifySchedulingIntent } from './scheduling-classifier';
import { normalizeName } from '@/lib/name-utils';

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
  subject: string;
  date: string;
}

function parseHeaders(headers: Array<{ name?: string | null; value?: string | null }>): EmailHeader {
  const get = (name: string) =>
    headers.find(h => h.name?.toLowerCase() === name.toLowerCase())?.value || '';
  return {
    from: get('From'),
    to: get('To'),
    subject: get('Subject'),
    date: get('Date'),
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

export async function runInitialSync(teamMemberId: string): Promise<SyncResult> {
  const start = Date.now();
  const result: SyncResult = { synced: 0, created_leads: 0, errors: [], duration_ms: 0, calendar_events_detected: 0, calendar_leads_created: 0, calendar_leads_updated: 0 };

  const { gmail } = await getGmailClientForMember(teamMemberId);
  const supabase = createAdminClient();

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

  const threadIds = new Set<string>();
  let pageToken: string | undefined;

  do {
    const listRes = await gmail.users.messages.list({
      userId: 'me',
      q: 'subject:"product prioritization at" newer_than:30d -from:me',
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
          await processMessage(supabase, message, gmailEmail, member, result);
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
      { team_member_id: teamMemberId, last_sync_at: new Date().toISOString(), history_id: historyId, total_synced: result.synced, updated_at: new Date().toISOString() },
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
    } catch (err) {
      if (String(err).includes('404') || String(err).includes('Invalid startHistoryId')) {
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
          await processMessage(supabase, msgRes.data, gmailEmail, member, result);
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
  result: SyncResult
) {
  const headers = parseHeaders(message.payload?.headers || []);
  const fromEmail = extractEmail(headers.from);
  const toEmail = extractEmail(headers.to);
  const isOutbound = fromEmail === gmailEmail;
  const contactEmail = isOutbound ? toEmail : fromEmail;

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
        }).then(() => {});
      }
    }
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

          result.calendar_events_detected++;
        }
      }
    }
    // Calendar invites are processed separately — don't fall through to email processing
    return;
  }

  // ── Path 2: Outreach thread (subject pattern match) ───────────────────────
  if (isOutreachThread(headers.subject)) {
    const company = extractCompanyFromSubject(headers.subject);
    if (!company) return;

    const contactName = isOutbound ? extractName(headers.to) : extractName(headers.from);
    const occurredAt = message.internalDate
      ? new Date(parseInt(message.internalDate)).toISOString()
      : new Date().toISOString();
    const bodyPreview = getBodyPreview(message);
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
      team_member_id: member.id,
      type: isOutbound ? 'email_outbound' : 'email_inbound',
      subject: headers.subject,
      body: bodyPreview,
      gmail_message_id: message.id ?? undefined,
      gmail_thread_id: threadId,
      occurred_at: message.internalDate
        ? new Date(parseInt(message.internalDate)).toISOString()
        : new Date().toISOString(),
    }, result);
    return;
  }

  // ── Path 3: Contact-email match (manually-added leads) ───────────────────
  // Only link inbound emails — outbound from us doesn't need linkage here
  if (!isOutbound) {
    const leadId = await findLeadByContactEmail(supabase, contactEmail, member.id);
    if (!leadId) return;

    const occurredAt = message.internalDate
      ? new Date(parseInt(message.internalDate)).toISOString()
      : new Date().toISOString();
    const bodyPreview = getBodyPreview(message);
    const threadId = message.threadId || undefined;

    // Update lead last_contact_at, first_reply_at, and detect scheduling signals
    const { data: lead } = await supabase
      .from('leads')
      .select('first_reply_at, stage')
      .eq('id', leadId)
      .single();

    const updates: Record<string, unknown> = { last_contact_at: occurredAt };
    if (lead && !lead.first_reply_at) {
      updates.first_reply_at = occurredAt;
      if (!lead.stage || isForwardStage(lead.stage, 'replied')) {
        updates.stage = 'replied';
      }
    }

    // Detect scheduling signals to advance stage
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

    await supabase.from('leads').update(updates).eq('id', leadId);

    await upsertInteraction(supabase, {
      lead_id: leadId,
      team_member_id: member.id,
      type: 'email_inbound',
      subject: headers.subject,
      body: bodyPreview,
      gmail_message_id: message.id ?? undefined,
      gmail_thread_id: threadId,
      occurred_at: occurredAt,
    }, result);
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
    occurred_at: string;
  },
  result: SyncResult
) {
  // Auto-summarize inbound emails for faster scanning
  let summary: string | null = null;
  if (data.type === 'email_inbound' && data.body) {
    summary = await summarizeEmail(data.subject, data.body);
  }

  const { error } = await supabase.from('interactions').insert({
    ...data,
    summary: summary || undefined,
    metadata: {},
  });

  // 23505 = unique_violation on gmail_message_id — expected deduplication
  if (!error || (error as { code?: string }).code === '23505') {
    if (!error) result.synced++;
  } else {
    throw new Error(error.message);
  }
}
