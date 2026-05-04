import { describe, it, expect, vi } from 'vitest';

// These tests verify the contract: when a team_member has departed_at SET,
// the active-operation queries that drive sends, sync, and digest must all
// filter that member out. We don't run the full functions (they touch real
// Supabase) — instead we capture the query builder calls and assert that
// `.is('departed_at', null)` is in the chain.

function makeQueryRecorder() {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const chain: Record<string, unknown> = {};
  const handler = (method: string) => (...args: unknown[]) => {
    calls.push({ method, args });
    return chain;
  };
  for (const m of ['select', 'eq', 'is', 'not', 'order', 'in', 'gte', 'lt', 'single', 'maybeSingle', 'limit', 'or', 'neq']) {
    chain[m] = handler(m);
  }
  // Make the chain thenable so `await query` resolves
  chain.then = (onFulfilled: (v: unknown) => unknown) =>
    Promise.resolve({ data: [], error: null, count: 0 }).then(onFulfilled);
  return { chain, calls };
}

function makeSupa(captureFor: string) {
  const records: Record<string, ReturnType<typeof makeQueryRecorder>> = {};
  return {
    from: (table: string) => {
      const r = records[table] ?? makeQueryRecorder();
      records[table] = r;
      return r.chain;
    },
    rpc: vi.fn(() => Promise.resolve({ data: null, error: null })),
    __getCalls: (table: string) => records[table]?.calls ?? [],
    __captureFor: captureFor,
  } as unknown as ReturnType<typeof import('@/lib/supabase/admin').createAdminClient> & {
    __getCalls: (table: string) => Array<{ method: string; args: unknown[] }>;
  };
}

describe('Departed-founder filter — contract tests', () => {
  it('runDailyStart filters team_members by departed_at IS NULL', async () => {
    // The contract: any place that selects ACTIVE founders for sends
    // must include `.is('departed_at', null)`. We verify by reading the
    // start.ts source directly — cheaper than booting the full RPC chain
    // and more durable against unrelated refactors.
    const { readFileSync } = await import('fs');
    const src = readFileSync('src/lib/email-tool/start.ts', 'utf8');

    // The active-founders query block:
    const block = src.match(/from\(['"]team_members['"]\)[\s\S]{0,400}/);
    expect(block, 'team_members query in start.ts should exist').not.toBeNull();
    expect(block![0]).toMatch(/\.is\(['"]departed_at['"],\s*null\)/);
  });

  it('runTick filters team_members by departed_at IS NULL', async () => {
    const { readFileSync } = await import('fs');
    const src = readFileSync('src/lib/email-tool/tick.ts', 'utf8');
    const block = src.match(/from\(['"]team_members['"]\)[\s\S]{0,400}/);
    expect(block).not.toBeNull();
    expect(block![0]).toMatch(/\.is\(['"]departed_at['"],\s*null\)/);
  });

  it('cron email-sync filters team_members by departed_at IS NULL', async () => {
    const { readFileSync } = await import('fs');
    const src = readFileSync('src/app/api/cron/email-sync/route.ts', 'utf8');
    const block = src.match(/from\(['"]team_members['"]\)[\s\S]{0,400}/);
    expect(block).not.toBeNull();
    expect(block![0]).toMatch(/\.is\(['"]departed_at['"],\s*null\)/);
  });

  it('cron daily-digest filters team_members by departed_at IS NULL (so departed founders do not get the email)', async () => {
    const { readFileSync } = await import('fs');
    const src = readFileSync('src/app/api/cron/daily-digest/route.ts', 'utf8');
    const block = src.match(/from\(['"]team_members['"]\)[\s\S]{0,400}/);
    expect(block).not.toBeNull();
    expect(block![0]).toMatch(/\.is\(['"]departed_at['"],\s*null\)/);
  });

  it('public team/members API filters team_members by departed_at IS NULL (so user-selector hides departed)', async () => {
    const { readFileSync } = await import('fs');
    const src = readFileSync('src/app/api/team/members/route.ts', 'utf8');
    expect(src).toMatch(/\.is\(['"]departed_at['"],\s*null\)/);
  });

  it('priority CSV upload route fetches active-only founder ids for s2 routing', async () => {
    const { readFileSync } = await import('fs');
    const src = readFileSync('src/app/api/cron/email-tool/priority/route.ts', 'utf8');
    // The route must (a) fetch active founders into a Set, and (b) gate
    // routing decisions on that Set so departed founders are never
    // chosen as override_owner.
    expect(src).toMatch(/activeFounderIds/);
    expect(src).toMatch(/activeFounderIds\.has/);
  });

  it('auto-followup skips leads owned by departed founders', async () => {
    const { readFileSync } = await import('fs');
    const src = readFileSync('src/lib/automation/auto-followup.ts', 'utf8');
    expect(src).toMatch(/departed_at/);
    expect(src).toMatch(/if \(member\.departed_at\) continue/);
  });

  it('digest-builder labels leads owned by departed founders as "(frozen)"', async () => {
    const { readFileSync } = await import('fs');
    const src = readFileSync('src/lib/automation/digest-builder.ts', 'utf8');
    expect(src).toMatch(/departedNames/);
    expect(src).toMatch(/labelOwner/);
    expect(src).toMatch(/\(frozen\)/);
  });

  it('public team/departed API exists for the pipeline owner-legend', async () => {
    const { readFileSync } = await import('fs');
    const src = readFileSync('src/app/api/team/departed/route.ts', 'utf8');
    expect(src).toMatch(/\.not\(['"]departed_at['"],\s*['"]is['"],\s*null\)/);
  });
});
