'use client';

// Admin-only "what's next" pool preview. Shows the next 2000 rows the
// daily cron would pull — same RPC the cron uses, so this is the
// exact upcoming send order.
//
// Three columns are starred ⭐ as the "required for a clean send"
// fields and are inline-editable Google-Sheets-style: click a cell,
// edit, press Enter or blur to save. PATCHes /api/cron/email-tool/
// pool-preview with the row id + changed fields. Optimistic UI on
// the cell — reverts on PATCH error.

import { useCallback, useEffect, useRef, useState } from 'react';

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

type EditableField = 'first_name' | 'company' | 'email';

const DEFAULT_LIMIT = 2000;

// Inline-editable cell. Renders as plain text until clicked; turns
// into an <input> on click; saves on Enter or blur (Escape cancels).
// Optimistically updates the parent's row state; reverts if onSave
// throws.
function EditableCell({
  value,
  rowId,
  field,
  onSave,
  isError,
  mono,
}: {
  value: string | null;
  rowId: string;
  field: EditableField;
  onSave: (rowId: string, field: EditableField, newVal: string | null) => Promise<void>;
  isError?: boolean;
  mono?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value ?? '');
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { setDraft(value ?? ''); }, [value]);
  useEffect(() => { if (editing) inputRef.current?.select(); }, [editing]);

  const commit = useCallback(async () => {
    if (!editing) return;
    const next = draft.trim();
    if (next === (value ?? '').trim()) { setEditing(false); return; }
    setSaving(true);
    try {
      await onSave(rowId, field, next === '' ? null : next);
      setEditing(false);
    } catch {
      // Revert on error.
      setDraft(value ?? '');
    } finally {
      setSaving(false);
    }
  }, [editing, draft, value, onSave, rowId, field]);

  const cancel = useCallback(() => {
    setDraft(value ?? '');
    setEditing(false);
  }, [value]);

  if (editing) {
    return (
      <input
        ref={inputRef}
        value={draft}
        onChange={e => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={e => {
          if (e.key === 'Enter') { e.preventDefault(); commit(); }
          else if (e.key === 'Escape') { e.preventDefault(); cancel(); }
        }}
        disabled={saving}
        className={`w-full bg-yellow-50 border border-yellow-400 rounded px-1.5 py-0.5 text-sm outline-none ${mono ? 'font-mono text-xs' : ''}`}
      />
    );
  }

  return (
    <div
      onClick={() => setEditing(true)}
      title="Click to edit"
      className={`cursor-text rounded px-1.5 py-0.5 hover:bg-yellow-50 hover:ring-1 hover:ring-yellow-300 ${mono ? 'font-mono text-xs' : ''} ${isError ? 'text-red-600' : ''}`}
    >
      {value && value.trim() !== '' ? value : <span className="text-red-500 italic">missing</span>}
    </div>
  );
}

export default function PoolPreviewPage() {
  const [rows, setRows] = useState<PoolRow[] | null>(null);
  const [nextSequence, setNextSequence] = useState<number | null>(null);
  const [freshRemaining, setFreshRemaining] = useState<number | null>(null);
  const [limit, setLimit] = useState<number>(DEFAULT_LIMIT);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<string>('');
  const [refreshedAt, setRefreshedAt] = useState<Date | null>(null);
  const [saveStatus, setSaveStatus] = useState<string | null>(null);

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

  // Optimistic patch with revert-on-error.
  const handleCellSave = useCallback(async (rowId: string, field: EditableField, newVal: string | null) => {
    // Snapshot the original value for revert.
    let original: string | null = null;
    setRows(prev => {
      if (!prev) return prev;
      return prev.map(r => {
        if (r.id !== rowId) return r;
        original = r[field] ?? null;
        return { ...r, [field]: newVal };
      });
    });
    setSaveStatus('saving…');
    const res = await fetch('/api/cron/email-tool/pool-preview', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: rowId, [field]: newVal }),
    });
    if (!res.ok) {
      // Revert.
      setRows(prev => prev?.map(r => r.id === rowId ? { ...r, [field]: original } : r) ?? null);
      setSaveStatus('save failed — reverted');
      setTimeout(() => setSaveStatus(null), 3000);
      throw new Error('PATCH failed');
    }
    setSaveStatus('saved');
    setTimeout(() => setSaveStatus(null), 1500);
  }, []);

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

  // Count rows missing any of the 3 required fields — useful header signal.
  const missingCount = (filtered ?? []).filter(r =>
    !r.first_name?.trim() || !r.company?.trim() || !r.email?.trim()
  ).length;

  return (
    <div className="min-h-screen bg-gray-50 p-6">
      <div className="max-w-7xl mx-auto">
        <header className="flex items-center justify-between mb-4">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">Pool preview — what&apos;s next</h1>
            <p className="text-sm text-gray-500 mt-1">
              Top {limit.toLocaleString()} rows of <code>email_pool</code> the daily cron will pull next, in send order.
              Starred (⭐) cells are <strong>required</strong> for a clean send and are click-to-edit.
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
          {missingCount > 0 && (
            <div className="bg-red-50 border border-red-200 text-red-700 rounded px-3 py-1.5">
              ⚠ {missingCount} row{missingCount === 1 ? '' : 's'} missing required field
            </div>
          )}
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
          {saveStatus && (
            <span className={`text-xs ${saveStatus.includes('fail') ? 'text-red-600' : 'text-emerald-700'}`}>
              {saveStatus}
            </span>
          )}
          {refreshedAt && !saveStatus && (
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
                  <th className="text-left px-3 py-2 font-mono w-16">#</th>
                  <th className="text-right px-3 py-2 font-mono w-20">seq</th>
                  <th className="text-left px-3 py-2 text-yellow-700">⭐ First name</th>
                  <th className="text-left px-3 py-2">Full name</th>
                  <th className="text-left px-3 py-2 text-yellow-700">⭐ Company</th>
                  <th className="text-left px-3 py-2 text-yellow-700">⭐ Email</th>
                </tr>
              </thead>
              <tbody>
                {!loading && filtered && filtered.length === 0 && (
                  <tr><td colSpan={6} className="text-center text-gray-400 py-8">no rows</td></tr>
                )}
                {filtered?.map((r, idx) => {
                  const missingFirst = !r.first_name?.trim();
                  const missingCompany = !r.company?.trim();
                  const missingEmail = !r.email?.trim();
                  const anyMissing = missingFirst || missingCompany || missingEmail;
                  return (
                    <tr key={r.id} className={`border-t border-gray-100 ${anyMissing ? 'bg-red-50/40' : 'hover:bg-gray-50'}`}>
                      <td className="px-3 py-1 text-gray-400 font-mono text-xs">{idx + 1}</td>
                      <td className="px-3 py-1 text-right font-mono text-xs tabular-nums text-gray-500">{r.sequence}</td>
                      <td className="px-2 py-1 text-gray-800">
                        <EditableCell value={r.first_name} rowId={r.id} field="first_name" onSave={handleCellSave} isError={missingFirst} />
                      </td>
                      <td className="px-3 py-1.5 text-gray-500 text-xs">{r.full_name ?? '—'}</td>
                      <td className="px-2 py-1 text-gray-800">
                        <EditableCell value={r.company} rowId={r.id} field="company" onSave={handleCellSave} isError={missingCompany} />
                      </td>
                      <td className="px-2 py-1 text-gray-700">
                        <EditableCell value={r.email} rowId={r.id} field="email" onSave={handleCellSave} isError={missingEmail} mono />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}
