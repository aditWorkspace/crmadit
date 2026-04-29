// Structured JSON logger for the cold-outreach pipeline. Emits to stdout
// (Vercel captures stdout per function invocation and exposes it for
// search). Use at every key transition: tick_start, runDailyStart fired,
// per-send success/failure summary, auto-pause, etc.
//
// Why structured: ops can grep `event=auto_pause` or `level=error`
// directly in Vercel's log dashboard once these JSON lines accumulate.
//
// Design notes:
//   - Single line per call (no embedded newlines) so log shippers can
//     split on '\n' safely.
//   - Structural keys (ts, level, event, component) cannot be overridden
//     by user-supplied `fields` — they're set last to win the spread.

export type LogLevel = 'info' | 'warn' | 'error';

export function log(
  level: LogLevel,
  event: string,
  fields?: Record<string, unknown>
): void {
  const line = {
    ...(fields ?? {}),
    // Structural keys are placed AFTER user fields so they win on collision.
    ts: new Date().toISOString(),
    level,
    event,
    component: 'email-send',
  };
  // eslint-disable-next-line no-console -- intentional structured stdout
  console.log(JSON.stringify(line));
}
