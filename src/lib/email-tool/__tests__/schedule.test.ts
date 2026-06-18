import { describe, it, expect } from 'vitest';
import { computeNextRunAt, WEEKDAY_START_TIMES_PT } from '../schedule';

// Reference: PT offsets
//   Standard time (PST): UTC−8 — November to March
//   Daylight time (PDT): UTC−7 — March to November
//
// Schedule (every day has a slot; Sat/Sun are follow-ups-only):
//   Sun 8:00, Mon 8:00, Tue 8:15, Wed 8:30, Thu 8:45, Fri 9:00, Sat 8:00 (PT)
//
// Test fixtures use known dates to avoid DST ambiguity:
//   2026-05-04 Monday (PDT, UTC−7), 2026-05-08 Friday, 2026-05-09 Saturday
//   2026-12-15 Tuesday (PST, UTC−8) — exercises both offsets

describe('WEEKDAY_START_TIMES_PT', () => {
  it('has Mon=8:00, Tue=8:15, Wed=8:30, Thu=8:45, Fri=9:00 in 15-min increments from 8am', () => {
    expect(WEEKDAY_START_TIMES_PT[1]).toEqual({ hour: 8, minute: 0 });
    expect(WEEKDAY_START_TIMES_PT[2]).toEqual({ hour: 8, minute: 15 });
    expect(WEEKDAY_START_TIMES_PT[3]).toEqual({ hour: 8, minute: 30 });
    expect(WEEKDAY_START_TIMES_PT[4]).toEqual({ hour: 8, minute: 45 });
    expect(WEEKDAY_START_TIMES_PT[5]).toEqual({ hour: 9, minute: 0 });
  });

  it('has weekend follow-up-only slots at 8:00 AM (Sat + Sun)', () => {
    expect(WEEKDAY_START_TIMES_PT[0]).toEqual({ hour: 8, minute: 0 });
    expect(WEEKDAY_START_TIMES_PT[6]).toEqual({ hour: 8, minute: 0 });
  });

  it('never starts before 8:00 AM PT (deliverability minimum)', () => {
    for (const slot of Object.values(WEEKDAY_START_TIMES_PT)) {
      expect(slot.hour).toBeGreaterThanOrEqual(8);
    }
  });
});

describe('computeNextRunAt (PDT, UTC−7 in May)', () => {
  it('Sunday evening → Monday 8:00 AM PT', () => {
    // Sun May 3, 8pm PT = 2026-05-04T03:00:00Z
    const next = computeNextRunAt(new Date('2026-05-04T03:00:00Z'));
    expect(next!.toISOString()).toBe('2026-05-04T15:00:00.000Z'); // Mon 8:00 PDT
  });

  it('Monday before the slot → Monday 8:00 AM PT', () => {
    // Mon May 4, 6 AM PT = 2026-05-04T13:00:00Z
    const next = computeNextRunAt(new Date('2026-05-04T13:00:00Z'));
    expect(next!.toISOString()).toBe('2026-05-04T15:00:00.000Z');
  });

  it('Monday after the slot → Tuesday 8:15 AM PT', () => {
    // Mon May 4, 10 AM PT = 2026-05-04T17:00:00Z
    const next = computeNextRunAt(new Date('2026-05-04T17:00:00Z'));
    expect(next!.toISOString()).toBe('2026-05-05T15:15:00.000Z'); // Tue 8:15 PDT
  });

  it('Friday after the slot → Saturday 8:00 AM PT (weekends run follow-ups)', () => {
    // Fri May 8, 10 AM PT = 2026-05-08T17:00:00Z
    const next = computeNextRunAt(new Date('2026-05-08T17:00:00Z'));
    expect(next!.toISOString()).toBe('2026-05-09T15:00:00.000Z'); // Sat 8:00 PDT
  });

  it('exactly at the slot time returns the NEXT slot (strict-greater-than)', () => {
    // Mon May 4, 8:00 AM PT exactly = 2026-05-04T15:00:00Z
    const next = computeNextRunAt(new Date('2026-05-04T15:00:00Z'));
    expect(next!.toISOString()).toBe('2026-05-05T15:15:00.000Z'); // Tue 8:15 PDT
  });

  it('handles PST (winter) correctly — Tuesday 8:15 AM PST', () => {
    // Tue Dec 15, 6 AM PST (UTC−8) = 2026-12-15T14:00:00Z
    const next = computeNextRunAt(new Date('2026-12-15T14:00:00Z'));
    expect(next!.toISOString()).toBe('2026-12-15T16:15:00.000Z'); // Tue 8:15 PST
  });

  it('handles spring-forward weekend (DST change) — Sat → Sun 8:00 AM PDT', () => {
    // 2026 DST starts Sun Mar 8. Sat Mar 7, 10 AM PST = 2026-03-07T18:00:00Z
    const next = computeNextRunAt(new Date('2026-03-07T18:00:00Z'));
    expect(next!.toISOString()).toBe('2026-03-08T15:00:00.000Z'); // Sun Mar 8 8:00 PDT
  });
});
