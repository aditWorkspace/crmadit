// Carried over verbatim from the standalone emailsending repo.
// Don't change without coordinating across the API route, the dashboard
// UI, and the export bundle.
export const BATCH_SIZE = 400;
export const COOLDOWN_HOURS = 12;
export const HISTORY_CAP = 50;        // standalone wrote at most 50 history entries per user; keep parity

// ── Email-tool follow-up loop ────────────────────────────────────────────
// Each founder's daily campaign reserves up to FOLLOWUP_DAILY_CAP slots
// for "bumping in case it got lost" follow-ups to recipients who OPENED
// the original but never replied. Fresh-cold target is reduced by this
// amount; if fewer recipients are eligible, the cap shrinks the day's
// total send (so daily can go below BATCH_SIZE).
export const FOLLOWUP_DAILY_CAP_PER_FOUNDER = 50;
// A recipient must have at least N hours between original send and
// follow-up. Anything sooner feels too pushy.
export const FOLLOWUP_MIN_AGE_HOURS = 72;   // 3 days
// And no more than N hours — beyond that the recipient has moved on.
export const FOLLOWUP_MAX_AGE_HOURS = 14 * 24;   // 14 days
