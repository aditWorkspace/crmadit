import { createAdminClient } from '@/lib/supabase/admin';
import { sendReplyInThread } from '@/lib/gmail/send';

// ── Business-hours window (Pacific Time) ────────────────────────────────────
// Auto-emails queue for delivery inside this window. Anything decided outside
// the window gets scheduled for the next opening + random jitter.

const SEND_WINDOW_START_MINUTES = 7 * 60 + 14; // 7:14 AM PT
const SEND_WINDOW_END_MINUTES = 18 * 60;        // 6:00 PM PT

/** Get current time in Pacific as { hour, minute, day }. */
function getPacificTime(now: Date = new Date()) {
  const ptString = now.toLocaleString('en-US', { timeZone: 'America/Los_Angeles' });
  const ptDate = new Date(ptString);
  return {
    hour: ptDate.getHours(),
    minute: ptDate.getMinutes(),
    day: ptDate.getDay(), // 0=Sun, 6=Sat
    totalMinutes: ptDate.getHours() * 60 + ptDate.getMinutes(),
  };
}

/** Returns true if the current time is within sending window (7:14 AM – 6 PM PT, weekdays). */
export function isWithinSendingWindow(now: Date = new Date()): boolean {
  const pt = getPacificTime(now);
  if (pt.day === 0 || pt.day === 6) return false;
  return pt.totalMinutes >= SEND_WINDOW_START_MINUTES && pt.totalMinutes < SEND_WINDOW_END_MINUTES;
}

/**
 * Pick a random send time within business hours. If we're currently inside the
 * window, picks a random time between now+5min and end of window. If outside
 * the window, picks a random time in the next business day's window.
 *
 * Never returns a round hour (adds 1-58 min jitter to the hour).
 */
export function pickRandomSendTime(now: Date = new Date()): Date {
  const pt = getPacificTime(now);

  // Helper: random int in [min, max]
  const rand = (min: number, max: number) => Math.floor(Math.random() * (max - min + 1)) + min;

  let targetMinutesOfDay: number;

  if (isWithinSendingWindow(now)) {
    // Currently in business hours: schedule for 7-55 min from now (avoids
    // clustering at the start of the window and avoids round hours).
    const earliest = pt.totalMinutes + 7;
    const latest = Math.min(pt.totalMinutes + 55, SEND_WINDOW_END_MINUTES - 5);
    if (earliest >= latest) {
      // Near end of window, just pick a time soon
      targetMinutesOfDay = pt.totalMinutes + rand(3, 12);
    } else {
      targetMinutesOfDay = rand(earliest, latest);
    }
  } else {
    // Outside business hours: schedule for next business day window
    // Random time between 7:14 AM and 10:30 AM (spread across the morning)
    targetMinutesOfDay = SEND_WINDOW_START_MINUTES + rand(0, 195); // up to ~10:29 AM
  }

  // Ensure we never land on :00 (round hour)
  if (targetMinutesOfDay % 60 === 0) {
    targetMinutesOfDay += rand(1, 58);
  }

  // Build the target Date. If outside window, advance to next weekday.
  const result = new Date(now);

  if (!isWithinSendingWindow(now)) {
    // Advance to next weekday
    if (pt.day === 6) {
      result.setDate(result.getDate() + 2); // Sat → Mon
    } else if (pt.day === 0) {
      result.setDate(result.getDate() + 1); // Sun → Mon
    } else if (pt.totalMinutes >= SEND_WINDOW_END_MINUTES) {
      result.setDate(result.getDate() + 1); // After hours → next day
      // If that's Saturday, skip to Monday
      const nextDay = new Date(result);
      const nextDayPt = getPacificTime(nextDay);
      if (nextDayPt.day === 6) result.setDate(result.getDate() + 2);
      if (nextDayPt.day === 0) result.setDate(result.getDate() + 1);
    }
    // Before hours today — same day is fine
  }

  // Set the time in PT by computing offset from current PT time
  const diffMinutes = targetMinutesOfDay - pt.totalMinutes;
  result.setTime(result.getTime() + diffMinutes * 60 * 1000);

  return result;
}

// ── Consecutive outbound counter ────────────────────────────────────────────
const MAX_CONSECUTIVE_OUTBOUND = 2; // original email + 1 follow-up

/**
 * Returns true if we're allowed to send another outbound to this lead.
 * False if we've already hit MAX_CONSECUTIVE_OUTBOUND without them replying.
 */
export async function canSendOutbound(leadId: string): Promise<boolean> {
  const supabase = createAdminClient();

  const { data: interactions } = await supabase
    .from('interactions')
    .select('type')
    .eq('lead_id', leadId)
    .in('type', ['email_inbound', 'email_outbound'])
    .order('occurred_at', { ascending: false })
    .limit(10);

  if (!interactions || interactions.length === 0) return true;

  let consecutiveOutbound = 0;
  for (const i of interactions) {
    if (i.type === 'email_outbound') {
      consecutiveOutbound++;
    } else {
      break;
    }
  }

  return consecutiveOutbound < MAX_CONSECUTIVE_OUTBOUND;
}

// ── Minimum gap between outbound emails ─────────────────────────────────────
const MIN_GAP_HOURS = 48;

/**
 * Returns true if at least MIN_GAP_HOURS have passed since the last outbound
 * email to this lead.
 */
export async function hasMinimumGap(leadId: string): Promise<boolean> {
  const supabase = createAdminClient();

  const { data: lastOutbound } = await supabase
    .from('interactions')
    .select('occurred_at')
    .eq('lead_id', leadId)
    .eq('type', 'email_outbound')
    .order('occurred_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!lastOutbound) return true;

  const hoursSince =
    (Date.now() - new Date(lastOutbound.occurred_at).getTime()) / (1000 * 60 * 60);

  return hoursSince >= MIN_GAP_HOURS;
}

// ── Scheduled email queue drainer ───────────────────────────────────────────
// Both auto-followup and first-reply-responder queue emails into
// follow_up_queue with auto_send=true and a random scheduled_for time.
// This function sends any that are due.

export interface DrainResult {
  sent: number;
  errors: string[];
}

export async function drainScheduledEmails(): Promise<DrainResult> {
  const result: DrainResult = { sent: 0, errors: [] };

  // Only drain during business hours
  if (!isWithinSendingWindow()) return result;

  const supabase = createAdminClient();
  const now = new Date().toISOString();

  // Find queue entries that are due
  const { data: due } = await supabase
    .from('follow_up_queue')
    .select('id, lead_id, assigned_to, suggested_message, gmail_thread_id, type')
    .eq('auto_send', true)
    .eq('status', 'pending')
    .lte('scheduled_for', now)
    .limit(20);

  if (!due || due.length === 0) return result;

  for (const entry of due) {
    try {
      if (!entry.suggested_message || !entry.gmail_thread_id) {
        // Mark as failed — missing data
        await supabase.from('follow_up_queue').update({ status: 'failed' }).eq('id', entry.id);
        result.errors.push(`Queue ${entry.id}: missing message or thread_id`);
        continue;
      }

      // Look up lead for recipient email
      const { data: lead } = await supabase
        .from('leads')
        .select('contact_email, company_name')
        .eq('id', entry.lead_id)
        .single();

      if (!lead?.contact_email) {
        await supabase.from('follow_up_queue').update({ status: 'failed' }).eq('id', entry.id);
        result.errors.push(`Queue ${entry.id}: lead missing contact_email`);
        continue;
      }

      // Re-check guards right before sending (someone may have replied in the meantime)
      const [canSend, gapOk] = await Promise.all([
        canSendOutbound(entry.lead_id),
        hasMinimumGap(entry.lead_id),
      ]);

      if (!canSend || !gapOk) {
        // Conditions changed — dismiss instead of sending
        await supabase.from('follow_up_queue').update({ status: 'dismissed' }).eq('id', entry.id);
        continue;
      }

      // Look up sender
      const { data: member } = await supabase
        .from('team_members')
        .select('id, name, gmail_connected')
        .eq('id', entry.assigned_to)
        .single();

      if (!member?.gmail_connected) {
        await supabase.from('follow_up_queue').update({ status: 'failed' }).eq('id', entry.id);
        result.errors.push(`Queue ${entry.id}: sender gmail not connected`);
        continue;
      }

      // Look up thread subject from most recent interaction
      const { data: lastInt } = await supabase
        .from('interactions')
        .select('subject, gmail_message_id')
        .eq('lead_id', entry.lead_id)
        .eq('type', 'email_inbound')
        .order('occurred_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      const originalSubject = lastInt?.subject
        || `product prioritization at ${lead.company_name}`;
      const threadSubject = originalSubject.startsWith('Re:')
        ? originalSubject
        : `Re: ${originalSubject}`;

      const inReplyToMessageId = lastInt?.gmail_message_id
        ? `<${lastInt.gmail_message_id}@gmail.com>`
        : undefined;

      // Send the email
      const sentMessageId = await sendReplyInThread({
        teamMemberId: member.id,
        threadId: entry.gmail_thread_id,
        to: lead.contact_email,
        subject: threadSubject,
        body: entry.suggested_message,
        inReplyToMessageId,
      });

      const sentAt = new Date().toISOString();

      // Log the interaction
      await supabase.from('interactions').insert({
        lead_id: entry.lead_id,
        team_member_id: member.id,
        type: 'email_outbound',
        subject: threadSubject,
        body: entry.suggested_message,
        gmail_message_id: sentMessageId || undefined,
        gmail_thread_id: entry.gmail_thread_id,
        occurred_at: sentAt,
        metadata: {
          auto_followup: true,
          queued_send: true,
          queue_type: entry.type,
        },
      });

      // Update queue entry
      await supabase.from('follow_up_queue')
        .update({ status: 'sent', sent_at: sentAt })
        .eq('id', entry.id);

      // Update lead's last_contact_at
      await supabase.from('leads')
        .update({ last_contact_at: sentAt })
        .eq('id', entry.lead_id);

      result.sent++;
    } catch (err) {
      result.errors.push(`Queue ${entry.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return result;
}
