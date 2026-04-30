import type { FilterSpec } from './types';

const DEFAULT_N = 20;
const MAX_N = 50;
const STUFFED_CUTOFF = 10;

export function clampN(n: number | null): number {
  if (n === null || n === undefined) return DEFAULT_N;
  if (!Number.isFinite(n)) return DEFAULT_N;
  if (n < 1) return 1;
  if (n > MAX_N) return MAX_N;
  return Math.floor(n);
}

export type FilterMode = 'stuffed' | 'fan-out';

export function decideFilterMode(args: {
  criterion_type: FilterSpec['criterion_type'];
  n: number;
}): FilterMode {
  if (args.criterion_type === 'factual' && args.n <= STUFFED_CUTOFF) return 'stuffed';
  return 'fan-out';
}

export interface FilterMatch {
  company: string;
  contact: string;
  date: string;     // YYYY-MM-DD
  evidence: string;
}

export function renderFilterMarkdown(args: {
  checked: number;
  criterion: string;
  matches: FilterMatch[];
  failures: number;
}): string {
  const { checked, criterion, matches, failures } = args;
  const parts: string[] = [];

  if (matches.length === 0) {
    parts.push(
      `**Checked ${checked} call${checked === 1 ? '' : 's'}. None matched the criterion: "${criterion}".**`,
    );
  } else {
    parts.push(
      `**Checked ${checked} call${checked === 1 ? '' : 's'} — ${matches.length} matched.**`,
    );
    parts.push('');
    for (const m of matches) {
      parts.push(`- **${m.company}** (${m.contact}, ${m.date}) — "${m.evidence}"`);
    }
  }

  if (failures > 0) {
    parts.push('');
    parts.push(
      `_(${failures} transcript${failures === 1 ? '' : 's'} could not be evaluated this run.)_`,
    );
  }

  return parts.join('\n');
}

// Settled-result shape so callers can distinguish failures without try/catch
// per item.
export type Settled<T> =
  | { ok: true; value: T }
  | { ok: false; error: Error };

// Bounded-concurrency map. Preserves input order in the result array. Each
// task is awaited; failures become { ok: false } entries instead of throwing.
export async function runWithConcurrency<I, O>(
  items: I[],
  concurrency: number,
  fn: (item: I, index: number) => Promise<O>,
): Promise<Settled<O>[]> {
  const results: Settled<O>[] = new Array(items.length);
  let cursor = 0;

  async function worker() {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      try {
        const value = await fn(items[i], i);
        results[i] = { ok: true, value };
      } catch (err) {
        results[i] = { ok: false, error: err instanceof Error ? err : new Error(String(err)) };
      }
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}
