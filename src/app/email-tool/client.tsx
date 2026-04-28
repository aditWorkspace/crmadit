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

  // Upload + filter (admin) — separate from the bulk blacklist upload.
  // Takes a CSV the user is about to send, removes rows whose email is
  // already in the blacklist, blacklists the survivors, and returns the
  // cleaned CSV for download.
  const [filtering, setFiltering] = useState(false);
  const [filterResult, setFilterResult] = useState<{
    inputRows: number;
    outputRows: number;
    alreadyBlacklisted: number;
    newlyBlacklisted: number;
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

  async function filterCsv(file: File) {
    setFiltering(true);
    setFilterError(null);
    setFilterResult(null);
    try {
      const form = new FormData();
      form.append('file', file);
      const res = await fetch('/api/cron/email-tool/csv-filter', { method: 'POST', body: form });
      if (!res.ok) {
        // Error responses are JSON with { ok: false, reason }.
        let reason = `http ${res.status}`;
        try {
          const j = await res.json();
          if (j && typeof j.reason === 'string') reason = j.reason;
        } catch {}
        setFilterError(reason);
        return;
      }

      const inputRows = Number(res.headers.get('X-Input-Rows') ?? '0');
      const outputRows = Number(res.headers.get('X-Output-Rows') ?? '0');
      const alreadyBlacklisted = Number(res.headers.get('X-Already-Blacklisted') ?? '0');
      const newlyBlacklisted = Number(res.headers.get('X-Newly-Blacklisted') ?? '0');

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

      setFilterResult({ inputRows, outputRows, alreadyBlacklisted, newlyBlacklisted });
      setBlacklistSize(prev => prev + newlyBlacklisted);
    } catch {
      setFilterError('network error');
    } finally {
      setFiltering(false);
      if (filterInputRef.current) filterInputRef.current.value = '';
    }
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
              Upload a CSV you{"'"}re about to send. We{"'"}ll remove rows already in the
              blacklist, add the rest to the blacklist (so they{"'"}re never sent again),
              and return a clean CSV to download.
            </p>
            <input
              ref={filterInputRef}
              type="file"
              accept=".csv,text/csv,text/plain"
              disabled={filtering}
              onChange={e => {
                const f = e.target.files?.[0];
                if (f) filterCsv(f);
              }}
              className="text-xs text-gray-500 file:mr-3 file:px-3 file:py-2 file:rounded-md file:border-0 file:bg-gray-100 file:text-gray-800 file:cursor-pointer hover:file:bg-gray-200 disabled:opacity-40"
            />
            {filtering && <p className="text-xs text-gray-400 inline-flex items-center gap-1"><Loader2 className="h-3 w-3 animate-spin" /> Filtering…</p>}
            {filterResult && (
              <p className="text-xs text-emerald-700">
                Uploaded {filterResult.inputRows.toLocaleString()} rows · {filterResult.alreadyBlacklisted.toLocaleString()} already blacklisted · {filterResult.newlyBlacklisted.toLocaleString()} newly added · downloaded clean.csv with {filterResult.outputRows.toLocaleString()} rows.
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
                  <a
                    href={h.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-blue-600 hover:text-blue-800 inline-flex items-center gap-1 text-xs"
                  >
                    open <ExternalLink className="h-3 w-3" />
                  </a>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
