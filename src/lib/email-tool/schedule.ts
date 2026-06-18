// Daily fixed schedule. Mon–Fri with a +30min stagger across days,
// resetting each Monday. Sat/Sun: a smaller followup-only run at 7:30 AM
// PT (start.ts forces freshTotalTarget = 0 on weekends, so only
// opener-no-reply bumps go out — up to FOLLOWUP_DAILY_CAP_PER_FOUNDER
// per founder). See spec §5.1.
//
// DST handling: all time arithmetic is done via Intl.DateTimeFormat with
// timeZone='America/Los_Angeles' so PST/PDT transitions are handled
// automatically. The functions return Date objects representing UTC
// instants; the Intl APIs do the zone conversion.

export const WEEKDAY_START_TIMES_PT: Record<number, { hour: number; minute: number }> = {
  0: { hour: 8, minute: 0 },   // Sunday    — 8:00 AM PT (follow-ups only)
  1: { hour: 8, minute: 0 },   // Monday    — 8:00 AM PT
  2: { hour: 8, minute: 15 },  // Tuesday   — 8:15 AM PT
  3: { hour: 8, minute: 30 },  // Wednesday — 8:30 AM PT
  4: { hour: 8, minute: 45 },  // Thursday  — 8:45 AM PT
  5: { hour: 9, minute: 0 },   // Friday    — 9:00 AM PT
  6: { hour: 8, minute: 0 },   // Saturday  — 8:00 AM PT (follow-ups only)
};

// PT-date-keyed one-off overrides. When today's PT date is a key here, the
// daily-start slot uses these hour/minute instead of the weekday default.
// Remove entries once their date has passed.
export const SCHEDULE_OVERRIDE_PT_DATES: Record<string, { hour: number; minute: number }> = {
  '2026-05-20': { hour: 8, minute: 35 },
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
 * slot whose start time is strictly greater than `now`. Weekend slots
 * are included — start.ts decides what to actually queue on those days.
 *
 * @param now - The reference instant (default: current time)
 */
export function computeNextRunAt(now: Date = new Date()): Date | null {
  for (let i = 0; i < 8; i++) {
    const candidate = new Date(now.getTime() + i * 24 * 60 * 60 * 1000);
    const { year, month, day } = ptDateParts(candidate);
    const ptKey = YMD_FMT.format(candidate);
    const override = SCHEDULE_OVERRIDE_PT_DATES[ptKey];
    const slot = override ?? WEEKDAY_START_TIMES_PT[ptDayOfWeek(candidate)];
    if (!slot) continue;
    const slotInstant = ptDateAtTime(year, month, day, slot.hour, slot.minute);
    if (slotInstant > now) return slotInstant;
  }
  return null;
}

/** Returns true if the given UTC instant falls on Saturday or Sunday in PT. */
export function isPtWeekend(d: Date): boolean {
  const dow = ptDayOfWeek(d);
  return dow === 0 || dow === 6;
}
