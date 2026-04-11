import { createAdminClient } from '@/lib/supabase/admin';
import { sendReplyInThread } from '@/lib/gmail/send';
import { classifySchedulingIntent } from '@/lib/gmail/scheduling-classifier';
import { classifyFirstReply, type FirstReplyClassification } from '@/lib/ai/first-reply-classifier';
import { changeStage } from '@/lib/automation/stage-logic';
import { BOOKING_URL } from '@/lib/constants';
import type { FirstReplyDecision } from '@/lib/validation';

// Cap how many leads we process per cron run. At 3-user scale this is
// effectively unbounded but it bounds the worst case if something pathological
// happens (e.g. a backlog after a cron outage).
const MAX_LEADS_PER_RUN = 25;

// Any inbound older than this is almost certainly not a "first reply we're
// still fresh enough to auto-respond to". Prevents awkward auto-responses to
// weeks-old replies that for whatever reason never got the flag flipped.
const MAX_INBOUND_AGE_HOURS = 72;

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
  classification: FirstReplyClassification | 'skipped';
  reason: string;
  action: 'sent' | 'manual_review' | 'rolled_back' | 'skipped';
  message_preview?: string;
}

export interface RunOptions {
  // When true, skip all side effects: no lock UPDATE, no Gmail send,
  // no stage change, no follow_up_queue writes. Only reads + classification.
  // Returns classification details for inspection.
  dryRun?: boolean;
}

// Strip em dashes and en dashes from AI output as a safety net even though
// the prompt forbids them. Also collapses any stray whitespace before the
// replacement comma.
function scrubDashes(s: string): string {
  return s
    .replaceAll('—', ', ')
    .replaceAll('–', ', ')
    .replace(/\s+,/g, ',')
    .trim();
}

// Belt-and-suspenders: if the model drops the signoff (observed ~10% on long
// async_request outputs even with the prompt rule), append it. Idempotent.
function ensureSignoff(message: string, firstName: string): string {
  const trimmed = message.trimEnd();
  const lines = trimmed.split('\n');
  const lastLine = lines[lines.length - 1]?.trim() ?? '';
  if (lastLine === firstName) return trimmed;
  // If last line is anything else (question mark, period, etc), append signoff.
  return `${trimmed}\n\n${firstName}`;
}

function firstNameOf(fullName: string | null | undefined): string {
  if (!fullName) return 'Adit';
  const trimmed = fullName.trim();
  if (!trimmed) return 'Adit';
  return trimmed.split(/\s+/)[0];
}

function buildBookingUrl(contactEmail: string): string {
  try {
    const u = new URL(BOOKING_URL);
    u.searchParams.set('email', contactEmail);
    return u.toString();
  } catch {
    return BOOKING_URL;
  }
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
        .select('id, type, subject, body, gmail_message_id, gmail_thread_id, occurred_at')
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
        await rollbackLock(supabase, lead.id, dryRun);
        result.skipped++;
        recordDetail(
          result,
          lead.id,
          'skipped',
          `inbound too old (${Math.round(inboundAgeHours)}h)`,
          'skipped'
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
            classification: 'unclear',
            reason: 'owner_gmail_disconnected',
          });
        }
        result.manual_review++;
        recordDetail(
          result,
          lead.id,
          'unclear',
          'owner_gmail_disconnected',
          'manual_review'
        );
        continue;
      }

      // Phase 5: Short-circuit Calendly/SavvyCal/Cal.com via existing regex
      // classifier before burning an LLM call.
      const schedSignal = await classifySchedulingIntent(
        lastInteraction.subject || '',
        lastInteraction.body || ''
      );

      let decision: FirstReplyDecision;
      if (schedSignal === 'scheduling_intent' || schedSignal === 'booking_confirmed') {
        decision = {
          classification: 'calendly_sent',
          reason: `short-circuited via scheduling_classifier=${schedSignal}`,
          message: null,
        };
      } else {
        // Phase 6: Call the main AI classifier.
        const threadForAi = [...recentInteractions].reverse();
        decision = await classifyFirstReply({
          contactName: lead.contact_name,
          contactRole: lead.contact_role,
          companyName: lead.company_name,
          senderFirstName: firstNameOf(owner.name),
          bookingUrl: buildBookingUrl(lead.contact_email),
          latestInboundBody: lastInteraction.body || '',
          threadContext: buildThreadContext(threadForAi, lead.contact_name),
        });
      }

      // Phase 7: Branch on classification.
      switch (decision.classification) {
        case 'positive_book':
        case 'async_request': {
          const firstName = firstNameOf(owner.name);
          const withSignoff = decision.message
            ? ensureSignoff(scrubDashes(decision.message), firstName)
            : null;
          const scrubbed = withSignoff;
          if (!scrubbed) {
            // Classifier said send but gave no body — fall through to manual review.
            if (!dryRun) {
              await createManualReview(supabase, {
                leadId: lead.id,
                ownedBy: lead.owned_by,
                threadId,
                classification: decision.classification,
                reason: 'ai_returned_null_message',
              });
            }
            result.manual_review++;
            recordDetail(
              result,
              lead.id,
              decision.classification,
              'ai_returned_null_message',
              'manual_review'
            );
            break;
          }

          if (dryRun) {
            result.sent++;
            recordDetail(
              result,
              lead.id,
              decision.classification,
              decision.reason,
              'sent',
              scrubbed
            );
            break;
          }

          const lastInboundMsgId = lastInteraction.gmail_message_id;
          const inReplyToMessageId = lastInboundMsgId
            ? `<${lastInboundMsgId}@gmail.com>`
            : undefined;

          const originalSubject =
            lastInteraction.subject ||
            `product prioritization at ${lead.company_name}`;
          const threadSubject = originalSubject.startsWith('Re:')
            ? originalSubject
            : `Re: ${originalSubject}`;

          const sentMessageId = await sendReplyInThread({
            teamMemberId: owner.id,
            threadId,
            to: lead.contact_email,
            subject: threadSubject,
            body: scrubbed,
            inReplyToMessageId,
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
              classification: decision.classification,
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
            reason: `${decision.classification}: ${decision.reason}`,
            gmail_thread_id: threadId,
          });

          await supabase
            .from('leads')
            .update({ last_contact_at: now })
            .eq('id', lead.id);

          if (decision.classification === 'positive_book') {
            const stageResult = await changeStage(lead.id, 'scheduling', owner.id);
            if (!stageResult.success) {
              result.errors.push(
                `stage advance failed for ${lead.id}: ${stageResult.error}`
              );
            }
          }

          result.sent++;
          break;
        }

        case 'calendly_sent': {
          if (!dryRun) {
            await createManualReview(supabase, {
              leadId: lead.id,
              ownedBy: lead.owned_by,
              threadId,
              classification: 'calendly_sent',
              reason: decision.reason || 'prospect_sent_calendly',
            });
            const stageResult = await changeStage(lead.id, 'scheduling', owner.id);
            if (!stageResult.success) {
              result.errors.push(
                `stage advance failed for ${lead.id}: ${stageResult.error}`
              );
            }
          }
          result.manual_review++;
          recordDetail(result, lead.id, 'calendly_sent', decision.reason, 'manual_review');
          break;
        }

        case 'ooo': {
          // Special case: roll back the flag so the real human reply (when it
          // arrives later) gets processed instead of burning our one-shot here.
          await rollbackLock(supabase, lead.id, dryRun);
          if (!dryRun) {
            await createManualReview(supabase, {
              leadId: lead.id,
              ownedBy: lead.owned_by,
              threadId,
              classification: 'ooo',
              reason: 'out_of_office_auto_reply',
            });
          }
          result.rolled_back++;
          recordDetail(result, lead.id, 'ooo', decision.reason, 'rolled_back');
          break;
        }

        case 'question_only':
        case 'decline':
        case 'unclear': {
          if (!dryRun) {
            await createManualReview(supabase, {
              leadId: lead.id,
              ownedBy: lead.owned_by,
              threadId,
              classification: decision.classification,
              reason: decision.reason,
            });
          }
          result.manual_review++;
          recordDetail(
            result,
            lead.id,
            decision.classification,
            decision.reason,
            'manual_review'
          );
          break;
        }
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
    classification: FirstReplyClassification;
    reason: string;
  }
): Promise<void> {
  const now = new Date().toISOString();
  await supabase.from('follow_up_queue').insert({
    lead_id: args.leadId,
    assigned_to: args.ownedBy,
    type: 'first_reply_manual_review',
    status: 'pending',
    due_at: now,
    reason: `${args.classification}: ${args.reason}`,
    gmail_thread_id: args.threadId,
  });
}

function recordDetail(
  result: FirstReplyResult,
  leadId: string,
  classification: FirstReplyClassification | 'skipped',
  reason: string,
  action: ProcessDetail['action'],
  messagePreview?: string
): void {
  if (!result.details) return;
  result.details.push({
    lead_id: leadId,
    classification,
    reason,
    action,
    message_preview: messagePreview?.slice(0, 200),
  });
}
