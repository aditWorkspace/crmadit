'use client';

// Replaces the legacy "All batches (team view)" list on /email-tool.
// Shows recent enrich_jobs with file name, status, counters, and
// pool size delta. Clicking opens the live modal for that job.
// Queued/running jobs get an "abort" link that hits /enrich/abort.

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';

interface JobSummary {
  id: string;
  created_at: string;
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
  created_by_name: string | null;
}

interface Props {
  onOpenJob: (jobId: string) => void;
}

function fmtTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function statusBadge(status: string): { label: string; color: string } {
  switch (status) {
    case 'done': return { label: 'DONE', color: 'text-emerald-700 bg-emerald-50 border-emerald-200' };
    case 'processing': return { label: 'RUNNING', color: 'text-amber-700 bg-amber-50 border-amber-200' };
    case 'queued': return { label: 'QUEUED', color: 'text-gray-700 bg-gray-100 border-gray-200' };
    case 'error': return { label: 'ERROR', color: 'text-red-700 bg-red-50 border-red-200' };
    case 'aborted': return { label: 'ABORTED', color: 'text-gray-500 bg-gray-50 border-gray-200' };
    default: return { label: status.toUpperCase(), color: 'text-gray-500 bg-gray-50 border-gray-200' };
  }
}

const POLL_MS = 10_000;

export function RecentUploads({ onOpenJob }: Props) {
  const [jobs, setJobs] = useState<JobSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [abortingId, setAbortingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/cron/email-tool/enrich/list');
      const data = await res.json();
      if (!res.ok) { setError(data.error ?? 'failed'); return; }
      setJobs(data.jobs ?? []);
      setError(null);
    } catch {
      setError('network error');
    }
  }, []);

  const abortJob = useCallback(async (jobId: string) => {
    if (!window.confirm('Abort this enrichment job? Pending rows will be marked dropped.')) return;
    setAbortingId(jobId);
    try {
      const res = await fetch('/api/cron/email-tool/enrich/abort', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ job_id: jobId }),
      });
      const data = await res.json();
      if (!res.ok || data.error) {
        toast.error(`Abort failed: ${data.error ?? `http ${res.status}`}`);
      } else {
        toast.success('Job aborted');
        // Refresh list immediately rather than waiting for poll
        await load();
      }
    } catch (err) {
      toast.error(`Abort failed: ${(err as Error).message}`);
    } finally {
      setAbortingId(null);
    }
  }, [load]);

  useEffect(() => {
    load();
    const id = setInterval(load, POLL_MS);
    return () => clearInterval(id);
  }, [load]);

  if (jobs === null) return null;
  if (jobs.length === 0) return null;

  return (
    <div className="border-t border-gray-100 pt-4 flex flex-col gap-2">
      <p className="text-[11px] uppercase tracking-wider text-gray-400">
        Recent uploads
      </p>
      {error && <p className="text-xs text-red-600">{error}</p>}
      <ul className="flex flex-col divide-y divide-gray-100 max-h-96 overflow-y-auto">
        {jobs.map(j => {
          const badge = statusBadge(j.status);
          const delta = (j.pool_size_before != null && j.pool_size_after != null)
            ? j.pool_size_after - j.pool_size_before
            : null;
          return (
            <li key={j.id} className="py-2 flex flex-col gap-1 cursor-pointer hover:bg-gray-50 -mx-2 px-2 rounded" onClick={() => onOpenJob(j.id)}>
              <div className="flex items-center justify-between text-sm">
                <span className="font-medium text-gray-800 truncate">{j.file_name ?? 'unnamed'}</span>
                <div className="flex items-center gap-2">
                  {(j.status === 'queued' || j.status === 'processing') && (
                    <button
                      onClick={(e) => { e.stopPropagation(); abortJob(j.id); }}
                      disabled={abortingId === j.id}
                      className="text-[10px] font-semibold uppercase tracking-wider border rounded px-1.5 py-0.5 text-red-700 bg-red-50 border-red-200 hover:bg-red-100 disabled:opacity-50"
                    >
                      {abortingId === j.id ? 'aborting…' : 'abort'}
                    </button>
                  )}
                  <span className={`text-[10px] font-semibold uppercase tracking-wider border rounded px-1.5 py-0.5 ${badge.color}`}>
                    {badge.label}
                  </span>
                </div>
              </div>
              <div className="text-xs text-gray-500 flex flex-wrap gap-x-3 gap-y-0.5">
                <span>{fmtTime(j.created_at)}</span>
                {j.created_by_name && <span>by {j.created_by_name}</span>}
                <span>{j.total_rows.toLocaleString()} rows</span>
                <span>· {j.processed.toLocaleString()} processed</span>
                <span className="text-emerald-700">· {j.kept.toLocaleString()} kept</span>
                <span className="text-red-600">· {j.dropped.toLocaleString()} dropped</span>
                <span>· ${Number(j.cost_usd).toFixed(3)}</span>
              </div>
              {j.status === 'done' && (j.pool_size_before != null || j.pool_size_after != null) && (
                <div className="text-xs text-gray-600 font-mono">
                  pool {j.pool_size_before?.toLocaleString() ?? '?'} →{' '}
                  {j.pool_size_after?.toLocaleString() ?? '?'}{' '}
                  <span className={delta != null && delta > 0 ? 'text-emerald-700' : 'text-gray-500'}>
                    ({delta != null && delta >= 0 ? '+' : ''}{delta?.toLocaleString() ?? '?'})
                  </span>
                  {' · '}
                  added to {j.mode === 'pool_top' ? 'TOP' : 'BOTTOM'}
                  {j.already_in_pool > 0 && <span> · {j.already_in_pool} already in pool</span>}
                  {j.already_blacklisted > 0 && <span> · {j.already_blacklisted} blacklisted</span>}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
