import { createAdminClient } from '@/lib/supabase/admin';
import { sendReplyInThread } from '@/lib/gmail/send';

const FOLLOWUP_HOURS = 48;

const FOLLOWUP_TEMPLATE = `Hi,

Just following up on my last message — wanted to see if you had a chance to think about this.

Happy to jump on a quick call if that's easier. What does your schedule look like this week?

Best,`;

export interface AutoFollowupResult {
  processed: number;
  sent: number;
  errors: string[];
}

export async function runAutoFollowup(): Promise<AutoFollowupResult> {
  const result: AutoFollowupResult = { processed: 0, sent: 0, errors: [] };
  const supabase = createAdminClient();

  const cutoff = new Date(Date.now() - FOLLOWUP_HOURS * 60 * 60 * 1000).toISOString();

  // Find leads in 'scheduling' stage with a pending auto_send follow-up
  const { data: queueItems, error } = await supabase
    .from('follow_up_queue')
    .select('id, lead_id, assigned_to, gmail_thread_id, message_template, scheduled_for')
    .eq('type', 'auto_send')
    .eq('status', 'pending')
    .lte('scheduled_for', new Date().toISOString())
    .not('gmail_thread_id', 'is', null)
    .not('assigned_to', 'is', null);

  if (error) {
    result.errors.push(`Queue fetch error: ${error.message}`);
    return result;
  }

  if (!queueItems || queueItems.length === 0) return result;

  for (const item of queueItems) {
    result.processed++;

    try {
      // Verify lead is in scheduling stage
      const { data: lead } = await supabase
        .from('leads')
        .select('id, stage, contact_email, contact_name, company_name, owned_by')
        .eq('id', item.lead_id)
        .single();

      if (!lead || lead.stage !== 'scheduling') continue;

      // Verify no outbound email in last 48h
      const { data: recentOutbound } = await supabase
        .from('interactions')
        .select('id')
        .eq('lead_id', item.lead_id)
        .eq('type', 'email_outbound')
        .gte('occurred_at', cutoff)
        .limit(1)
        .maybeSingle();

      if (recentOutbound) continue;

      // Verify the assigned member has Gmail connected
      const { data: member } = await supabase
        .from('team_members')
        .select('id, name, email, gmail_connected')
        .eq('id', item.assigned_to)
        .single();

      if (!member?.gmail_connected) continue;

      const messageBody = item.message_template || `${FOLLOWUP_TEMPLATE}\n${member.name}`;

      // Fetch last inbound message ID for In-Reply-To threading header
      // Note: gmail_message_id is the Gmail API ID, not the RFC 2822 Message-ID header.
      // We wrap it as a best-effort fallback: <id@gmail.com>
      const { data: lastInbound } = await supabase
        .from('interactions')
        .select('gmail_message_id')
        .eq('lead_id', item.lead_id)
        .eq('type', 'email_inbound')
        .order('occurred_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      const inReplyToMessageId = lastInbound?.gmail_message_id
        ? `${lastInbound.gmail_message_id}@gmail.com`
        : undefined;

      // Send reply in thread
      const sentMessageId = await sendReplyInThread({
        teamMemberId: member.id,
        threadId: item.gmail_thread_id,
        to: lead.contact_email,
        subject: `product prioritization at ${lead.company_name}`,
        body: messageBody,
        inReplyToMessageId,
      });

      const now = new Date().toISOString();

      // Mark queue item as sent
      await supabase
        .from('follow_up_queue')
        .update({ status: 'sent', sent_at: now })
        .eq('id', item.id);

      // Log the interaction
      await supabase.from('interactions').insert({
        lead_id: item.lead_id,
        team_member_id: member.id,
        type: 'email_outbound',
        direction: 'outbound',
        subject: `product prioritization at ${lead.company_name}`,
        body: messageBody.slice(0, 500),
        gmail_message_id: sentMessageId || undefined,
        gmail_thread_id: item.gmail_thread_id,
        occurred_at: now,
        metadata: { auto_followup: true },
      });

      // Update lead last_contact_at
      await supabase
        .from('leads')
        .update({ last_contact_at: now })
        .eq('id', item.lead_id);

      result.sent++;
    } catch (err) {
      result.errors.push(
        `Item ${item.id}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  return result;
}

export async function enqueueAutoFollowups(): Promise<void> {
  const supabase = createAdminClient();

  const cutoff48h = new Date(Date.now() - FOLLOWUP_HOURS * 60 * 60 * 1000).toISOString();

  // Find scheduling leads whose last inbound was > 48h ago and no auto-send is pending
  const { data: leads } = await supabase
    .from('leads')
    .select('id, contact_name, company_name, contact_email, owned_by')
    .eq('stage', 'scheduling')
    .eq('is_archived', false)
    .not('owned_by', 'is', null);

  if (!leads) return;

  for (const lead of leads) {
    // Check last inbound email
    const { data: lastInbound } = await supabase
      .from('interactions')
      .select('id, occurred_at, gmail_thread_id, gmail_message_id')
      .eq('lead_id', lead.id)
      .eq('type', 'email_inbound')
      .order('occurred_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!lastInbound) continue;
    if (new Date(lastInbound.occurred_at) > new Date(cutoff48h)) continue;
    if (!lastInbound.gmail_thread_id) continue;

    // Check no outbound in last 48h
    const { data: recentOutbound } = await supabase
      .from('interactions')
      .select('id')
      .eq('lead_id', lead.id)
      .eq('type', 'email_outbound')
      .gte('occurred_at', cutoff48h)
      .limit(1)
      .maybeSingle();

    if (recentOutbound) continue;

    // Check member has Gmail
    const { data: member } = await supabase
      .from('team_members')
      .select('id, name, gmail_connected')
      .eq('id', lead.owned_by)
      .single();

    if (!member?.gmail_connected) continue;

    // Check no pending auto_send in queue
    const { data: existing } = await supabase
      .from('follow_up_queue')
      .select('id')
      .eq('lead_id', lead.id)
      .eq('type', 'auto_send')
      .eq('status', 'pending')
      .maybeSingle();

    if (existing) continue;

    // Enqueue
    await supabase.from('follow_up_queue').insert({
      lead_id: lead.id,
      assigned_to: lead.owned_by,
      type: 'auto_send',
      status: 'pending',
      scheduled_for: new Date().toISOString(),
      gmail_thread_id: lastInbound.gmail_thread_id,
      message_template: `${FOLLOWUP_TEMPLATE}\n${member.name}`,
    });
  }
}
