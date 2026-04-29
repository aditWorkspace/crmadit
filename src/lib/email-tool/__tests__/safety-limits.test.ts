import { describe, it, expect } from 'vitest';
import { SAFETY_LIMITS } from '../safety-limits';

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
