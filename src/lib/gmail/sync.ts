import { getGmailClientForMember } from './client';
import { isOutreachThread, extractCompanyFromSubject } from './matcher';
import { createAdminClient } from '@/lib/supabase/admin';

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

function getBodyPreview(message: {
  payload?: {
    body?: { data?: string | null } | null;
    parts?: Array<{ mimeType?: string | null; body?: { data?: string | null } | null }> | null;
  } | null;
}): string {
  const payload = message.payload;
  if (!payload) return '';

  let data: string | null | undefined = null;

  if (payload.body?.data) {
    data = payload.body.data;
  } else if (payload.parts) {
    const textPart = payload.parts.find(p => p.mimeType === 'text/plain');
    data = textPart?.body?.data;
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
}

export async function runInitialSync(teamMemberId: string): Promise<SyncResult> {
  const start = Date.now();
  const result: SyncResult = { synced: 0, created_leads: 0, errors: [], duration_ms: 0 };

  const { gmail } = await getGmailClientForMember(teamMemberId);
  const supabase = createAdminClient();

  // Get team member email for direction detection
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

  let pageToken: string | undefined;

  do {
    const listRes = await gmail.users.messages.list({
      userId: 'me',
      q: 'subject:"product prioritization at" newer_than:60d',
      maxResults: 100,
      pageToken,
    });

    const messages = listRes.data.messages || [];
    pageToken = listRes.data.nextPageToken || undefined;

    for (const msg of messages) {
      if (!msg.id) continue;
      try {
        await processMessage(gmail, supabase, msg.id, member, result);
      } catch (err) {
        result.errors.push(`Message ${msg.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  } while (pageToken);

  // Store latest history ID for incremental sync
  const profileRes = await gmail.users.getProfile({ userId: 'me' });
  const historyId = profileRes.data.historyId;

  await supabase
    .from('team_members')
    .update({
      gmail_history_id: historyId,
      last_gmail_sync: new Date().toISOString(),
    })
    .eq('id', teamMemberId);

  await supabase
    .from('email_sync_state')
    .upsert(
      {
        team_member_id: teamMemberId,
        last_sync_at: new Date().toISOString(),
        history_id: historyId,
        total_synced: result.synced,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'team_member_id' }
    );

  result.duration_ms = Date.now() - start;
  return result;
}

export async function runIncrementalSync(teamMemberId: string): Promise<SyncResult> {
  const start = Date.now();
  const result: SyncResult = { synced: 0, created_leads: 0, errors: [], duration_ms: 0 };

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

  if (!member.gmail_history_id) {
    // No history id yet — do full initial sync
    return runInitialSync(teamMemberId);
  }

  const { gmail } = await getGmailClientForMember(teamMemberId);

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
      // History ID expired — fall back to initial sync
      if (String(err).includes('404') || String(err).includes('Invalid startHistoryId')) {
        return runInitialSync(teamMemberId);
      }
      throw err;
    }

    const historyList = historyRes.data.history || [];
    pageToken = historyRes.data.nextPageToken || undefined;

    for (const historyItem of historyList) {
      const added = historyItem.messagesAdded || [];
      for (const { message } of added) {
        if (!message?.id || processedMessageIds.has(message.id)) continue;
        processedMessageIds.add(message.id);

        try {
          await processMessage(gmail, supabase, message.id, member, result);
        } catch (err) {
          result.errors.push(`Message ${message.id}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }

    // Update history ID to latest
    if (historyRes.data.historyId) {
      await supabase
        .from('team_members')
        .update({
          gmail_history_id: historyRes.data.historyId,
          last_gmail_sync: new Date().toISOString(),
        })
        .eq('id', teamMemberId);

      await supabase
        .from('email_sync_state')
        .upsert(
          {
            team_member_id: teamMemberId,
            last_sync_at: new Date().toISOString(),
            history_id: historyRes.data.historyId,
            updated_at: new Date().toISOString(),
          },
          { onConflict: 'team_member_id' }
        );
    }
  } while (pageToken);

  result.duration_ms = Date.now() - start;
  return result;
}

async function processMessage(
  gmail: ReturnType<typeof import('googleapis').google.gmail>,
  supabase: ReturnType<typeof import('@/lib/supabase/admin').createAdminClient>,
  messageId: string,
  member: { id: string; email: string; name: string },
  result: SyncResult
) {
  const msgRes = await gmail.users.messages.get({
    userId: 'me',
    id: messageId,
    format: 'full',
  });

  const message = msgRes.data;
  const headers = parseHeaders(message.payload?.headers || []);

  if (!isOutreachThread(headers.subject)) return;

  const company = extractCompanyFromSubject(headers.subject);
  if (!company) return;

  const fromEmail = extractEmail(headers.from);
  const fromName = extractName(headers.from);
  const toEmail = extractEmail(headers.to);

  const isOutbound = fromEmail === member.email.toLowerCase();
  const direction = isOutbound ? 'outbound' : 'inbound';

  const contactEmail = isOutbound ? toEmail : fromEmail;
  const contactName = isOutbound ? extractName(headers.to) : fromName;

  const occurredAt = message.internalDate
    ? new Date(parseInt(message.internalDate)).toISOString()
    : new Date().toISOString();

  const bodyPreview = getBodyPreview(message);
  const threadId = message.threadId || undefined;

  // Find or create lead
  let leadId: string | null = null;

  const { data: existingLead } = await supabase
    .from('leads')
    .select('id, stage, first_reply_at, our_first_response_at')
    .eq('company_name', company)
    .eq('owned_by', member.id)
    .eq('is_archived', false)
    .limit(1)
    .maybeSingle();

  if (existingLead) {
    leadId = existingLead.id;

    // Update stage inference
    const updates: Record<string, string> = {};
    if (!isOutbound && !existingLead.first_reply_at) {
      updates.first_reply_at = occurredAt;
      updates.stage = 'replied';
    }
    if (isOutbound && !existingLead.our_first_response_at && existingLead.first_reply_at) {
      updates.our_first_response_at = occurredAt;
    }
    updates.last_contact_at = occurredAt;

    if (Object.keys(updates).length > 0) {
      await supabase.from('leads').update(updates).eq('id', leadId);
    }
  } else if (!isOutbound) {
    // Auto-create lead from inbound email
    const { data: newLead, error: createErr } = await supabase
      .from('leads')
      .insert({
        contact_name: contactName || company,
        contact_email: contactEmail,
        company_name: company,
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

  // Determine interaction type
  const interactionType = isOutbound ? 'email_outbound' : 'email_inbound';

  // Upsert interaction — ON CONFLICT DO NOTHING via the unique index
  const { error: interactionErr } = await supabase.from('interactions').insert({
    lead_id: leadId,
    team_member_id: member.id,
    type: interactionType,
    direction,
    subject: headers.subject,
    body: bodyPreview,
    gmail_message_id: messageId,
    gmail_thread_id: threadId,
    occurred_at: occurredAt,
    metadata: {},
  });

  // Error code 23505 = unique_violation — expected when deduplicating
  if (!interactionErr || (interactionErr as { code?: string }).code === '23505') {
    if (!interactionErr) result.synced++;
  } else {
    throw new Error(interactionErr.message);
  }
}
