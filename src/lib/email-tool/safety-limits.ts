// Source of truth for all hardcoded limits in the cold-outreach pipeline.
// Admin UI cannot change these; raising any value requires a code commit
// + PR review. See spec §2 + §4.3 for rationale on each value.
export const SAFETY_LIMITS = {
  // Automated cold-send target per account per day.
  AUTOMATED_DAILY_TARGET_PER_ACCOUNT: 400,

  // Absolute ceiling — system never schedules more than this even if a
  // misconfigured target exceeds it. The 99-send buffer above 400 reserves
  // headroom for the founder's manual sends, auto-replies, and CRM
  // follow-ups that share the same Gmail account.
  ABSOLUTE_DAILY_CAP_PER_ACCOUNT: 499,

  // Day-1 soft warmup cap (smoke-test day before going to full target).
  WARMUP_DAY_1_CAP: 250,

  // Inter-send jitter range — closely mirrors YAMM's pacing.
  // Random uniform draw within these bounds per send.
  // Avg ~10s -> 6 sends/min/account -> ~67min per 400-send campaign.
  INTER_SEND_JITTER_MIN_SECONDS: 5,
  INTER_SEND_JITTER_MAX_SECONDS: 15,

  // Belt-and-suspenders clamps on per-gap value, even if jitter math
  // somehow produces something outside the range.
  MIN_INTER_SEND_GAP_SECONDS_HARD_FLOOR: 5,
  MAX_INTER_SEND_GAP_SECONDS_HARD_CEILING: 30,

  // Sanity check on the campaign window — 6/min x 400 = ~67min, so 2h is
  // generous. Trip means slot scheduling logic is buggy.
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
} as const;
