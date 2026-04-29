// Weekday-only fixed schedule. Mon–Fri with a +30min stagger across days,
// resetting each Monday. Saturday/Sunday: no campaigns. See spec §5.1.
//
// DST handling: all time arithmetic is done via Intl.DateTimeFormat with
// timeZone='America/Los_Angeles' so PST/PDT transitions are handled
// automatically. The functions return Date objects representing UTC
// instants; the Intl APIs do the zone conversion.

export const WEEKDAY_START_TIMES_PT: Record<number, { hour: number; minute: number }> = {
  1: { hour: 5, minute: 0 },   // Monday    — 5:00 AM PT
  2: { hour: 5, minute: 30 },  // Tuesday   — 5:30 AM PT
  3: { hour: 6, minute: 0 },   // Wednesday — 6:00 AM PT
  4: { hour: 6, minute: 30 },  // Thursday  — 6:30 AM PT
  5: { hour: 7, minute: 0 },   // Friday    — 7:00 AM PT
  // 0 = Sunday, 6 = Saturday — no entries → no campaigns
};

const PT_TZ = 'America/Los_Angeles';
const DAY_OF_WEEK_FMT = new Intl.DateTimeFormat('en-US', {
  timeZone: PT_TZ,
  weekday: 'short',
});
const YMD_FMT = new Intl.DateTimeFormat('en-CA', {
  timeZone: PT_TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});
const TZ_NAME_FMT = new Intl.DateTimeFormat('en-US', {
  timeZone: PT_TZ,
  timeZoneName: 'short',
});

const DAY_NAME_TO_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

/**
 * Returns the day-of-week (0=Sun..6=Sat) for the given UTC instant
 * AS OBSERVED IN PT.
 */
function ptDayOfWeek(d: Date): number {
  const name = DAY_OF_WEEK_FMT.format(d);
  return DAY_NAME_TO_INDEX[name] ?? 0;
}

/**
 * Returns the PT date components (year, month, day) for the given UTC instant.
 */
function ptDateParts(d: Date): { year: number; month: number; day: number } {
  const formatted = YMD_FMT.format(d); // 'YYYY-MM-DD'
  const [y, m, dd] = formatted.split('-').map(Number);
  return { year: y, month: m, day: dd };
}

/**
 * Returns the PT UTC offset (in minutes) for the given UTC instant.
 * PDT = -420 (UTC−7), PST = -480 (UTC−8).
 */
function ptOffsetMinutes(d: Date): number {
  const parts = TZ_NAME_FMT.formatToParts(d);
  const tz = parts.find(p => p.type === 'timeZoneName')?.value;
  return tz === 'PDT' ? -420 : -480;
}

/**
 * Constructs a UTC Date corresponding to the given Y/M/D + PT hour/minute.
 * Uses the PT offset that would be in effect at that local time.
 */
function ptDateAtTime(year: number, month: number, day: number, hour: number, minute: number): Date {
  // Build a tentative Date assuming PST (-08:00) and let Intl tell us the
  // actual offset that should apply. If that offset differs from -08:00,
  // we adjust.
  const tentative = new Date(Date.UTC(year, month - 1, day, hour + 8, minute));
  const actualOffset = ptOffsetMinutes(tentative);
  // We assumed -480 (-08:00) when constructing. If actual is -420 (PDT),
  // we need to shift back by 60 minutes.
  const offsetDiff = actualOffset - -480; // 0 for PST, +60 for PDT
  return new Date(tentative.getTime() - offsetDiff * 60_000);
}

/**
 * Returns the next campaign start instant after `now`, or null if none in
 * the next 7 days. Walks forward day-by-day in PT, returning the first
 * weekday slot whose start time is strictly greater than `now`.
 *
 * @param now - The reference instant (default: current time)
 */
export function computeNextRunAt(now: Date = new Date()): Date | null {
  for (let i = 0; i < 8; i++) {
    const candidate = new Date(now.getTime() + i * 24 * 60 * 60 * 1000);
    const dow = ptDayOfWeek(candidate);
    const slot = WEEKDAY_START_TIMES_PT[dow];
    if (!slot) continue; // skip Sat/Sun
    const { year, month, day } = ptDateParts(candidate);
    const slotInstant = ptDateAtTime(year, month, day, slot.hour, slot.minute);
    if (slotInstant > now) return slotInstant;
  }
  return null;
}
