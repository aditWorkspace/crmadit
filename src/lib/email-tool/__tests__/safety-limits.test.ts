import { describe, it, expect } from 'vitest';
import { SAFETY_LIMITS } from '../safety-limits';

describe('SAFETY_LIMITS', () => {
  it('caps automated daily target at 400 per account', () => {
    expect(SAFETY_LIMITS.AUTOMATED_DAILY_TARGET_PER_ACCOUNT).toBe(400);
  });

  it('absolute hard ceiling reserves 99-send buffer above target', () => {
    expect(SAFETY_LIMITS.ABSOLUTE_DAILY_CAP_PER_ACCOUNT).toBe(499);
    expect(SAFETY_LIMITS.ABSOLUTE_DAILY_CAP_PER_ACCOUNT).toBeGreaterThan(
      SAFETY_LIMITS.AUTOMATED_DAILY_TARGET_PER_ACCOUNT
    );
  });

  it('jitter range is 5-15s with hard floor/ceiling clamp', () => {
    expect(SAFETY_LIMITS.INTER_SEND_JITTER_MIN_SECONDS).toBe(5);
    expect(SAFETY_LIMITS.INTER_SEND_JITTER_MAX_SECONDS).toBe(15);
    expect(SAFETY_LIMITS.MIN_INTER_SEND_GAP_SECONDS_HARD_FLOOR).toBe(5);
    expect(SAFETY_LIMITS.MAX_INTER_SEND_GAP_SECONDS_HARD_CEILING).toBe(30);
  });

  it('warmup day 1 is 250/account', () => {
    expect(SAFETY_LIMITS.WARMUP_DAY_1_CAP).toBe(250);
  });

  it('bounce-rate auto-pause threshold is 5%', () => {
    expect(SAFETY_LIMITS.BOUNCE_RATE_PAUSE_THRESHOLD).toBe(0.05);
  });
});
