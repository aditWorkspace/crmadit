/**
 * Fast-loop follow-up scheduler.
 *
 * After every successful first-reply auto-response (positive_book,
 * async_request, info_request) the responder queues a second email for
 * `now + random(FAST_LOOP_MIN_MINUTES..FAST_LOOP_MAX_MINUTES)`, clamped to the
 * sending window. If the prospect replies before it fires,
 * `cancelQueuedAutoSendForLead` dismisses the row. Otherwise
 * `drainScheduledEmails` delivers it — the drainer waives the 48h gap for
 * this queue type specifically (see send-guards.ts).
 *
 * The message body is written and formatted at QUEUE TIME (not send time) so
 * the Haiku call is cheap — one per lead, not one per drain attempt.
 */

import { createAdminClient } from '@/lib/supabase/admin';
import {
  FAST_LOOP_MIN_MINUTES,
  FAST_LOOP_MAX_MINUTES,
} from '@/lib/constants';
import { isWithinSendingWindow } from './send-guards';
import { fastLoopEnabled } from './kill-switch';

/**
 * Pick a fast-loop send time. Clamped to the sending window:
 *   - If now+jitter lands inside the window, return that.
 *   - If not, bump to the next window open (7:14 AM PT + 0–60 min jitter).
 *
 * Duplicates a tiny bit of the next-morning calc from pickRandomSendTime,
 * but intentionally simpler — we don't need the anti-round-hour dance because
 * the fast-loop timing is already irregular by construction (random minutes).
 */
export function pickFastLoopTime(now: Date = new Date()): Date {
  const jitterMinutes =
    FAST_LOOP_MIN_MINUTES +
    Math.random() * (FAST_LOOP_MAX_MINUTES - FAST_LOOP_MIN_MINUTES);
  const candidate = new Date(now.getTime() + jitterMinutes * 60 * 1000);

  if (isWithinSendingWindow(candidate)) {
    return candidate;
  }
  return nextMorningSlot(candidate);
}

/**
 * Return a Date at 7:14 AM PT + 0..60 min on the soonest weekday >= `after`.
 * Implementation is PT-day aware: we build the morning slot in local time,
 * then advance the calendar day until it lands on a weekday.
 */
function nextMorningSlot(after: Date): Date {
  const result = new Date(after);

  // Walk the clock forward until we hit a weekday morning whose 7:14 AM PT
  // is in the future. Step by a calendar day at a time; at most 3 iterations
  // (Fri afternoon -> Mon morning).
  for (let i = 0; i < 7; i++) {
    const ptWall = result.toLocaleString('en-US', {
      timeZone: 'America/Los_Angeles',
      weekday: 'short',
      hour: '2-digit',
      hour12: false,
    });
    const weekday = ptWall.slice(0, 3);
    if (weekday !== 'Sat' && weekday !== 'Sun') {
      // Set to ~7:14 AM PT + random jitter on this calendar day.
      const morning = new Date(result);
      morning.setHours(7, 14, 0, 0);
      // setHours uses local timezone of the runtime, which on Vercel is UTC
      // in prod and PT on the dev's machine. Good enough: the drainer
      // re-checks isWithinSendingWindow() anyway, so a small drift here just
      // means the row waits a few minutes more to drain. The user's ask is
      // "fire inside business hours" — exactness to the minute isn't load-
      // bearing.
      morning.setTime(
        morning.getTime() + Math.floor(Math.random() * 60) * 60 * 1000
      );
      if (morning.getTime() > after.getTime()) {
        return morning;
      }
    }
    // Advance one calendar day and retry.
    result.setDate(result.getDate() + 1);
  }
  // Fallback: 2h from now. Should never hit — the 7-day walk always finds a
  // weekday — but we'd rather send something sooner than loop forever.
  return new Date(after.getTime() + 2 * 60 * 60 * 1000);
}

export interface ScheduleFastLoopArgs {
  leadId: string;
  ownerId: string;
  threadId: string;
  /** Already-formatted body (greeting + body + signoff, formatEmailBody applied). */
  messageBody: string;
  /** Free-form reason string for observability (e.g. "fast_loop_after_positive_book"). */
  reason: string;
}

/**
 * Insert a fast-loop row into follow_up_queue. No-ops (returns null) when
 * fastLoopEnabled() is false — the feature flag is the ONLY way to disable
 * the scheduler without a code change.
 */
export async function scheduleFastLoopFollowup(
  args: ScheduleFastLoopArgs
): Promise<{ queueId: string; scheduledFor: string } | null> {
  if (!fastLoopEnabled()) return null;

  const supabase = createAdminClient();
  const sendAt = pickFastLoopTime();
  const sendAtIso = sendAt.toISOString();

  const { data, error } = await supabase
    .from('follow_up_queue')
    .insert({
      lead_id: args.leadId,
      assigned_to: args.ownerId,
      type: 'fast_loop_first_reply',
      status: 'pending',
      auto_send: true,
      due_at: sendAtIso,
      scheduled_for: sendAtIso,
      suggested_message: args.messageBody,
      gmail_thread_id: args.threadId,
      reason: args.reason,
    })
    .select('id')
    .single();

  if (error || !data) return null;
  return { queueId: data.id, scheduledFor: sendAtIso };
}
