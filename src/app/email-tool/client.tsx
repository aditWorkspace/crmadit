'use client';

// Faithful clone of /Users/adit/emailsendingasa/app/dashboard/client.tsx,
// with the two known diffs:
//   - CRM session replaces iron-session (gating happens in page.tsx).
//   - 5-min auto-logout dropped (CRM session handles idle timeout, and
//     the standalone's Log out link is also dropped — global nav has it).
//
// Visual style adapted to the CRM's white-card aesthetic instead of the
// standalone's full-screen black. Interaction model preserved verbatim:
// the same button labels, countdown format, history rendering, error
// surfaces, and admin-only sections.

import { useEffect, useRef, useState } from 'react';
import { Loader2, ExternalLink, Target, Upload } from '@/lib/icons';

interface HistoryEntry {
  id: string;
  url: string;
  title: string | null;
  created_at: string;
  created_by?: string;
}

interface UploadResult {
  filesParsed: number;
  uniqueEmailsFound: number;
  newlyAdded: number;
  totalAfter: number;
  freshRemaining: number;
}

type BatchResponse =
  | { ok: true; url: string; nextAvailable: string; remaining: number; newEntry: HistoryEntry }
  | { ok: false; reason: 'cooldown'; retryAt: string }
  | { ok: false; reason: 'exhausted'; remaining: number }
  | { ok: false; reason: 'sheet_error'; detail?: string }
  | { ok: false; reason: 'unauthenticated' }
  | { ok: false; reason: 'unknown'; detail?: string };

interface Props {
  name: string;
  cooldownIso: string | null;
  remaining: number;
  history: HistoryEntry[];
  isAdmin: boolean;
  blacklistSize: number;
}

export default function EmailToolClient({
  name,
  cooldownIso,
  remaining: initialRemaining,
  history: initialHistory,
  isAdmin,
  blacklistSize: initialBlacklistSize,
}: Props) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [batchUrl, setBatchUrl] = useState<string | null>(null);
  const [nextAvailable, setNextAvailable] = useState<string | null>(cooldownIso);
  const [remaining, setRemaining] = useState(initialRemaining);
  const [history, setHistory] = useState<HistoryEntry[]>(initialHistory);
  const [now, setNow] = useState<Date | null>(null);

  const [blacklistSize, setBlacklistSize] = useState(initialBlacklistSize);
  const [uploading, setUploading] = useState(false);
  const [uploadResult, setUploadResult] = useState<UploadResult | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Reversal state — one batch ID at a time may be in flight.
  const [reversingId, setReversingId] = useState<string | null>(null);
  const [reverseError, setReverseError] = useState<string | null>(null);

  // Upload + filter (admin). Default behavior: add survivors to the
  // pool. The "put at top" checkbox toggles between pool_top (sent next)
  // and pool_bottom (sent after everything else). The legacy
  // blacklist-only mode lives in the separate "Blacklist upload" section
  // above — it's not surfaced here anymore.
  type FilterMode = 'blacklist' | 'pool_top' | 'pool_bottom';
  const [putAtTop, setPutAtTop] = useState<boolean>(true);
  const filterMode: FilterMode = putAtTop ? 'pool_top' : 'pool_bottom';
  const [filtering, setFiltering] = useState(false);
  const [filterResult, setFilterResult] = useState<{
    mode: FilterMode;
    inputRows: number;
    outputRows: number;
    skippedNoEmail: number;
    skippedNameMismatch: number;
    alreadyBlacklisted: number;
    newlyBlacklisted: number;
    poolInserted: number;
    alreadyInPool: number;
  } | null>(null);
  const [filterError, setFilterError] = useState<string | null>(null);
  const filterInputRef = useRef<HTMLInputElement>(null);

  // Tick the clock so the cooldown countdown updates live without a
  // page reload, and the button re-enables the moment cooldown expires.
  useEffect(() => {
    setNow(new Date());
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  const cooldownDate = nextAvailable ? new Date(nextAvailable) : null;
  const onCooldown = !!(now && cooldownDate && now < cooldownDate);

  async function getBatch() {
    setLoading(true);
    setError(null);
    setBatchUrl(null);
    try {
      const res = await fetch('/api/cron/email-tool/batch', { method: 'POST' });
      const data: BatchResponse = await res.json();

      if (data.ok) {
        setBatchUrl(data.url);
        setNextAvailable(data.nextAvailable);
        setRemaining(data.remaining);
        setHistory(prev => [data.newEntry, ...prev].slice(0, 50));
        // Auto-open + visible card. Don't rely on auto-open alone —
        // popup blockers will eat it on some browsers.
        window.open(data.url, '_blank', 'noopener,noreferrer');
      } else if (data.reason === 'cooldown') {
        setNextAvailable(data.retryAt);
      } else if (data.reason === 'exhausted') {
        setError('Pool is empty. Tell Adit to add more.');
      } else if (data.reason === 'unauthenticated') {
        setError('Session expired. Refresh and log in again.');
      } else if (data.reason === 'sheet_error') {
        setError(`Sheet creation failed: ${data.detail ?? 'unknown error'}`);
      } else {
        setError(data.detail ?? 'Something went wrong. Try again.');
      }
    } catch {
      setError('Network error. Try again.');
    } finally {
      setLoading(false);
    }
  }

  async function filterCsv(file: File, mode: FilterMode) {
    setFiltering(true);
    setFilterError(null);
    setFilterResult(null);
    try {
      const form = new FormData();
      form.append('file', file);
      form.append('mode', mode);
      const res = await fetch('/api/cron/email-tool/csv-filter', { method: 'POST', body: form });
      if (!res.ok) {
        // Error responses are JSON with { ok: false, reason }.
        let reason = `http ${res.status}`;
        try {
          const j = await res.json();
          if (j && typeof j.reason === 'string') {
            reason = j.detail ? `${j.reason}: ${j.detail}` : j.reason;
          }
        } catch {}
        setFilterError(reason);
        return;
      }

      const inputRows = Number(res.headers.get('X-Input-Rows') ?? '0');
      const outputRows = Number(res.headers.get('X-Output-Rows') ?? '0');
      const skippedNoEmail = Number(res.headers.get('X-Skipped-No-Email') ?? '0');
      const skippedNameMismatch = Number(res.headers.get('X-Skipped-Name-Mismatch') ?? '0');
      const alreadyBlacklisted = Number(res.headers.get('X-Already-Blacklisted') ?? '0');
      const newlyBlacklisted = Number(res.headers.get('X-Newly-Blacklisted') ?? '0');
      const poolInserted = Number(res.headers.get('X-Pool-Inserted') ?? '0');
      const alreadyInPool = Number(res.headers.get('X-Already-In-Pool') ?? '0');

      // Trigger the browser download.
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const cd = res.headers.get('Content-Disposition') ?? '';
      const m = cd.match(/filename="([^"]+)"/);
      const filename = m ? m[1] : 'filtered.csv';
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      // Defer revoke a tick so Safari/Firefox finish the download trigger.
      setTimeout(() => URL.revokeObjectURL(url), 1000);

      setFilterResult({
        mode,
        inputRows,
        outputRows,
        skippedNoEmail,
        skippedNameMismatch,
        alreadyBlacklisted,
        newlyBlacklisted,
        poolInserted,
        alreadyInPool,
      });
      if (newlyBlacklisted > 0) setBlacklistSize(prev => prev + newlyBlacklisted);
      if (poolInserted > 0) setRemaining(prev => prev + poolInserted);
    } catch {
      setFilterError('network error');
    } finally {
      setFiltering(false);
      if (filterInputRef.current) filterInputRef.current.value = '';
    }
  }

  async function reverseBatch(h: HistoryEntry) {
    const label = h.title ?? formatEntryDate(h.created_at);
    if (!window.confirm(
      `Reverse "${label}"?\n\n` +
      `This will:\n` +
      `  • Remove the 400 emails from blacklist\n` +
      `  • Restore the pool pointer to where it was\n` +
      `  • Delete the history row\n` +
      `  • Clear the founder's cooldown\n\n` +
      `The Google Sheet itself stays in Drive — delete it manually if you want.`
    )) return;
    setReversingId(h.id);
    setReverseError(null);
    try {
      const res = await fetch(`/api/cron/email-tool/batch/${h.id}`, { method: 'DELETE' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) {
        setReverseError(data.detail ?? data.reason ?? `http ${res.status}`);
        return;
      }
      // Drop the reversed row from local history + bump remaining count
      setHistory(prev => prev.filter(x => x.id !== h.id));
      setRemaining(prev => prev + (data.reversed_emails ?? 0));
      // Clear cooldown locally so the button re-enables instantly.
      setNextAvailable(null);
    } catch {
      setReverseError('network error');
    } finally {
      setReversingId(null);
    }
  }

  // Batches older than 24h can't be reversed (server-side guard). Mirror
  // that here so we hide the button instead of showing it just to 409.
  function canReverse(h: HistoryEntry): boolean {
    if (!now) return false;
    const ageHours = (now.getTime() - new Date(h.created_at).getTime()) / 3_600_000;
    return ageHours <= 24;
  }

  async function uploadBlacklist(files: FileList) {
    setUploading(true);
    setUploadError(null);
    setUploadResult(null);
    try {
      const form = new FormData();
      for (const f of Array.from(files)) form.append('files', f);
      const res = await fetch('/api/cron/email-tool/blacklist-upload', { method: 'POST', body: form });
      const data = await res.json();
      if (!data.ok) {
        setUploadError(data.reason ?? 'upload failed');
      } else {
        setUploadResult({
          filesParsed: data.filesParsed,
          uniqueEmailsFound: data.uniqueEmailsFound,
          newlyAdded: data.newlyAdded,
          totalAfter: data.totalAfter,
          freshRemaining: data.freshRemaining,
        });
        setBlacklistSize(data.totalAfter);
        setRemaining(data.freshRemaining);
      }
    } catch {
      setUploadError('network error');
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }

  function countdown(target: Date): string {
    if (!now) return '';
    const diff = Math.max(0, target.getTime() - now.getTime());
    const h = Math.floor(diff / 3_600_000);
    const m = Math.floor((diff % 3_600_000) / 60_000);
    const s = Math.floor((diff % 60_000) / 1000);
    return `${h}h ${m}m ${s}s`;
  }

  function formatEntryDate(iso: string): string {
    return new Date(iso).toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  }

  return (
    <div className="min-h-[calc(100vh-1rem)] flex items-start justify-center p-6">
      <div className="w-full max-w-md flex flex-col gap-5 mt-8">

        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-semibold text-gray-900 flex items-center gap-2">
            <Target className="h-5 w-5 text-gray-400" />
            Hi {name}.
          </h1>
          {isAdmin && (
            <a
              href="/email-tool/admin?tab=overview"
              className="text-xs text-gray-500 hover:text-gray-900 inline-flex items-center gap-1 border border-gray-200 hover:border-gray-300 rounded-md px-2 py-1 transition"
            >
              admin <ExternalLink className="h-3 w-3" />
            </a>
          )}
        </div>

        <button
          onClick={getBatch}
          disabled={loading || onCooldown}
          className="w-full bg-gray-900 hover:bg-gray-700 text-white font-semibold py-5 rounded-xl text-base shadow-sm transition disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {loading ? 'Preparing your batch...' : 'Give me my batch of 400'}
        </button>

        {onCooldown && cooldownDate && (
          <p className="text-center text-sm text-gray-500">
            Next batch available in{' '}
            <span className="font-mono text-gray-900">{countdown(cooldownDate)}</span>
            <br />
            <span className="text-xs text-gray-400">({cooldownDate.toLocaleString()})</span>
          </p>
        )}

        {!onCooldown && !batchUrl && !loading && (
          <p className="text-center text-sm text-emerald-600">Ready to go.</p>
        )}

        {batchUrl && (
          <a
            href={batchUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center justify-center gap-2 bg-emerald-600 hover:bg-emerald-700 text-white py-3 rounded-xl text-sm font-medium transition"
          >
            Your batch is ready <ExternalLink className="h-4 w-4" />
          </a>
        )}

        {error && (
          <p className="text-center text-sm text-red-600">{error}</p>
        )}

        <p className="text-xs text-gray-500 text-center">
          {remaining.toLocaleString()} emails left in pool
          {isAdmin && <> · {blacklistSize.toLocaleString()} in blacklist</>}
        </p>

        {isAdmin && (
          <div className="border-t border-gray-100 pt-4 flex flex-col gap-2">
            <p className="text-[11px] uppercase tracking-wider text-gray-400 flex items-center gap-1">
              <Upload className="h-3 w-3" /> Blacklist upload (admin)
            </p>
            <p className="text-xs text-gray-500">
              Upload CSVs of already-contacted people. Any email-looking string
              in any cell gets added to the blacklist. Future batches skip them.
            </p>
            <input
              ref={fileInputRef}
              type="file"
              accept=".csv,text/csv,text/plain"
              multiple
              disabled={uploading}
              onChange={e => {
                if (e.target.files && e.target.files.length > 0) uploadBlacklist(e.target.files);
              }}
              className="text-xs text-gray-500 file:mr-3 file:px-3 file:py-2 file:rounded-md file:border-0 file:bg-gray-100 file:text-gray-800 file:cursor-pointer hover:file:bg-gray-200 disabled:opacity-40"
            />
            {uploading && <p className="text-xs text-gray-400 inline-flex items-center gap-1"><Loader2 className="h-3 w-3 animate-spin" /> Uploading…</p>}
            {uploadResult && (
              <p className="text-xs text-emerald-700">
                Parsed {uploadResult.filesParsed} file{uploadResult.filesParsed === 1 ? '' : 's'} · {uploadResult.uniqueEmailsFound.toLocaleString()} unique emails found · {uploadResult.newlyAdded.toLocaleString()} newly added to blacklist ({uploadResult.totalAfter.toLocaleString()} total).
              </p>
            )}
            {uploadError && <p className="text-xs text-red-600">Upload failed: {uploadError}</p>}
          </div>
        )}

        {isAdmin && (
          <div className="border-t border-gray-100 pt-4 flex flex-col gap-2">
            <p className="text-[11px] uppercase tracking-wider text-gray-400 flex items-center gap-1">
              <Upload className="h-3 w-3" /> Upload + filter (admin)
            </p>
            <p className="text-xs text-gray-500">
              Upload a CSV. Rows with no email are skipped, rows already
              blacklisted or already in pool are dropped. Survivors get
              added to the pool.
            </p>
            <label className="flex items-center gap-2 cursor-pointer text-xs text-gray-700 pl-1">
              <input
                type="checkbox"
                checked={putAtTop}
                onChange={e => setPutAtTop(e.target.checked)}
              />
              <span>
                <span className="font-medium text-gray-800">Put at top of pool.</span>{' '}
                These will be the next emails sent. Uncheck to add to the bottom instead.
              </span>
            </label>
            <input
              ref={filterInputRef}
              type="file"
              accept=".csv,text/csv,text/plain"
              disabled={filtering}
              onChange={e => {
                const f = e.target.files?.[0];
                if (f) filterCsv(f, filterMode);
              }}
              className="text-xs text-gray-500 file:mr-3 file:px-3 file:py-2 file:rounded-md file:border-0 file:bg-gray-100 file:text-gray-800 file:cursor-pointer hover:file:bg-gray-200 disabled:opacity-40"
            />
            {filtering && <p className="text-xs text-gray-400 inline-flex items-center gap-1"><Loader2 className="h-3 w-3 animate-spin" /> Filtering…</p>}
            {filterResult && (
              <p className="text-xs text-emerald-700">
                Uploaded {(filterResult.inputRows + filterResult.skippedNoEmail + filterResult.skippedNameMismatch).toLocaleString()} rows ·{' '}
                {filterResult.skippedNoEmail.toLocaleString()} skipped (no email) ·{' '}
                {filterResult.skippedNameMismatch.toLocaleString()} skipped (name/email mismatch) ·{' '}
                {filterResult.alreadyBlacklisted.toLocaleString()} already blacklisted ·{' '}
                {filterResult.alreadyInPool.toLocaleString()} already in pool ·{' '}
                {filterResult.poolInserted.toLocaleString()} added to pool{' '}
                {filterResult.mode === 'pool_top' ? 'TOP' : filterResult.mode === 'pool_bottom' ? 'BOTTOM' : ''}.
              </p>
            )}
            {filterError && <p className="text-xs text-red-600">Filter failed: {filterError}</p>}
          </div>
        )}

        {history.length > 0 && (
          <div className="border-t border-gray-100 pt-4 flex flex-col gap-2">
            <p className="text-[11px] uppercase tracking-wider text-gray-400">
              {isAdmin ? 'All batches (team view)' : 'Your past batches'}
            </p>
            <ul className="flex flex-col divide-y divide-gray-100 max-h-72 overflow-y-auto">
              {history.map(h => (
                <li key={h.id} className="flex justify-between items-center py-2 text-sm">
                  <div className="flex flex-col">
                    <span className="text-gray-700">{h.title ?? formatEntryDate(h.created_at)}</span>
                    <span className="text-xs text-gray-400">
                      {formatEntryDate(h.created_at)}
                      {isAdmin && h.created_by ? <> · by {h.created_by}</> : null}
                    </span>
                  </div>
                  <div className="flex items-center gap-3">
                    {canReverse(h) && (
                      <button
                        onClick={() => reverseBatch(h)}
                        disabled={reversingId === h.id}
                        className="text-red-600 hover:text-red-800 text-xs disabled:opacity-40"
                        title="Undo this batch: removes the 400 emails from blacklist, restores the pool pointer, deletes the history row, clears cooldown. Only works on the most recent batch and within 24h."
                      >
                        {reversingId === h.id ? 'reversing…' : 'reverse'}
                      </button>
                    )}
                    <a
                      href={h.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-blue-600 hover:text-blue-800 inline-flex items-center gap-1 text-xs"
                    >
                      open <ExternalLink className="h-3 w-3" />
                    </a>
                  </div>
                </li>
              ))}
            </ul>
            {reverseError && <p className="text-xs text-red-600">Reverse failed: {reverseError}</p>}
          </div>
        )}
      </div>
    </div>
  );
}
