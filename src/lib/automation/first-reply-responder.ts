import { createAdminClient } from '@/lib/supabase/admin';
import { sendReplyInThread } from '@/lib/gmail/send';
import { classifySchedulingIntent } from '@/lib/gmail/scheduling-classifier';
import { classifyFirstReply } from '@/lib/ai/first-reply-classifier';
import {
  writePositiveBookReply,
  writeAsyncRequestReply,
  writeInfoRequestReply,
  writeFastLoopFollowup,
  type BaseWriteOpts,
} from '@/lib/ai/first-reply-writer';
import { pickRelevantQa } from '@/lib/ai/qa-bank';
import { changeStage } from '@/lib/automation/stage-logic';
import { BOOKING_URL } from '@/lib/constants';
import type { FirstReplyDecision, FirstReplyCategory } from '@/lib/validation';
import { isWithinSendingWindow, hasMinimumGap } from './send-guards';
import { formatEmailBody } from '@/lib/format/email-body';
import { scheduleFastLoopFollowup } from './fast-loop';
import { autoReplyEnabled, infoReplyEnabled } from './kill-switch';

// Cap how many leads we process per cron run. At 3-user scale this is
// effectively unbounded but it bounds the worst case if something pathological
// happens (e.g. a backlog after a cron outage).
const MAX_LEADS_PER_RUN = 25;

// Any inbound older than this is almost certainly not a "first reply we're
// still fresh enough to auto-respond to". Prevents awkward auto-responses to
// weeks-old replies that for whatever reason never got the flag flipped.
// Inbounds older than this are pushed to manual_review (NEEDS_FOUNDER) so
// they surface on the dashboard instead of being silently dropped.
const MAX_INBOUND_AGE_HOURS = 168; // 7 days

export interface FirstReplyResult {
  processed: number;
  sent: number;
  manual_review: number;
  rolled_back: number;
  skipped: number;
  errors: string[];
  details?: ProcessDetail[];
}

export interface ProcessDetail {
  lead_id: string;
  category: FirstReplyCategory | 'skipped';
  reason: string;
  action: 'sent' | 'manual_review' | 'rolled_back' | 'skipped' | 'scheduled' | 'declined';
  message_preview?: string;
}

export interface RunOptions {
  // When true, skip all side effects: no lock UPDATE, no Gmail send,
  // no stage change, no follow_up_queue writes. Only reads + classification.
  // Returns classification details for inspection.
  dryRun?: boolean;
}

function firstNameOf(fullName: string | null | undefined): string {
  if (!fullName) return 'Adit';
  const trimmed = fullName.trim();
  if (!trimmed) return 'Adit';
  return trimmed.split(/\s+/)[0];
}

function buildBookingUrl(_contactEmail: string): string {
  return BOOKING_URL;
}

function buildThreadContext(
  interactions: Array<{ type: string; body: string | null }>,
  contactName: string
): string {
  return interactions
    .slice(0, 6)
    .map(i => {
      const role = i.type === 'email_inbound' ? contactName : 'Us';
      return `[${role}]: ${(i.body || '').slice(0, 300)}`;
    })
    .join('\n\n');
}

export async function runFirstReplyAutoResponder(
  opts: RunOptions = {}
): Promise<FirstReplyResult> {
  const { dryRun = false } = opts;
  const result: FirstReplyResult = {
    processed: 0,
    sent: 0,
    manual_review: 0,
    rolled_back: 0,
    skipped: 0,
    errors: [],
    details: dryRun ? [] : undefined,
  };

  // Guard: only send during business hours (9 AM – 6 PM PT, weekdays).
  // Manual reviews still get created, but no emails go out at 2 AM.
  if (!dryRun && !isWithinSendingWindow()) {
    return result;
  }

  const supabase = createAdminClient();

  // Phase 1: Find candidates. The partial index on (stage, auto_replied_to_first,
  // is_archived) makes this cheap.
  const { data: leads, error: leadsError } = await supabase
    .from('leads')
    .select('id, contact_name, contact_email, contact_role, company_name, owned_by, stage')
    .eq('stage', 'replied')
    .eq('auto_replied_to_first', false)
    .eq('is_archived', false)
    .not('owned_by', 'is', null)
    .not('contact_email', 'is', null)
    .limit(MAX_LEADS_PER_RUN);

  if (leadsError) {
    result.errors.push(`leads query failed: ${leadsError.message}`);
    return result;
  }
  if (!leads || leads.length === 0) return result;

  for (const lead of leads) {
    result.processed++;

    try {
      // Phase 2: Atomic compare-and-set lock. Any concurrent cron run that got
      // here first flips the flag before we do, and our UPDATE returns 0 rows.
      // dry-run skips the lock entirely so repeated local runs don't mutate state.
      if (!dryRun) {
        const { data: locked, error: lockError } = await supabase
          .from('leads')
          .update({ auto_replied_to_first: true })
          .eq('id', lead.id)
          .eq('auto_replied_to_first', false)
          .select('id');
        if (lockError) {
          result.errors.push(`lock failed for ${lead.id}: ${lockError.message}`);
          result.skipped++;
          continue;
        }
        if (!locked || locked.length === 0) {
          // Another cron got here first.
          result.skipped++;
          continue;
        }
      }

      // Phase 3: Fetch recent thread context.
      const { data: recentInteractions, error: intError } = await supabase
        .from('interactions')
        .select('id, type, subject, body, gmail_message_id, gmail_thread_id, metadata, occurred_at')
        .eq('lead_id', lead.id)
        .in('type', ['email_inbound', 'email_outbound'])
        .order('occurred_at', { ascending: false })
        .limit(10);

      if (intError || !recentInteractions || recentInteractions.length === 0) {
        await rollbackLock(supabase, lead.id, dryRun);
        result.skipped++;
        recordDetail(result, lead.id, 'skipped', 'no thread history', 'skipped');
        continue;
      }

      const lastInteraction = recentInteractions[0];

      // Expect the latest interaction to be an inbound email. If not, the
      // picker state is weird (maybe a manual reply snuck in), skip.
      if (lastInteraction.type !== 'email_inbound') {
        await rollbackLock(supabase, lead.id, dryRun);
        result.skipped++;
        recordDetail(
          result,
          lead.id,
          'skipped',
          `last interaction was ${lastInteraction.type}, expected email_inbound`,
          'skipped'
        );
        continue;
      }

      const inboundAgeHours =
        (Date.now() - new Date(lastInteraction.occurred_at).getTime()) / (1000 * 60 * 60);
      if (inboundAgeHours > MAX_INBOUND_AGE_HOURS) {
        // Don't auto-reply (too stale to feel natural), but DO surface for the
        // founder. Keep the lock set so we don't re-create manual reviews on
        // every cron run. The dashboard's NEEDS_FOUNDER strip picks this up.
        if (!dryRun && lastInteraction.gmail_thread_id) {
          await createManualReview(supabase, {
            leadId: lead.id,
            ownedBy: lead.owned_by,
            threadId: lastInteraction.gmail_thread_id,
            category: 'unclear',
            reason: `inbound_too_old_${Math.round(inboundAgeHours)}h`,
            needsFounder: true,
          });
        }
        result.manual_review++;
        recordDetail(
          result,
          lead.id,
          'unclear',
          `inbound too old (${Math.round(inboundAgeHours)}h) — surfaced for founder`,
          'manual_review'
        );
        continue;
      }

      const threadId = lastInteraction.gmail_thread_id;
      if (!threadId) {
        await rollbackLock(supabase, lead.id, dryRun);
        result.skipped++;
        recordDetail(result, lead.id, 'skipped', 'missing gmail_thread_id', 'skipped');
        continue;
      }

      // Phase 4: Fetch owner (for Gmail send + sender first name).
      const { data: owner } = await supabase
        .from('team_members')
        .select('id, name, email, gmail_connected')
        .eq('id', lead.owned_by)
        .single();

      if (!owner) {
        await rollbackLock(supabase, lead.id, dryRun);
        result.skipped++;
        recordDetail(result, lead.id, 'skipped', 'owner not found', 'skipped');
        continue;
      }
      if (!owner.gmail_connected) {
        // Owner has no Gmail — create a manual review entry so someone surfaces it.
        await rollbackLock(supabase, lead.id, dryRun);
        if (!dryRun) {
          await createManualReview(supabase, {
            leadId: lead.id,
            ownedBy: lead.owned_by,
            threadId,
            category: 'unclear',
            reason: 'owner_gmail_disconnected',
          });
        }
        result.manual_review++;
        recordDetail(result, lead.id, 'unclear', 'owner_gmail_disconnected', 'manual_review');
        continue;
      }

      // Phase 5: Short-circuit Calendly/SavvyCal/Cal.com via existing regex
      const schedSignal = await classifySchedulingIntent(
        lastInteraction.subject || '',
        lastInteraction.body || ''
      );

      const writeOpts: BaseWriteOpts = {
        contactName: lead.contact_name,
        contactRole: lead.contact_role,
        companyName: lead.company_name,
        senderFirstName: firstNameOf(owner.name),
        bookingUrl: buildBookingUrl(lead.contact_email),
        latestInboundBody: lastInteraction.body || '',
        threadContext: buildThreadContext(
          [...recentInteractions].reverse(),
          lead.contact_name
        ),
      };

      let decision: FirstReplyDecision;
      if (schedSignal === 'scheduling_intent' || schedSignal === 'booking_confirmed') {
        decision = {
          category: 'calendly_sent',
          reason: `short-circuited via scheduling_classifier=${schedSignal}`,
        };
      } else {
        // Phase 6: Call the classifier (pure classification — no prose).
        decision = await classifyFirstReply(writeOpts);
      }

      // Kill-switch gate: if info_* auto-reply is disabled, demote to
      // question_technical so it flows into the manual-review branch.
      const infoCategories = ['info_what_is_it', 'info_team', 'info_funding', 'info_general'];
      if (infoCategories.includes(decision.category) && !infoReplyEnabled()) {
        decision = {
          ...decision,
          category: 'question_technical',
          reason: `info_reply_disabled: ${decision.reason}`,
        };
      }

      // Phase 7: Branch on category. Categories are grouped by action type.
      const positiveCategories = ['positive_enthusiastic', 'positive_casual', 'positive_send_times', 'positive_specific_day'];
      const asyncCategories = ['async_prefer_email', 'async_send_info', 'async_busy'];
      const delayCategories = ['delay_specific_date', 'delay_after_event', 'delay_traveling', 'delay_generic'];
      const referralCategories = ['referral_named', 'referral_unknown'];
      const declineCategories = ['decline_polite', 'decline_firm', 'decline_unsubscribe'];
      const questionCategories = ['question_compliance', 'question_technical', 'question_pricing'];

      // GROUP A/B/C: Auto-reply categories (positive, async, info)
      if (positiveCategories.includes(decision.category) ||
          asyncCategories.includes(decision.category) ||
          infoCategories.includes(decision.category)) {
        // Guard: don't send if we sent another outbound <48h ago (cross-system)
        if (!dryRun) {
          const gapOk = await hasMinimumGap(lead.id);
          if (!gapOk) {
            result.skipped++;
            recordDetail(result, lead.id, decision.category, 'min_gap_not_met', 'skipped');
            continue;
          }
        }

        const firstName = firstNameOf(owner.name);
        const recipientFirstName = (lead.contact_name || '').trim().split(/\s+/)[0] || 'there';

        // Call the Haiku writer for the body prose. Separate from classifier.
        let rawBody: string | null = null;
        try {
          if (positiveCategories.includes(decision.category)) {
            rawBody = await writePositiveBookReply(writeOpts);
          } else if (asyncCategories.includes(decision.category)) {
            rawBody = await writeAsyncRequestReply(writeOpts);
          } else {
            const qaMatches = pickRelevantQa(lastInteraction.body || '');
            rawBody = await writeInfoRequestReply({ ...writeOpts, qaMatches });
          }
        } catch (err) {
          rawBody = null;
          result.errors.push(
            `writer failed for ${lead.id}: ${err instanceof Error ? err.message : String(err)}`
          );
        }

        const scrubbed = rawBody
          ? formatEmailBody(rawBody, {
              recipientFirstName,
              senderFirstName: firstName,
            })
          : null;
        if (!scrubbed) {
          if (!dryRun) {
            await createManualReview(supabase, {
              leadId: lead.id,
              ownedBy: lead.owned_by,
              threadId,
              category: decision.category,
              reason: 'writer_returned_no_body',
            });
          }
          result.manual_review++;
          recordDetail(result, lead.id, decision.category, 'writer_returned_no_body', 'manual_review');
          continue;
        }

        if (dryRun) {
          result.sent++;
          recordDetail(result, lead.id, decision.category, decision.reason, 'sent', scrubbed);
          continue;
        }

        if (!autoReplyEnabled()) {
          await createManualReview(supabase, {
            leadId: lead.id,
            ownedBy: lead.owned_by,
            threadId,
            category: decision.category,
            reason: `auto_reply_disabled: ${decision.reason}`,
            needsFounder: true,
          });
          result.manual_review++;
          recordDetail(result, lead.id, decision.category, `auto_reply_disabled: ${decision.reason}`, 'manual_review');
          continue;
        }

        const rfcMessageId = (lastInteraction.metadata as { rfc_message_id?: string } | null)?.rfc_message_id;
        const originalSubject = lastInteraction.subject || `product prioritization at ${lead.company_name}`;
        const threadSubject = originalSubject.startsWith('Re:') ? originalSubject : `Re: ${originalSubject}`;

        const sentMessageId = await sendReplyInThread({
          teamMemberId: owner.id,
          threadId,
          to: lead.contact_email,
          subject: threadSubject,
          body: scrubbed,
          rfcMessageId,
        });

        const now = new Date().toISOString();

        await supabase.from('interactions').insert({
          lead_id: lead.id,
          team_member_id: owner.id,
          type: 'email_outbound',
          subject: threadSubject,
          body: scrubbed,
          gmail_message_id: sentMessageId || undefined,
          gmail_thread_id: threadId,
          occurred_at: now,
          metadata: {
            first_reply_auto: true,
            category: decision.category,
            ai_reason: decision.reason,
          },
        });

        await supabase.from('follow_up_queue').insert({
          lead_id: lead.id,
          assigned_to: lead.owned_by,
          type: 'first_reply_auto',
          status: 'sent',
          due_at: now,
          sent_at: now,
          suggested_message: scrubbed,
          reason: `${decision.category}: ${decision.reason}`,
          gmail_thread_id: threadId,
        });

        await supabase.from('leads').update({ last_contact_at: now }).eq('id', lead.id);

        // Advance to scheduling for positive categories
        if (positiveCategories.includes(decision.category)) {
          const stageResult = await changeStage(lead.id, 'scheduling', owner.id);
          if (!stageResult.success) {
            result.errors.push(`stage advance failed for ${lead.id}: ${stageResult.error}`);
          }
        }

        // Fast-loop: compose a short nudge now, queue for 30-120 min out
        try {
          const rawFastLoop = await writeFastLoopFollowup({ ...writeOpts, prevOutboundBody: scrubbed });
          const fastLoopBody = formatEmailBody(rawFastLoop, { recipientFirstName, senderFirstName: firstName });
          await scheduleFastLoopFollowup({
            leadId: lead.id,
            ownerId: lead.owned_by,
            threadId,
            messageBody: fastLoopBody,
            reason: `fast_loop_after_${decision.category}`,
          });
        } catch (err) {
          result.errors.push(`fast_loop_queue failed for ${lead.id}: ${err instanceof Error ? err.message : String(err)}`);
        }

        result.sent++;

      // GROUP D: Delay categories - schedule follow-up for later
      } else if (delayCategories.includes(decision.category)) {
        const followUpDate = decision.follow_up_date || getDefaultFollowUpDate(decision.category);
        if (!dryRun) {
          await supabase.from('follow_up_queue').insert({
            lead_id: lead.id,
            assigned_to: lead.owned_by,
            type: 'scheduled_recontact',
            status: 'pending',
            auto_send: true,
            scheduled_for: `${followUpDate}T10:00:00Z`,
            due_at: `${followUpDate}T10:00:00Z`,
            reason: `${decision.category}: ${decision.reason}`,
            gmail_thread_id: threadId,
          });
        }
        result.skipped++;
        recordDetail(result, lead.id, decision.category, `scheduled for ${followUpDate}`, 'scheduled');

      // GROUP D special: delay_ooo - roll back lock and schedule
      } else if (decision.category === 'delay_ooo') {
        await rollbackLock(supabase, lead.id, dryRun);
        const followUpDate = decision.follow_up_date || getDefaultFollowUpDate('delay_ooo');
        if (!dryRun && followUpDate) {
          await supabase.from('follow_up_queue').insert({
            lead_id: lead.id,
            assigned_to: lead.owned_by,
            type: 'scheduled_recontact',
            status: 'pending',
            auto_send: true,
            scheduled_for: `${followUpDate}T10:00:00Z`,
            due_at: `${followUpDate}T10:00:00Z`,
            reason: `delay_ooo: ${decision.reason}`,
            gmail_thread_id: threadId,
          });
        }
        result.rolled_back++;
        recordDetail(result, lead.id, 'delay_ooo', decision.reason, 'rolled_back');

      // GROUP E: Referral categories - create manual review to get contact info
      } else if (referralCategories.includes(decision.category)) {
        if (!dryRun) {
          await createManualReview(supabase, {
            leadId: lead.id,
            ownedBy: lead.owned_by,
            threadId,
            category: decision.category,
            reason: decision.referral_name
              ? `Referred to: ${decision.referral_name}${decision.referral_email ? ` (${decision.referral_email})` : ''}`
              : decision.reason,
            needsFounder: true,
          });
        }
        result.manual_review++;
        recordDetail(result, lead.id, decision.category, decision.reason, 'manual_review');

      // GROUP F: Decline categories - NO auto-reply, mark appropriately
      } else if (declineCategories.includes(decision.category)) {
        if (!dryRun) {
          if (decision.category === 'decline_firm' || decision.category === 'decline_unsubscribe') {
            await changeStage(lead.id, 'dead', owner.id);
          } else {
            await changeStage(lead.id, 'paused', owner.id);
          }
        }
        result.skipped++;
        recordDetail(result, lead.id, decision.category, decision.reason, 'declined');

      // GROUP G: calendly_sent - manual review, advance to scheduling
      } else if (decision.category === 'calendly_sent') {
        if (!dryRun) {
          await createManualReview(supabase, {
            leadId: lead.id,
            ownedBy: lead.owned_by,
            threadId,
            category: 'calendly_sent',
            reason: decision.reason || 'prospect_sent_calendly',
            needsFounder: true,
          });
          const stageResult = await changeStage(lead.id, 'scheduling', owner.id);
          if (!stageResult.success) {
            result.errors.push(`stage advance failed for ${lead.id}: ${stageResult.error}`);
          }
        }
        result.manual_review++;
        recordDetail(result, lead.id, 'calendly_sent', decision.reason, 'manual_review');

      // GROUP G: Question categories - manual review with NEEDS_FOUNDER
      } else if (questionCategories.includes(decision.category)) {
        if (!dryRun) {
          await createManualReview(supabase, {
            leadId: lead.id,
            ownedBy: lead.owned_by,
            threadId,
            category: decision.category,
            reason: decision.reason,
            needsFounder: true,
          });
        }
        result.manual_review++;
        recordDetail(result, lead.id, decision.category, decision.reason, 'manual_review');

      // FALLBACK: unclear - manual review
      } else {
        if (!dryRun) {
          await createManualReview(supabase, {
            leadId: lead.id,
            ownedBy: lead.owned_by,
            threadId,
            category: decision.category,
            reason: decision.reason,
          });
        }
        result.manual_review++;
        recordDetail(result, lead.id, decision.category, decision.reason, 'manual_review');
      }
    } catch (err) {
      // Any error mid-processing: roll back the lock so next cron run retries.
      await rollbackLock(supabase, lead.id, dryRun);
      result.errors.push(
        `lead ${lead.id}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  return result;
}

// ── helpers ─────────────────────────────────────────────────────────────────

function getDefaultFollowUpDate(category: string): string {
  const now = new Date();
  let daysOut = 21; // default 3 weeks

  if (category === 'delay_specific_date') daysOut = 14;
  else if (category === 'delay_after_event') daysOut = 28;
  else if (category === 'delay_traveling') daysOut = 7;
  else if (category === 'delay_generic') daysOut = 21;
  else if (category === 'delay_ooo') daysOut = 3;

  const target = new Date(now.getTime() + daysOut * 24 * 60 * 60 * 1000);
  return target.toISOString().split('T')[0];
}

async function rollbackLock(
  supabase: ReturnType<typeof createAdminClient>,
  leadId: string,
  dryRun: boolean
): Promise<void> {
  if (dryRun) return;
  await supabase
    .from('leads')
    .update({ auto_replied_to_first: false })
    .eq('id', leadId);
}

async function createManualReview(
  supabase: ReturnType<typeof createAdminClient>,
  args: {
    leadId: string;
    ownedBy: string;
    threadId: string;
    category: FirstReplyCategory;
    reason: string;
    needsFounder?: boolean;
  }
): Promise<void> {
  const now = new Date().toISOString();
  const reasonText = args.needsFounder
    ? `NEEDS_FOUNDER: ${args.category}: ${args.reason}`
    : `${args.category}: ${args.reason}`;
  await supabase.from('follow_up_queue').insert({
    lead_id: args.leadId,
    assigned_to: args.ownedBy,
    type: 'first_reply_manual_review',
    status: 'pending',
    due_at: now,
    reason: reasonText,
    gmail_thread_id: args.threadId,
  });
}

function recordDetail(
  result: FirstReplyResult,
  leadId: string,
  category: FirstReplyCategory | 'skipped',
  reason: string,
  action: ProcessDetail['action'],
  messagePreview?: string
): void {
  if (!result.details) return;
  result.details.push({
    lead_id: leadId,
    category,
    reason,
    action,
    message_preview: messagePreview?.slice(0, 200),
  });
}
