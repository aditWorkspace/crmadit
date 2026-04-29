import { describe, it, expect } from 'vitest';
import { computeNextRunAt, WEEKDAY_START_TIMES_PT } from '../schedule';

// Reference: PT offsets
//   Standard time (PST): UTC−8 — November to March
//   Daylight time (PDT): UTC−7 — March to November
//
// Test fixtures use specific known dates to avoid DST ambiguity:
//   2026-04-28 is a Tuesday in PDT (UTC−7)
//   2026-05-04 is a Monday in PDT
//   2026-05-08 is a Friday in PDT
//   2026-05-09 is a Saturday in PDT
//   2026-12-15 is a Tuesday in PST (UTC−8) — exercises both offsets

describe('WEEKDAY_START_TIMES_PT', () => {
  it('has Monday=5:00, Tue=5:30, Wed=6:00, Thu=6:30, Fri=7:00 in 30-min increments', () => {
    expect(WEEKDAY_START_TIMES_PT[1]).toEqual({ hour: 5, minute: 0 });
    expect(WEEKDAY_START_TIMES_PT[2]).toEqual({ hour: 5, minute: 30 });
    expect(WEEKDAY_START_TIMES_PT[3]).toEqual({ hour: 6, minute: 0 });
    expect(WEEKDAY_START_TIMES_PT[4]).toEqual({ hour: 6, minute: 30 });
    expect(WEEKDAY_START_TIMES_PT[5]).toEqual({ hour: 7, minute: 0 });
  });

  it('does NOT have entries for Saturday (6) or Sunday (0)', () => {
    expect(WEEKDAY_START_TIMES_PT[0]).toBeUndefined();
    expect(WEEKDAY_START_TIMES_PT[6]).toBeUndefined();
  });
});

describe('computeNextRunAt', () => {
  it('called Sunday evening returns Monday 5:00 AM PT', () => {
    // Sunday May 3, 2026, 8pm PT = 2026-05-04T03:00:00Z (UTC−7 PDT)
    const sundayEvening = new Date('2026-05-04T03:00:00Z');
    const next = computeNextRunAt(sundayEvening);
    expect(next).not.toBeNull();
    // Mon May 4, 2026, 5:00 AM PT = 2026-05-04T12:00:00Z
    expect(next!.toISOString()).toBe('2026-05-04T12:00:00.000Z');
  });

  it('called Monday after the slot returns Tuesday 5:30 AM PT', () => {
    // Mon May 4, 2026, 8 AM PT = 2026-05-04T15:00:00Z
    const mondayAfter = new Date('2026-05-04T15:00:00Z');
    const next = computeNextRunAt(mondayAfter);
    // Tue May 5, 2026, 5:30 AM PT = 2026-05-05T12:30:00Z
    expect(next!.toISOString()).toBe('2026-05-05T12:30:00.000Z');
  });

  it('called Monday before the slot returns Monday 5:00 AM PT', () => {
    // Mon May 4, 2026, 4 AM PT = 2026-05-04T11:00:00Z
    const mondayBefore = new Date('2026-05-04T11:00:00Z');
    const next = computeNextRunAt(mondayBefore);
    expect(next!.toISOString()).toBe('2026-05-04T12:00:00.000Z');
  });

  it('called Friday after the slot returns next Monday 5:00 AM PT', () => {
    // Fri May 8, 2026, 8 AM PT = 2026-05-08T15:00:00Z
    const fridayAfter = new Date('2026-05-08T15:00:00Z');
    const next = computeNextRunAt(fridayAfter);
    // Mon May 11, 2026, 5:00 AM PT = 2026-05-11T12:00:00Z
    expect(next!.toISOString()).toBe('2026-05-11T12:00:00.000Z');
  });

  it('called Saturday returns next Monday 5:00 AM PT', () => {
    // Sat May 9, 2026, 10 AM PT = 2026-05-09T17:00:00Z
    const saturday = new Date('2026-05-09T17:00:00Z');
    const next = computeNextRunAt(saturday);
    expect(next!.toISOString()).toBe('2026-05-11T12:00:00.000Z');
  });

  it('called Sunday morning returns Monday 5:00 AM PT', () => {
    // Sun May 10, 2026, 9 AM PT = 2026-05-10T16:00:00Z
    const sundayMorning = new Date('2026-05-10T16:00:00Z');
    const next = computeNextRunAt(sundayMorning);
    expect(next!.toISOString()).toBe('2026-05-11T12:00:00.000Z');
  });

  it('handles PST (winter) correctly', () => {
    // Tue Dec 15, 2026, 4 AM PT (PST = UTC−8) = 2026-12-15T12:00:00Z
    // Tuesday slot is 5:30 AM PST = 2026-12-15T13:30:00Z
    const winterTueBefore = new Date('2026-12-15T12:00:00Z');
    const next = computeNextRunAt(winterTueBefore);
    expect(next!.toISOString()).toBe('2026-12-15T13:30:00.000Z');
  });

  it('handles transition: spring-forward weekend (Sat→Sun→Mon, DST changes)', () => {
    // 2026's DST starts Sun March 8, 2026, 2:00 AM PST → 3:00 AM PDT.
    // Called Sat March 7, 2026, 10 AM PST = 2026-03-07T18:00:00Z
    // Next run: Mon March 9, 2026, 5:00 AM PDT = 2026-03-09T12:00:00Z
    const saturday = new Date('2026-03-07T18:00:00Z');
    const next = computeNextRunAt(saturday);
    expect(next!.toISOString()).toBe('2026-03-09T12:00:00.000Z');
  });

  it('called exactly at the slot time returns the NEXT slot (strict-greater-than)', () => {
    // If now == due_at, the convention is "this slot is now in progress" —
    // computeNextRunAt should return the FOLLOWING slot.
    // Mon May 4, 5:00 AM PT exactly:
    const exactly = new Date('2026-05-04T12:00:00Z');
    const next = computeNextRunAt(exactly);
    // Should return Tue 5:30 AM PT
    expect(next!.toISOString()).toBe('2026-05-05T12:30:00.000Z');
  });
});
