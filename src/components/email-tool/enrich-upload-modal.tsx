'use client';

// Background-job aware enrich modal.
//
// Two entry modes:
//   1. New upload: pass a `file` + `mode`. Modal POSTs /enrich/create
//      to get a job_id, then polls /enrich/status every 3s.
//   2. Re-open past upload: pass a `jobId` directly (from the recent
//      uploads list). Modal skips the create step and just polls.
//
// User can close the modal at any time; the worker keeps processing
// server-side. Coming back to the history list lets them re-open and
// see exactly where things stand.

import { useCallback, useEffect, useRef, useState } from 'react';

type Props = (
  | { file: File; mode: 'pool_top' | 'pool_bottom'; jobId?: undefined }
  | { jobId: string; file?: undefined; mode?: undefined }
) & { onClose: () => void; onComplete?: () => void };

interface JobRecord {
  id: string;
  status: string;
  mode: 'pool_top' | 'pool_bottom';
  file_name: string | null;
  total_rows: number;
  processed: number;
  kept: number;
  dropped: number;
  bec_calls: number;
  icypeas_calls: number;
  cost_usd: number;
  inserted_to_pool: number;
  already_in_pool: number;
  already_blacklisted: number;
  pool_size_before: number | null;
  pool_size_after: number | null;
  last_error: string | null;
}
interface JobRow {
  row_index: number;
  first_name: string | null;
  full_name: string | null;
  company: string | null;
  domain: string | null;
  given_email: string | null;
  candidates_tried: string[] | null;
  final_email: string | null;
  status: string;
  bec_passes: number;
  bec_fails: number;
  icypeas_status: string | null;
  drop_reason: string | null;
  processed_at: string | null;
}

const POLL_MS = 3_000;

type Tone = 'cyan' | 'green' | 'yellow' | 'magenta' | 'red' | 'gray' | 'white';
const TONE_CLASS: Record<Tone, string> = {
  cyan: 'text-cyan-300',
  green: 'text-emerald-300',
  yellow: 'text-amber-300',
  magenta: 'text-fuchsia-300',
  red: 'text-red-400',
  gray: 'text-gray-500',
  white: 'text-gray-100',
};

interface LogLine { row_index: number; text: string; tone: Tone }

function rowToLogLine(r: JobRow): LogLine {
  const cands = r.candidates_tried ?? [];
  const tried = cands.length > 0 ? ` (tried ${cands.length})` : '';
  if (r.status === 'kept') {
    return {
      row_index: r.row_index,
      text: `row ${r.row_index + 1}  kept  ${r.final_email}${tried}  bec=${r.bec_passes}p/${r.bec_fails}f  icy=${r.icypeas_status ?? '-'}`,
      tone: r.bec_passes > 0 ? 'green' : 'magenta',
    };
  }
  if (r.status === 'name_mismatch') {
    return {
      row_index: r.row_index,
      text: `row ${r.row_index + 1}  dropped (name mismatch)  ${r.final_email}  ${r.drop_reason ?? ''}`,
      tone: 'red',
    };
  }
  // dropped
  return {
    row_index: r.row_index,
    text: `row ${r.row_index + 1}  dropped  ${r.drop_reason ?? 'unknown'}  bec=${r.bec_passes}p/${r.bec_fails}f  icy=${r.icypeas_status ?? '-'}`,
    tone: 'red',
  };
}

export function EnrichUploadModal(props: Props) {
  const { onClose, onComplete } = props;
  const [jobId, setJobId] = useState<string | null>(props.jobId ?? null);
  const [job, setJob] = useState<JobRecord | null>(null);
  const [lines, setLines] = useState<LogLine[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [autoscroll, setAutoscroll] = useState(true);
  const seenRowsRef = useRef<Set<number>>(new Set());
  const logBoxRef = useRef<HTMLDivElement | null>(null);

  // Step 1: if we have a file (new upload), POST /enrich/create.
  useEffect(() => {
    if (props.file) {
      (async () => {
        try {
          const form = new FormData();
          form.append('file', props.file!);
          form.append('mode', props.mode!);
          const res = await fetch('/api/cron/email-tool/enrich/create', {
            method: 'POST',
            body: form,
          });
          const data = await res.json();
          if (!res.ok || !data.job_id) {
            setError(data.error ?? `http ${res.status}`);
            return;
          }
          setJobId(data.job_id);
        } catch (err) {
          setError(`network: ${(err as Error).message}`);
        }
      })();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Step 2: poll /enrich/status while job is in flight.
  const poll = useCallback(async (id: string) => {
    try {
      const res = await fetch(`/api/cron/email-tool/enrich/status?job_id=${id}`);
      const data = await res.json();
      if (!res.ok) { setError(data.error ?? `http ${res.status}`); return; }
      setJob(data.job as JobRecord);
      const rows = (data.rows ?? []) as JobRow[];
      const newLines: LogLine[] = [];
      for (const r of rows) {
        if (seenRowsRef.current.has(r.row_index)) continue;
        seenRowsRef.current.add(r.row_index);
        newLines.push(rowToLogLine(r));
      }
      if (newLines.length > 0) {
        setLines(prev => [...prev, ...newLines]);
      }
    } catch (err) {
      setError(`poll: ${(err as Error).message}`);
    }
  }, []);

  useEffect(() => {
    if (!jobId) return;
    let cancelled = false;
    const tick = async () => {
      if (cancelled) return;
      await poll(jobId);
    };
    tick();
    const id = setInterval(tick, POLL_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, [jobId, poll]);

  // Stop polling once job is terminal.
  useEffect(() => {
    if (job && (job.status === 'done' || job.status === 'error' || job.status === 'aborted')) {
      onComplete?.();
    }
  }, [job, onComplete]);

  // Auto-scroll to latest line if user hasn't scrolled away.
  useEffect(() => {
    if (!autoscroll || !logBoxRef.current) return;
    logBoxRef.current.scrollTop = logBoxRef.current.scrollHeight;
  }, [lines, autoscroll]);

  const stats = {
    processed: job?.processed ?? 0,
    total: job?.total_rows ?? 0,
    kept: job?.kept ?? 0,
    dropped: job?.dropped ?? 0,
    bec: job?.bec_calls ?? 0,
    icy: job?.icypeas_calls ?? 0,
    cost: job?.cost_usd ?? 0,
  };
  const isDone = job?.status === 'done' || job?.status === 'error' || job?.status === 'aborted';

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div className="bg-gray-900 border border-gray-700 rounded-lg w-full max-w-3xl max-h-[85vh] flex flex-col shadow-xl" onClick={e => e.stopPropagation()}>
        <header className="flex items-center justify-between px-4 py-3 border-b border-gray-700">
          <div className="flex flex-col">
            <h2 className="text-sm font-semibold text-white">
              {props.file ? 'Enrich + upload' : 'Past enrich run'}
              {job && <span className="ml-2 text-xs text-gray-400 uppercase">{job.status}</span>}
            </h2>
            <p className="text-xs text-gray-400 mt-0.5 font-mono">
              {job?.file_name ?? props.file?.name ?? '—'} ·
              {stats.total > 0 ? ` row ${stats.processed}/${stats.total}` : ' queued'} ·
              est cost <span className="text-emerald-300">${Number(stats.cost).toFixed(3)}</span>
            </p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-white text-xs">
            {isDone ? 'close' : 'leave running'}
          </button>
        </header>
        <div
          ref={logBoxRef}
          onScroll={() => {
            const el = logBoxRef.current;
            if (!el) return;
            setAutoscroll(el.scrollHeight - el.scrollTop - el.clientHeight < 40);
          }}
          className="flex-1 overflow-y-auto bg-black font-mono text-[11px] p-3 leading-snug"
          style={{ minHeight: '300px' }}
        >
          {lines.length === 0 && (
            <div className="text-gray-500">$ {job ? 'waiting for worker tick…' : 'queueing job…'}</div>
          )}
          {lines.map((l, idx) => (
            <div key={idx} className={`${TONE_CLASS[l.tone]} whitespace-pre-wrap`}>
              {l.text}
            </div>
          ))}
          {error && <div className="text-red-400 mt-2">! error: {error}</div>}
          {job?.last_error && <div className="text-red-400 mt-2">! job error: {job.last_error}</div>}
          {isDone && (
            <div className="text-white mt-3 pt-2 border-t border-gray-800">
              {'> '}done · inserted {job.inserted_to_pool} (pool {job.mode === 'pool_top' ? 'TOP' : 'BOTTOM'}) ·
              pool {job.pool_size_before?.toLocaleString() ?? '?'} → {job.pool_size_after?.toLocaleString() ?? '?'} ·
              cost ${Number(job.cost_usd).toFixed(3)}
            </div>
          )}
        </div>
        <footer className="px-4 py-2.5 border-t border-gray-700 flex items-center justify-between text-xs">
          <div className="flex gap-3 font-mono">
            <span className="text-emerald-300">kept {stats.kept}</span>
            <span className="text-red-400">dropped {stats.dropped}</span>
            <span className="text-cyan-300">bec {stats.bec}</span>
            <span className="text-fuchsia-300">icy {stats.icy}</span>
          </div>
          <div className="flex items-center gap-2">
            {!autoscroll && (
              <button onClick={() => setAutoscroll(true)} className="text-amber-300 hover:text-amber-100">
                ↓ follow
              </button>
            )}
            {!isDone && (
              <span className="text-xs text-gray-500">running in background · refreshes every {POLL_MS / 1000}s</span>
            )}
          </div>
        </footer>
      </div>
    </div>
  );
}
