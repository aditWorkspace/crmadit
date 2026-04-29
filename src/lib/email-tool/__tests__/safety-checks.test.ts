import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  checkBounceRate,
  checkPerSecondPace,
  checkRecipientDomainOnce,
  checkReplySinceQueue,
  checkActiveVariant,
} from '../safety-checks';

// Build a chainable Supabase-style query mock. Each terminal method
// (maybeSingle, single, eq, etc.) returns the chain so .eq().eq()...
// works. The "result" object is what await on the chain resolves to.
function makeChainable(result: unknown) {
  const chain: Record<string, unknown> = {
    select: () => chain,
    eq: () => chain,
    gte: () => chain,
    ilike: () => chain,
    order: () => chain,
    limit: () => chain,
    maybeSingle: () => Promise.resolve(result),
    single: () => Promise.resolve(result),
    then: (onFulfilled: (v: unknown) => unknown) => Promise.resolve(result).then(onFulfilled),
  };
  return chain;
}

function makeSupa(opts: {
  rpc?: (name: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>;
  fromResults?: Record<string, unknown>;
}) {
  return {
    rpc: opts.rpc ?? (async () => ({ data: null, error: null })),
    from: (table: string) => makeChainable(opts.fromResults?.[table] ?? { data: null, error: null, count: 0 }),
  } as unknown as ReturnType<typeof import('@/lib/supabase/admin').createAdminClient>;
}

describe('checkBounceRate', () => {
  it('returns ok when rate is below threshold', async () => {
    const supa = makeSupa({
      rpc: async () => ({ data: { sent: 100, bounces: 3, rate: 0.03 }, error: null }),
    });
    const v = await checkBounceRate(supa, 'tm-1');
    expect(v.ok).toBe(true);
  });

  it('returns pause_account when rate exceeds 5%', async () => {
    const supa = makeSupa({
      rpc: async () => ({ data: { sent: 100, bounces: 7, rate: 0.07 }, error: null }),
    });
    const v = await checkBounceRate(supa, 'tm-1');
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.outcome).toBe('pause_account');
      expect(v.reason).toContain('7.0%');
      expect(v.reason).toContain('5%');
    }
  });

  it('boundary: rate of exactly 5% does NOT trigger pause (uses strict >)', async () => {
    const supa = makeSupa({
      rpc: async () => ({ data: { sent: 100, bounces: 5, rate: 0.05 }, error: null }),
    });
    const v = await checkBounceRate(supa, 'tm-1');
    expect(v.ok).toBe(true);
  });

  it('fail-open when RPC errors (rate unknown — don\'t halt the pipeline)', async () => {
    const supa = makeSupa({
      rpc: async () => ({ data: null, error: { message: 'rpc died' } }),
    });
    const v = await checkBounceRate(supa, 'tm-1');
    expect(v.ok).toBe(true);
  });
});

describe('checkActiveVariant', () => {
  it('returns ok when founder has at least one active variant', async () => {
    const supa = makeSupa({
      fromResults: { email_template_variants: { count: 2, error: null } },
    });
    const v = await checkActiveVariant(supa, 'tm-1');
    expect(v.ok).toBe(true);
  });

  it('returns fail when founder has zero active variants', async () => {
    const supa = makeSupa({
      fromResults: { email_template_variants: { count: 0, error: null } },
    });
    const v = await checkActiveVariant(supa, 'tm-1');
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.outcome).toBe('fail');
      expect(v.reason).toBe('no_active_variants');
    }
  });
});

describe('checkPerSecondPace', () => {
  it('returns ok when no previous sends exist', async () => {
    const supa = makeSupa({
      fromResults: { email_send_queue: { data: null, error: null } },
    });
    const v = await checkPerSecondPace(supa, 'tm-1');
    expect(v.ok).toBe(true);
  });

  it('returns ok when last send was >5s ago', async () => {
    const tenSecondsAgo = new Date(Date.now() - 10_000).toISOString();
    const supa = makeSupa({
      fromResults: { email_send_queue: { sent_at: tenSecondsAgo } },
    });
    const v = await checkPerSecondPace(supa, 'tm-1');
    expect(v.ok).toBe(true);
  });

  it('returns defer when last send was <5s ago', async () => {
    const twoSecondsAgo = new Date(Date.now() - 2_000).toISOString();
    const supa = makeSupa({
      fromResults: { email_send_queue: { sent_at: twoSecondsAgo } },
    });
    const v = await checkPerSecondPace(supa, 'tm-1');
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.outcome).toBe('defer');
      expect(v.defer_seconds).toBe(15);
    }
  });
});
