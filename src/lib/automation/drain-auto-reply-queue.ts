/**
 * Auto-Reply Queue Drainer
 *
 * Processes queued auto-replies after the 30-60 min delay.
 * Critical safety check: re-verifies no human replied in the delay window.
 */

import { createAdminClient } from '@/lib/supabase/admin';
import { sendReplyInThread } from '@/lib/gmail/send';
import { changeStage } from '@/lib/automation/stage-logic';
import { isWithinSendingWindow } from './send-guards';
import { autoReplyEnabled } from './kill-switch';

const MAX_PER_RUN = 20;

export interface DrainResult {
  processed: number;
  sent: number;
  cancelled: number;
  failed: number;
  errors: string[];
}

export async function drainAutoReplyQueue(): Promise<DrainResult> {
  const result: DrainResult = {
    processed: 0,
    sent: 0,
    cancelled: 0,
    failed: 0,
    errors: [],
  };

  // Global kill switch
  if (!autoReplyEnabled()) return result;

  // Only drain during business hours
  if (!isWithinSendingWindow()) return result;

  const supabase = createAdminClient();
  const now = new Date().toISOString();

  // Find pending entries that are due for processing
  const { data: due, error: queryError } = await supabase
    .from('auto_reply_queue')
    .select('*')
    .eq('status', 'pending')
    .lte('process_at', now)
    .order('process_at', { ascending: true })
    .limit(MAX_PER_RUN);

  if (queryError) {
    result.errors.push(`query failed: ${queryError.message}`);
    return result;
  }

  if (!due || due.length === 0) return result;

  for (const entry of due) {
    result.processed++;

    try {
      // Mark as processing to prevent concurrent runs
      const { data: locked, error: lockError } = await supabase
        .from('auto_reply_queue')
        .update({ status: 'processing' })
        .eq('id', entry.id)
        .eq('status', 'pending')
        .select('id');

      if (lockError || !locked || locked.length === 0) {
        continue; // Another worker got it
      }

      // ═══════════════════════════════════════════════════════════════════════
      // CRITICAL: Re-check if a human replied in the delay window
      // ═══════════════════════════════════════════════════════════════════════
      const queuedAt = new Date(entry.created_at).getTime();

      const { data: humanReply } = await supabase
        .from('interactions')
        .select('id, type, metadata')
        .eq('lead_id', entry.lead_id)
        .eq('type', 'email_outbound')
        .gt('occurred_at', entry.created_at)
        .limit(5);

      const hasHumanReply = humanReply?.some(i => {
        const meta = i.metadata as { first_reply_auto?: boolean; auto_followup?: boolean } | null;
        const isAuto = meta?.first_reply_auto || meta?.auto_followup;
        return !isAuto; // Human if NOT auto
      });

      if (hasHumanReply) {
        await supabase.from('auto_reply_queue').update({
          status: 'skipped',
          skip_reason: 'human_replied_in_window',
          processed_at: now,
        }).eq('id', entry.id);
        result.cancelled++;
        continue;
      }

      // Also check if lead is no longer in 'replied' stage (human may have advanced it)
      const { data: lead } = await supabase
        .from('leads')
        .select('stage, contact_email, company_name')
        .eq('id', entry.lead_id)
        .single();

      if (!lead) {
        await supabase.from('auto_reply_queue').update({
          status: 'failed',
          skip_reason: 'lead_not_found',
          processed_at: now,
        }).eq('id', entry.id);
        result.failed++;
        continue;
      }

      if (lead.stage !== 'replied') {
        await supabase.from('auto_reply_queue').update({
          status: 'skipped',
          skip_reason: `stage_changed_to_${lead.stage}`,
          processed_at: now,
        }).eq('id', entry.id);
        result.cancelled++;
        continue;
      }

      if (!lead.contact_email) {
        await supabase.from('auto_reply_queue').update({
          status: 'failed',
          skip_reason: 'no_contact_email',
          processed_at: now,
        }).eq('id', entry.id);
        result.failed++;
        continue;
      }

      // Verify owner still has Gmail connected
      const { data: owner } = await supabase
        .from('team_members')
        .select('id, name, gmail_connected')
        .eq('id', entry.owner_id)
        .single();

      if (!owner?.gmail_connected) {
        await supabase.from('auto_reply_queue').update({
          status: 'failed',
          skip_reason: 'owner_gmail_disconnected',
          processed_at: now,
        }).eq('id', entry.id);
        result.failed++;
        continue;
      }

      // Get thread subject + RFC Message-Id for proper threading
      const { data: lastInt } = await supabase
        .from('interactions')
        .select('subject, metadata')
        .eq('lead_id', entry.lead_id)
        .eq('type', 'email_inbound')
        .order('occurred_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      const originalSubject = lastInt?.subject || `product prioritization at ${lead.company_name}`;
      const threadSubject = originalSubject.startsWith('Re:') ? originalSubject : `Re: ${originalSubject}`;
      const rfcMessageId = (lastInt?.metadata as { rfc_message_id?: string } | null)?.rfc_message_id;

      // ═══════════════════════════════════════════════════════════════════════
      // SEND THE EMAIL
      // ═══════════════════════════════════════════════════════════════════════
      const sentMessageId = await sendReplyInThread({
        teamMemberId: owner.id,
        threadId: entry.gmail_thread_id,
        to: lead.contact_email,
        subject: threadSubject,
        body: entry.final_message,
        rfcMessageId,
      });

      const sentAt = new Date().toISOString();

      // Log the interaction
      await supabase.from('interactions').insert({
        lead_id: entry.lead_id,
        team_member_id: owner.id,
        type: 'email_outbound',
        subject: threadSubject,
        body: entry.final_message,
        gmail_message_id: sentMessageId || undefined,
        gmail_thread_id: entry.gmail_thread_id,
        occurred_at: sentAt,
        metadata: {
          first_reply_auto: true,
          auto_reply_queue_id: entry.id,
          classifier_result: entry.classifier_result,
          categories_addressed: entry.writer_result?.categories_addressed,
        },
      });

      // Update lead's last_contact_at
      await supabase.from('leads').update({ last_contact_at: sentAt }).eq('id', entry.lead_id);

      // Advance to scheduling if positive category
      const classifierResult = entry.classifier_result as { primary_category?: string } | null;
      const isPositive = classifierResult?.primary_category?.startsWith('positive');
      if (isPositive) {
        await changeStage(entry.lead_id, 'scheduling', owner.id);
      }

      // Mark queue entry as sent
      await supabase.from('auto_reply_queue').update({
        status: 'sent',
        processed_at: sentAt,
      }).eq('id', entry.id);

      // Also log to follow_up_queue for audit trail
      await supabase.from('follow_up_queue').insert({
        lead_id: entry.lead_id,
        assigned_to: entry.owner_id,
        type: 'first_reply_auto',
        status: 'sent',
        due_at: sentAt,
        sent_at: sentAt,
        suggested_message: entry.final_message,
        reason: `auto_reply: ${classifierResult?.primary_category || 'unknown'}`,
        gmail_thread_id: entry.gmail_thread_id,
      });

      result.sent++;

    } catch (err) {
      await supabase.from('auto_reply_queue').update({
        status: 'failed',
        skip_reason: `error: ${err instanceof Error ? err.message : String(err)}`,
        processed_at: now,
      }).eq('id', entry.id);
      result.failed++;
      result.errors.push(`entry ${entry.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return result;
}
