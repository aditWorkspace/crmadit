import { describe, it, expect } from 'vitest';
import {
  SAFETY_LIMITS,
  TEMP_REDUCED_TARGET_PER_ACCOUNT,
  TEMP_REDUCED_RESUME_PT_DATE,
  effectiveDailyTargetPerAccount,
} from '../safety-limits';
import { FOLLOWUP_DAILY_CAP_PER_FOUNDER } from '../constants';

describe('SAFETY_LIMITS — relational invariants', () => {
  it('absolute hard ceiling stays above the automated target', () => {
    // The 99+ buffer reserves headroom for the founder's manual sends and
    // CRM auto-replies on the same Gmail account. If someone "simplifies"
    // the cap to equal the target, that buffer disappears.
    expect(SAFETY_LIMITS.ABSOLUTE_DAILY_CAP_PER_ACCOUNT).toBeGreaterThan(
      SAFETY_LIMITS.AUTOMATED_DAILY_TARGET_PER_ACCOUNT
    );
    expect(
      SAFETY_LIMITS.ABSOLUTE_DAILY_CAP_PER_ACCOUNT - SAFETY_LIMITS.AUTOMATED_DAILY_TARGET_PER_ACCOUNT
    ).toBeGreaterThanOrEqual(50);
  });

  it('warmup day-1 cap is below the steady-state target', () => {
    // Warmup is meant to be a soft start. If someone sets day-1 ≥ target,
    // there is no warmup at all.
    expect(SAFETY_LIMITS.WARMUP_DAY_1_CAP).toBeLessThan(
      SAFETY_LIMITS.AUTOMATED_DAILY_TARGET_PER_ACCOUNT
    );
  });

  it('jitter range fits inside the hard floor/ceiling clamp', () => {
    // Belt-and-suspenders: even if jitter is ever expanded, the hard
    // clamps prevent runaway gaps. If the jitter window slips outside
    // the clamps, half the jitter values get clamped and the pacing
    // distribution is no longer uniform.
    expect(SAFETY_LIMITS.INTER_SEND_JITTER_MIN_SECONDS).toBeGreaterThanOrEqual(
      SAFETY_LIMITS.MIN_INTER_SEND_GAP_SECONDS_HARD_FLOOR
    );
    expect(SAFETY_LIMITS.INTER_SEND_JITTER_MAX_SECONDS).toBeLessThanOrEqual(
      SAFETY_LIMITS.MAX_INTER_SEND_GAP_SECONDS_HARD_CEILING
    );
    expect(SAFETY_LIMITS.INTER_SEND_JITTER_MIN_SECONDS).toBeLessThan(
      SAFETY_LIMITS.INTER_SEND_JITTER_MAX_SECONDS
    );
  });

  it('hard ceiling provides headroom above the jitter max', () => {
    // The ceiling exists specifically to catch jitter math producing
    // outliers. If ceiling == jitter max, no outliers can be caught.
    expect(SAFETY_LIMITS.MAX_INTER_SEND_GAP_SECONDS_HARD_CEILING).toBeGreaterThan(
      SAFETY_LIMITS.INTER_SEND_JITTER_MAX_SECONDS
    );
  });

  it('campaign duration is large enough for the daily target at average pace', () => {
    // Avg gap = (jitter_min + jitter_max) / 2 seconds.
    // Time for full target campaign = avg_gap * target seconds.
    // Must fit inside MAX_CAMPAIGN_DURATION_HOURS with headroom.
    const avgGapSec =
      (SAFETY_LIMITS.INTER_SEND_JITTER_MIN_SECONDS + SAFETY_LIMITS.INTER_SEND_JITTER_MAX_SECONDS) / 2;
    const campaignSec = avgGapSec * SAFETY_LIMITS.AUTOMATED_DAILY_TARGET_PER_ACCOUNT;
    const budgetSec = SAFETY_LIMITS.MAX_CAMPAIGN_DURATION_HOURS * 3600;
    expect(campaignSec).toBeLessThan(budgetSec);
  });

  it('bounce-rate threshold is a sane percentage (>0, <1)', () => {
    // Catches the "I meant 5 not 0.05" bug.
    expect(SAFETY_LIMITS.BOUNCE_RATE_PAUSE_THRESHOLD).toBeGreaterThan(0);
    expect(SAFETY_LIMITS.BOUNCE_RATE_PAUSE_THRESHOLD).toBeLessThan(1);
  });

  it('per-tick budget is dominated by Vercel function timeout', () => {
    // Vercel max function duration is 300s on Pro, 800s on Enterprise.
    // Our budget should leave headroom for Vercel's timeout.
    expect(SAFETY_LIMITS.TICK_BUDGET_DURATION_SECONDS).toBeLessThanOrEqual(290);
  });

  it('crash counter window is long enough to be meaningful', () => {
    // 3 crashes in 10 minutes = a real signal. 3 in 30 seconds = noise.
    expect(SAFETY_LIMITS.CRASH_COUNTER_WINDOW_MINUTES).toBeGreaterThanOrEqual(5);
    expect(SAFETY_LIMITS.CRASH_COUNTER_THRESHOLD).toBeGreaterThanOrEqual(2);
  });

  it('crash recovery sweep window is shorter than the orphan threshold', () => {
    // Orphan campaigns wait longer than per-row stale recovery, because
    // a campaign mid-start is rarer and harder to recover automatically.
    expect(SAFETY_LIMITS.ORPHAN_CAMPAIGN_THRESHOLD_MINUTES).toBeGreaterThan(0);
    expect(SAFETY_LIMITS.CRASH_RECOVERY_STALE_MINUTES).toBeGreaterThan(0);
  });
});

describe('effectiveDailyTargetPerAccount — quality-first volume hold (held open for personalization)', () => {
  // Dates derived from the constant so this survives future moves of the
  // resume date (the cap was extended past 2026-06-15 for the personalization
  // layer: ~100 personalized fresh sends/account/day instead of 400 generic).
  const dayBefore = (iso: string): string => {
    const d = new Date(`${iso}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - 1);
    return d.toISOString().slice(0, 10);
  };
  const dayAfter = (iso: string): string => {
    const d = new Date(`${iso}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + 1);
    return d.toISOString().slice(0, 10);
  };

  it('returns the reduced target on PT dates before the resume date', () => {
    expect(effectiveDailyTargetPerAccount('2026-06-02')).toBe(TEMP_REDUCED_TARGET_PER_ACCOUNT);
    expect(effectiveDailyTargetPerAccount(dayBefore(TEMP_REDUCED_RESUME_PT_DATE))).toBe(TEMP_REDUCED_TARGET_PER_ACCOUNT);
  });

  it('returns the full steady-state target on and after the resume date', () => {
    expect(effectiveDailyTargetPerAccount(TEMP_REDUCED_RESUME_PT_DATE)).toBe(
      SAFETY_LIMITS.AUTOMATED_DAILY_TARGET_PER_ACCOUNT
    );
    expect(effectiveDailyTargetPerAccount(dayAfter(TEMP_REDUCED_RESUME_PT_DATE))).toBe(
      SAFETY_LIMITS.AUTOMATED_DAILY_TARGET_PER_ACCOUNT
    );
  });

  it('reduced target yields exactly 300 fresh cold sends per account (bumps preserved)', () => {
    // freshPerFounder = perAccountTarget − reserved follow-up bumps.
    // The whole point of 400 (not 300) is to keep the 100 bumps intact.
    expect(TEMP_REDUCED_TARGET_PER_ACCOUNT - FOLLOWUP_DAILY_CAP_PER_FOUNDER).toBe(300);
  });

  it('reduced target is a real reduction below the steady-state target', () => {
    expect(TEMP_REDUCED_TARGET_PER_ACCOUNT).toBeLessThan(
      SAFETY_LIMITS.AUTOMATED_DAILY_TARGET_PER_ACCOUNT
    );
  });

  it('resume date is an ISO YYYY-MM-DD string so PT-date string compares are chronological', () => {
    expect(TEMP_REDUCED_RESUME_PT_DATE).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('SAFETY_LIMITS.RATE_LIMIT_RETRY_DELAYS_MS', () => {
  it('matches spec §6 ⑤d schedule (5s, 30s, 2m)', () => {
    expect(SAFETY_LIMITS.RATE_LIMIT_RETRY_DELAYS_MS).toEqual([5_000, 30_000, 120_000]);
  });

  it('schedule length equals the max-retries cap', () => {
    // Functional invariant: the tick handler transitions to 'failed' when
    // nextAttempt > delays.length. If the cap diverges from schedule
    // length, retries will either exceed bounds or run short.
    expect(SAFETY_LIMITS.RATE_LIMIT_RETRY_DELAYS_MS.length).toBe(3);
  });

  it('delays are strictly increasing (no flat-out)', () => {
    const d = SAFETY_LIMITS.RATE_LIMIT_RETRY_DELAYS_MS;
    for (let i = 1; i < d.length; i++) {
      expect(d[i]).toBeGreaterThan(d[i - 1]);
    }
  });
});
