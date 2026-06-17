// Source of truth for all hardcoded limits in the cold-outreach pipeline.
// Admin UI cannot change these; raising any value requires a code commit
// + PR review. See spec §2 + §4.3 for rationale on each value.
export const SAFETY_LIMITS = {
  // Automated cold-send target per account per day. This is the *total*
  // slot count: fresh-cold sends + reserved opener-no-reply follow-ups
  // (see FOLLOWUP_DAILY_CAP_PER_FOUNDER in src/lib/email-tool/constants.ts).
  // Bumped 400 → 450 on 2026-05-15; follow-up reserve raised 50 → 100 on
  // 2026-06-16, so 450 now = 350 fresh + 100 follow-ups per account.
  AUTOMATED_DAILY_TARGET_PER_ACCOUNT: 450,

  // Absolute ceiling — system never schedules more than this even if a
  // misconfigured target exceeds it. The 49-send buffer above 450 reserves
  // headroom for the founder's manual sends, auto-replies, and CRM
  // follow-ups that share the same Gmail account.
  ABSOLUTE_DAILY_CAP_PER_ACCOUNT: 499,

  // Day-1 soft warmup cap (smoke-test day before going to full target).
  WARMUP_DAY_1_CAP: 250,

  // Inter-send jitter range — closely mirrors YAMM's pacing.
  // Random uniform draw within these bounds per send.
  // Avg ~10s -> 6 sends/min/account -> ~75min per 450-send campaign.
  INTER_SEND_JITTER_MIN_SECONDS: 5,
  INTER_SEND_JITTER_MAX_SECONDS: 15,

  // Belt-and-suspenders clamps on per-gap value, even if jitter math
  // somehow produces something outside the range.
  MIN_INTER_SEND_GAP_SECONDS_HARD_FLOOR: 5,
  MAX_INTER_SEND_GAP_SECONDS_HARD_CEILING: 30,

  // Sanity check on the campaign window — 6/min x 450 = ~75min, so 2h is
  // still generous. Trip means slot scheduling logic is buggy.
  MAX_CAMPAIGN_DURATION_HOURS: 2,

  // No more than 1 send to any recipient_domain per founder per day.
  MAX_SENDS_PER_DOMAIN_PER_ACCOUNT_PER_DAY: 1,

  // Auto-pause threshold for bounce rate (5%, intentionally above industry
  // 2% — see spec §2 "Bounce-rate threshold rationale").
  BOUNCE_RATE_PAUSE_THRESHOLD: 0.05,

  // Per-tick processing budget (Vercel function limit is 5min).
  TICK_BUDGET_SENDS_PER_RUN: 30,
  TICK_BUDGET_DURATION_SECONDS: 240,

  // Stale-row threshold for crash recovery sweep.
  CRASH_RECOVERY_STALE_MINUTES: 10,

  // Orphan-campaign detection window (campaign claimed but no queue rows).
  ORPHAN_CAMPAIGN_THRESHOLD_MINUTES: 5,

  // Crash counter rule — N crashes in M minutes triggers global pause.
  CRASH_COUNTER_THRESHOLD: 3,
  CRASH_COUNTER_WINDOW_MINUTES: 10,

  // Exponential backoff schedule for 429 (rate_limit_retry).
  // attempts=1 → 5s, attempts=2 → 30s, attempts=3 → 2m, then 'failed'.
  // See spec §6 ⑤d ("5s/30s/2m, max 3 retries"). Caveat C7.
  RATE_LIMIT_RETRY_DELAYS_MS: [5_000, 30_000, 120_000] as const,

  // Priority CSV upload limit per single batch.
  PRIORITY_BATCH_MAX_ROWS_PER_UPLOAD: 500,

  // Pool low-water alert threshold (days of runway remaining at full volume).
  POOL_LOW_WATER_DAYS: 5,

  // Morning-only enforcement. The schedule slots are 5:00–7:00am PT
  // (Mon–Fri). NO sends ever fire outside this window. Two-layer defense:
  //
  //   1. SLOT_GRACE_MINUTES — tick.ts only self-triggers runDailyStart if
  //      `now` is within (slot, slot + grace_minutes]. Catches the case
  //      where the schedule is enabled mid-day and the cron tries to fire
  //      "today's" slot retroactively.
  //
  //   2. SEND_ALLOWED_PT_HOUR_MIN/MAX — runDailyStart aborts if the PT
  //      hour falls outside [MIN, MAX). Defense-in-depth: even if a slot
  //      grace check is bypassed somehow, sends never fire in the PM.
  //      MIN=4 lets the legitimate 5/6/7am slots through; MAX=12 is the
  //      explicit no-PM cutoff.
  //
  // Triggered by 2026-04-29 incident: enabling schedule at 9:15pm caused
  // the cron to retroactively trigger today's already-passed 6:00am slot,
  // sending 750 emails at 9:15pm PT instead of the intended 6:30am next
  // morning. See docs/superpowers/notes/2026-04-28-outreach-build-caveats.md
  // (entry: "C20 — schedule re-enable retroactive trigger").
  SLOT_GRACE_MINUTES: 30,
  SEND_ALLOWED_PT_HOUR_MIN: 4,
  SEND_ALLOWED_PT_HOUR_MAX: 12,
} as const;

// ── Quality-first volume hold — extended for the personalization layer ────
// Originally a 2-week deliverability cooldown (2026-06-02 → 06-15); now held
// open because we send *personalized* fresh emails (each one is researched +
// written by the cold-email draft pipeline) rather than generic blasts. Raised
// 2026-06-16 to 250 personalized fresh + 100 reserved follow-up bumps per
// account (FOLLOWUP_DAILY_CAP_PER_FOUNDER), so the effective per-account ceiling
// is 350 = 250 fresh + 100 bumps. start.ts applies this as a Math.min ceiling
// over the warmup / steady-state cap, and reserves the follow-up bumps first
// (so each account aims for at least ~50 bumps whenever reply candidates exist).
//
// Window: PT send-dates < TEMP_REDUCED_RESUME_PT_DATE use 350; on/after that
// date the cap reverts to AUTOMATED_DAILY_TARGET_PER_ACCOUNT (450). To keep the
// quality-first regime, push the date out; to return to full generic volume,
// set it to a past date (or delete this block and the effectiveDailyTarget-
// PerAccount() call in start.ts). Assumes only Adit + Asim send.
export const TEMP_REDUCED_TARGET_PER_ACCOUNT = 350; // 250 fresh + 100 follow-up bumps
export const TEMP_REDUCED_RESUME_PT_DATE = '2026-09-01'; // first full-volume PT date (exclusive bound)

/**
 * Per-account daily send target for a given PT date string ('YYYY-MM-DD').
 * Returns the temporary reduced ceiling during the cooldown window, otherwise
 * the steady-state SAFETY_LIMITS.AUTOMATED_DAILY_TARGET_PER_ACCOUNT. ISO date
 * strings compare lexicographically == chronologically, so a plain `<` works.
 */
export function effectiveDailyTargetPerAccount(ptDate: string): number {
  return ptDate < TEMP_REDUCED_RESUME_PT_DATE
    ? TEMP_REDUCED_TARGET_PER_ACCOUNT
    : SAFETY_LIMITS.AUTOMATED_DAILY_TARGET_PER_ACCOUNT;
}
