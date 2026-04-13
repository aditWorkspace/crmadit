import { createAdminClient } from '@/lib/supabase/admin';

// ── Business-hours guard ────────────────────────────────────────────────────
// Auto-emails should only send during business hours Pacific time.
// If the cron fires at 2 AM PT, skip — the next daytime run handles it.

const SEND_WINDOW_START_HOUR = 9;  // 9 AM PT
const SEND_WINDOW_END_HOUR = 18;   // 6 PM PT

/** Returns true if the current time is within business hours (9 AM – 6 PM PT, weekdays). */
export function isWithinSendingWindow(now: Date = new Date()): boolean {
  const ptString = now.toLocaleString('en-US', { timeZone: 'America/Los_Angeles' });
  const ptDate = new Date(ptString);
  const hour = ptDate.getHours();
  const day = ptDate.getDay(); // 0 = Sunday, 6 = Saturday

  if (day === 0 || day === 6) return false; // no weekends
  return hour >= SEND_WINDOW_START_HOUR && hour < SEND_WINDOW_END_HOUR;
}

// ── Consecutive outbound counter ────────────────────────────────────────────
// Counts how many outbound emails we've sent to this lead since the last
// inbound reply. If we've already sent original + 1 follow-up (= 2 consecutive
// outbounds), we should NOT send another.

const MAX_CONSECUTIVE_OUTBOUND = 2; // original email + 1 follow-up

/**
 * Returns true if we're allowed to send another outbound to this lead.
 * False if we've already hit MAX_CONSECUTIVE_OUTBOUND without them replying.
 */
export async function canSendOutbound(leadId: string): Promise<boolean> {
  const supabase = createAdminClient();

  // Get recent email interactions, newest first
  const { data: interactions } = await supabase
    .from('interactions')
    .select('type')
    .eq('lead_id', leadId)
    .in('type', ['email_inbound', 'email_outbound'])
    .order('occurred_at', { ascending: false })
    .limit(10);

  if (!interactions || interactions.length === 0) return true;

  // Count consecutive outbounds from the top (newest)
  let consecutiveOutbound = 0;
  for (const i of interactions) {
    if (i.type === 'email_outbound') {
      consecutiveOutbound++;
    } else {
      break; // hit an inbound, stop counting
    }
  }

  return consecutiveOutbound < MAX_CONSECUTIVE_OUTBOUND;
}

// ── Minimum gap between outbound emails ─────────────────────────────────────
// Ensures at least MIN_GAP_HOURS between any two outbound emails to the same
// lead, regardless of which system sent them.

const MIN_GAP_HOURS = 48;

/**
 * Returns true if at least MIN_GAP_HOURS have passed since the last outbound
 * email to this lead. Prevents rapid-fire from different auto-email systems.
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

  if (!lastOutbound) return true; // no outbound ever sent

  const hoursSince =
    (Date.now() - new Date(lastOutbound.occurred_at).getTime()) / (1000 * 60 * 60);

  return hoursSince >= MIN_GAP_HOURS;
}
