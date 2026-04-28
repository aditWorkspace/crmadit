// Carried over verbatim from the standalone emailsending repo.
// Don't change without coordinating across the API route, the dashboard
// UI, and the export bundle.
export const BATCH_SIZE = 400;
export const COOLDOWN_HOURS = 12;
export const HISTORY_CAP = 50;        // standalone wrote at most 50 history entries per user; keep parity
