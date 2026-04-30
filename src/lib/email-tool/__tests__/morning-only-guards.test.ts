import { describe, it, expect } from 'vitest';
import { SAFETY_LIMITS } from '../safety-limits';
import { runDailyStart } from '../start';

// Build a stub supabase client that records what was called. We only need
// to prove the PM-hours guard SHORT-CIRCUITS — if the guard fires correctly,
// no DB calls should happen at all. So a deliberately-broken stub is fine:
// any access (even .from() or .rpc()) means the guard didn't bail.
function makeStrictSupa(): never {
  return new Proxy({}, {
    get() {
      throw new Error('supabase access during PM-blocked run — guard failed');
    },
  }) as never;
}

// Build a Date object at a specific PT wall-clock hour. Uses a reference
// date in PDT to avoid DST edge cases — May 2026 is solidly in PDT (-07:00).
function ptDate(year: number, month: number, day: number, hour: number, minute = 0): Date {
  return new Date(`${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00-07:00`);
}

describe('runDailyStart morning-only PM-block', () => {
  it('aborts with reason="pm_hours_disallowed" at PT noon', async () => {
    const supa = makeStrictSupa();
    const noonPt = ptDate(2026, 5, 4, 12, 0);
    const result = await runDailyStart(supa, { now: noonPt });
    expect(result.kind).toBe('aborted');
    if (result.kind === 'aborted') {
      expect(result.reason).toBe('pm_hours_disallowed');
      expect(result.campaign_id).toBeNull();
    }
  });

  it('aborts at PT 9pm (the exact incident hour)', async () => {
    const supa = makeStrictSupa();
    const ninePmPt = ptDate(2026, 4, 29, 21, 15);
    const result = await runDailyStart(supa, { now: ninePmPt });
    expect(result.kind).toBe('aborted');
    if (result.kind === 'aborted') expect(result.reason).toBe('pm_hours_disallowed');
  });

  it('aborts at 3am PT (too early — before any slot)', async () => {
    const supa = makeStrictSupa();
    const threeAm = ptDate(2026, 5, 4, 3, 0);
    const result = await runDailyStart(supa, { now: threeAm });
    expect(result.kind).toBe('aborted');
    if (result.kind === 'aborted') expect(result.reason).toBe('pm_hours_disallowed');
  });

  it('boundary: 4:00am PT does NOT trip the guard (lower bound is inclusive)', async () => {
    // We can't easily prove "didn't abort" without a working supa stub —
    // but we can prove the guard didn't fire by checking that it BLOWS PAST
    // the guard and accesses supabase.rpc (which throws). A throw means the
    // guard let us through. Aborted-with-pm reason would mean the guard
    // tripped.
    const supa = makeStrictSupa();
    const fourAm = ptDate(2026, 5, 4, 4, 0);
    let threw = false;
    try {
      await runDailyStart(supa, { now: fourAm });
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });

  it('boundary: 11:59am PT does NOT trip the guard (upper bound is exclusive)', async () => {
    const supa = makeStrictSupa();
    const elevenFiftyNine = ptDate(2026, 5, 4, 11, 59);
    let threw = false;
    try {
      await runDailyStart(supa, { now: elevenFiftyNine });
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });

  it('boundary: 12:00pm PT DOES trip the guard (upper bound is exclusive — noon is PM)', async () => {
    const supa = makeStrictSupa();
    const noon = ptDate(2026, 5, 4, 12, 0);
    const result = await runDailyStart(supa, { now: noon });
    expect(result.kind).toBe('aborted');
  });

  it('legitimate slot times (5/6/7am PT) all pass the guard', async () => {
    for (const hour of [5, 6, 7]) {
      const supa = makeStrictSupa();
      const slotTime = ptDate(2026, 5, 4, hour, 0);
      let threw = false;
      try {
        await runDailyStart(supa, { now: slotTime });
      } catch {
        threw = true;
      }
      expect(threw).toBe(true);
    }
  });
});

describe('SAFETY_LIMITS for morning-only guards', () => {
  it('SLOT_GRACE_MINUTES is 30 (not generous enough to retro-trigger across hours)', () => {
    expect(SAFETY_LIMITS.SLOT_GRACE_MINUTES).toBe(30);
  });

  it('SEND_ALLOWED_PT_HOUR_MIN allows the legitimate slot times', () => {
    // Slots are 5/6/7 AM. Min=4 covers all of them with buffer for clock skew.
    expect(SAFETY_LIMITS.SEND_ALLOWED_PT_HOUR_MIN).toBeLessThanOrEqual(5);
  });

  it('SEND_ALLOWED_PT_HOUR_MAX excludes noon and beyond', () => {
    // Anything ≥12 must be blocked. The window is [MIN, MAX).
    expect(SAFETY_LIMITS.SEND_ALLOWED_PT_HOUR_MAX).toBeLessThanOrEqual(12);
  });

  it('the allowed window is strictly morning — covers AM slots, excludes any PM', () => {
    // Cross-invariant: window must allow all listed slots and exclude all PM.
    expect(SAFETY_LIMITS.SEND_ALLOWED_PT_HOUR_MIN).toBeLessThanOrEqual(5);  // 5am slot allowed
    expect(SAFETY_LIMITS.SEND_ALLOWED_PT_HOUR_MAX).toBeGreaterThanOrEqual(8);  // 7am slot + 30min grace
    expect(SAFETY_LIMITS.SEND_ALLOWED_PT_HOUR_MAX).toBeLessThanOrEqual(12);  // never PM
  });
});
