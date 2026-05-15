'use client';

// Admin-only "what's next" pool preview. Shows the next 2000 rows the
// daily cron would pull — same RPC the cron uses, so this is the
// exact upcoming send order.

import { useCallback, useEffect, useState } from 'react';

interface PoolRow {
  id: string;
  sequence: number;
  company: string | null;
  full_name: string | null;
  email: string;
  first_name: string | null;
}

interface ApiResp {
  rows?: PoolRow[];
  next_sequence?: number | null;
  fresh_remaining?: number | null;
  limit?: number;
  error?: string;
}

const DEFAULT_LIMIT = 2000;

export default function PoolPreviewPage() {
  const [rows, setRows] = useState<PoolRow[] | null>(null);
  const [nextSequence, setNextSequence] = useState<number | null>(null);
  const [freshRemaining, setFreshRemaining] = useState<number | null>(null);
  const [limit, setLimit] = useState<number>(DEFAULT_LIMIT);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<string>('');
  const [refreshedAt, setRefreshedAt] = useState<Date | null>(null);

  const fetchRows = useCallback(async (n: number) => {
    setLoading(true);
    setError(null);
    try {
      const r = (await fetch(`/api/cron/email-tool/pool-preview?limit=${n}`).then(r => r.json())) as ApiResp;
      if (r.error) { setError(r.error); return; }
      setRows(r.rows ?? []);
      setNextSequence(r.next_sequence ?? null);
      setFreshRemaining(r.fresh_remaining ?? null);
      setRefreshedAt(new Date());
    } catch {
      setError('network error');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchRows(limit); }, [fetchRows, limit]);

  const filtered = rows?.filter(r => {
    if (!filter) return true;
    const q = filter.toLowerCase();
    return (
      (r.first_name ?? '').toLowerCase().includes(q) ||
      (r.full_name ?? '').toLowerCase().includes(q) ||
      (r.company ?? '').toLowerCase().includes(q) ||
      r.email.toLowerCase().includes(q)
    );
  }) ?? null;

  return (
    <div className="min-h-screen bg-gray-50 p-6">
      <div className="max-w-6xl mx-auto">
        <header className="flex items-center justify-between mb-4">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">Pool preview — what's next</h1>
            <p className="text-sm text-gray-500 mt-1">
              Top {limit.toLocaleString()} rows of <code>email_pool</code> that the daily cron will pull next, in send order.
              Reflects current blacklist filtering. Read-only — opening this page changes nothing.
            </p>
          </div>
          <a href="/email-tool" className="text-xs text-gray-500 hover:text-gray-800">← back to email tool</a>
        </header>

        <div className="flex flex-wrap items-center gap-3 mb-4 text-sm">
          <div className="bg-white border border-gray-200 rounded px-3 py-1.5">
            <span className="text-gray-500">Pointer:</span>{' '}
            <span className="font-mono">{nextSequence ?? '?'}</span>
          </div>
          <div className="bg-white border border-gray-200 rounded px-3 py-1.5">
            <span className="text-gray-500">Fresh remaining:</span>{' '}
            <span className="font-mono">{freshRemaining?.toLocaleString() ?? '?'}</span>
          </div>
          <div className="bg-white border border-gray-200 rounded px-3 py-1.5">
            <span className="text-gray-500">Showing:</span>{' '}
            <span className="font-mono">{filtered?.length.toLocaleString() ?? 0}</span>
            {filter && rows && filtered && filtered.length !== rows.length && (
              <span className="text-gray-400"> of {rows.length.toLocaleString()}</span>
            )}
          </div>
          <input
            value={filter}
            onChange={e => setFilter(e.target.value)}
            placeholder="filter by name / company / email…"
            className="flex-1 min-w-[200px] border border-gray-300 rounded px-2 py-1 text-sm"
          />
          <select
            value={limit}
            onChange={e => setLimit(parseInt(e.target.value, 10))}
            className="border border-gray-300 rounded px-2 py-1 text-sm bg-white"
          >
            <option value="500">Top 500</option>
            <option value="1000">Top 1000</option>
            <option value="2000">Top 2000</option>
            <option value="5000">Top 5000</option>
          </select>
          <button
            onClick={() => fetchRows(limit)}
            disabled={loading}
            className="px-3 py-1.5 bg-gray-900 text-white rounded text-sm hover:bg-gray-800 disabled:opacity-50"
          >
            {loading ? 'loading…' : 'refresh'}
          </button>
          {refreshedAt && (
            <span className="text-xs text-gray-400">refreshed {refreshedAt.toLocaleTimeString()}</span>
          )}
        </div>

        {error && (
          <div className="bg-red-50 border border-red-200 text-red-700 rounded px-3 py-2 text-sm mb-3">{error}</div>
        )}

        <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
          <div className="overflow-x-auto max-h-[75vh] overflow-y-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-xs uppercase tracking-wider text-gray-500 sticky top-0 z-10">
                <tr>
                  <th className="text-left px-3 py-2 font-mono w-20">#</th>
                  <th className="text-right px-3 py-2 font-mono w-24">seq</th>
                  <th className="text-left px-3 py-2">First name</th>
                  <th className="text-left px-3 py-2">Full name</th>
                  <th className="text-left px-3 py-2">Company</th>
                  <th className="text-left px-3 py-2">Email</th>
                </tr>
              </thead>
              <tbody>
                {!loading && filtered && filtered.length === 0 && (
                  <tr><td colSpan={6} className="text-center text-gray-400 py-8">no rows</td></tr>
                )}
                {filtered?.map((r, idx) => (
                  <tr key={r.id} className="border-t border-gray-100 hover:bg-gray-50">
                    <td className="px-3 py-1.5 text-gray-400 font-mono text-xs">{idx + 1}</td>
                    <td className="px-3 py-1.5 text-right font-mono text-xs tabular-nums">{r.sequence}</td>
                    <td className="px-3 py-1.5 text-gray-800">{r.first_name ?? '—'}</td>
                    <td className="px-3 py-1.5 text-gray-600">{r.full_name ?? '—'}</td>
                    <td className="px-3 py-1.5 text-gray-800">{r.company ?? '—'}</td>
                    <td className="px-3 py-1.5 text-gray-700 font-mono text-xs">{r.email}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}
