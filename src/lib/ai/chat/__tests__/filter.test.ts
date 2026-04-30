import { describe, it, expect, vi } from 'vitest';
import {
  clampN,
  decideFilterMode,
  renderFilterMarkdown,
  runWithConcurrency,
} from '../filter';

describe('clampN', () => {
  it('defaults null to 20', () => {
    expect(clampN(null)).toBe(20);
  });
  it('clamps above 50', () => {
    expect(clampN(1000)).toBe(50);
  });
  it('clamps below 1', () => {
    expect(clampN(0)).toBe(1);
    expect(clampN(-5)).toBe(1);
  });
  it('passes through valid N', () => {
    expect(clampN(15)).toBe(15);
  });
});

describe('decideFilterMode', () => {
  it('stuffed for factual + small N', () => {
    expect(decideFilterMode({ criterion_type: 'factual', n: 5 })).toBe('stuffed');
    expect(decideFilterMode({ criterion_type: 'factual', n: 10 })).toBe('stuffed');
  });
  it('fan-out for factual + large N', () => {
    expect(decideFilterMode({ criterion_type: 'factual', n: 11 })).toBe('fan-out');
  });
  it('fan-out for semantic regardless of N', () => {
    expect(decideFilterMode({ criterion_type: 'semantic', n: 1 })).toBe('fan-out');
    expect(decideFilterMode({ criterion_type: 'semantic', n: 50 })).toBe('fan-out');
  });
});

describe('renderFilterMarkdown', () => {
  it('renders matches', () => {
    const out = renderFilterMarkdown({
      checked: 20,
      criterion: 'worried about privacy',
      matches: [
        { company: 'Ramp', contact: 'Alex', date: '2026-04-12', evidence: 'asked about SOC2' },
        { company: 'Linear', contact: 'Sara', date: '2026-04-15', evidence: 'wants data sheet' },
      ],
      failures: 0,
    });
    expect(out).toContain('Checked 20');
    expect(out).toContain('2 matched');
    expect(out).toContain('Ramp');
    expect(out).toContain('asked about SOC2');
  });

  it('renders zero matches with the criterion echoed', () => {
    const out = renderFilterMarkdown({
      checked: 20,
      criterion: 'mentioned Linear',
      matches: [],
      failures: 0,
    });
    expect(out).toMatch(/None matched/i);
    expect(out).toContain('mentioned Linear');
  });

  it('appends a footer when some calls failed', () => {
    const out = renderFilterMarkdown({
      checked: 20,
      criterion: 'X',
      matches: [{ company: 'A', contact: 'B', date: '2026-04-01', evidence: 'e' }],
      failures: 3,
    });
    expect(out).toMatch(/3 transcripts could not be evaluated/);
  });
});

describe('runWithConcurrency', () => {
  it('limits in-flight calls to the cap', async () => {
    let inFlight = 0;
    let maxSeen = 0;
    const items = Array.from({ length: 12 }, (_, i) => i);

    const results = await runWithConcurrency(items, 4, async (i) => {
      inFlight += 1;
      maxSeen = Math.max(maxSeen, inFlight);
      await new Promise(r => setTimeout(r, 5));
      inFlight -= 1;
      return i * 2;
    });

    expect(results).toEqual([
      { ok: true, value: 0 },
      { ok: true, value: 2 },
      { ok: true, value: 4 },
      { ok: true, value: 6 },
      { ok: true, value: 8 },
      { ok: true, value: 10 },
      { ok: true, value: 12 },
      { ok: true, value: 14 },
      { ok: true, value: 16 },
      { ok: true, value: 18 },
      { ok: true, value: 20 },
      { ok: true, value: 22 },
    ]);
    expect(maxSeen).toBeLessThanOrEqual(4);
  });

  it('captures failures via Promise.allSettled semantics', async () => {
    const results = await runWithConcurrency([1, 2, 3], 2, async (i) => {
      if (i === 2) throw new Error('boom');
      return i * 10;
    });

    expect(results[0]).toEqual({ ok: true, value: 10 });
    expect(results[1]).toEqual({ ok: false, error: expect.any(Error) });
    expect(results[2]).toEqual({ ok: true, value: 30 });
  });
});
