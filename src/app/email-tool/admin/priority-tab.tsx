'use client';

import { useEffect, useState, useCallback } from 'react';
import { PriorityUploadModal } from '@/components/email-tool/priority-upload-modal';

interface PriorityRow {
  id: string;
  email: string;
  first_name: string | null;
  company: string | null;
  scheduled_for_date: string;
  notes: string | null;
  status: 'pending' | 'scheduled' | 'sent' | 'skipped' | 'cancelled';
  uploaded_at: string;
  uploaded_by: string;
  campaign_id: string | null;
  last_error: string | null;
}

const STATUS_COLORS: Record<PriorityRow['status'], string> = {
  pending: 'bg-yellow-100 text-yellow-800',
  scheduled: 'bg-blue-100 text-blue-800',
  sent: 'bg-green-100 text-green-800',
  skipped: 'bg-gray-100 text-gray-600',
  cancelled: 'bg-gray-50 text-gray-500',
};

export function PriorityTab() {
  const [rows, setRows] = useState<PriorityRow[]>([]);
  const [showUpload, setShowUpload] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = (await fetch('/api/cron/email-tool/priority').then(r => r.json())) as { rows?: PriorityRow[]; error?: string };
      if (r.error) {
        setError(r.error);
        setRows([]);
      } else {
        setRows(r.rows ?? []);
        setError(null);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'load failed');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function cancel(id: string) {
    if (!window.confirm('Cancel this priority row?')) return;
    const res = await fetch(`/api/cron/email-tool/priority/${id}`, { method: 'DELETE' });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      window.alert(data.error ?? 'cancel failed');
      return;
    }
    load();
  }

  // Group rows by upload batch (uploaded_at + uploaded_by + scheduled_for_date)
  const groups = new Map<string, PriorityRow[]>();
  for (const r of rows) {
    const key = `${r.uploaded_at}|${r.uploaded_by}|${r.scheduled_for_date}|${r.notes ?? ''}`;
    const list = groups.get(key) ?? [];
    list.push(r);
    groups.set(key, list);
  }
  const groupEntries = Array.from(groups.entries()).sort(
    ([, a], [, b]) => new Date(b[0].uploaded_at).getTime() - new Date(a[0].uploaded_at).getTime()
  );

  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center mb-2">
        <h2 className="text-lg font-semibold">Priority Queue</h2>
        <button
          onClick={() => setShowUpload(true)}
          className="px-3 py-2 bg-blue-500 text-white rounded text-sm font-medium hover:bg-blue-600"
        >
          Upload Priority Batch
        </button>
      </div>

      {loading && <div className="text-sm text-gray-500 p-8 text-center">Loading...</div>}
      {error && <div className="text-sm text-red-600 p-8 text-center">Error: {error}</div>}

      {!loading && !error && groupEntries.length === 0 && (
        <p className="text-sm text-gray-500 italic p-8 text-center bg-white rounded-md border border-gray-200">
          No priority batches uploaded yet. Click &quot;Upload Priority Batch&quot; to inject high-priority recipients into a campaign.
        </p>
      )}

      {groupEntries.map(([key, batch]) => {
        const sample = batch[0];
        const counts = batch.reduce<Record<string, number>>((acc, r) => {
          acc[r.status] = (acc[r.status] ?? 0) + 1;
          return acc;
        }, {});
        return (
          <section key={key} className="border border-gray-200 rounded-lg p-4 bg-white">
            <header className="flex items-start justify-between mb-3">
              <div>
                <div className="font-medium">
                  {sample.notes || '(no label)'} &middot; {batch.length} row{batch.length === 1 ? '' : 's'}
                </div>
                <div className="text-xs text-gray-500 mt-1">
                  scheduled {sample.scheduled_for_date} &middot; uploaded {new Date(sample.uploaded_at).toLocaleString()}
                </div>
              </div>
              <div className="flex gap-1 flex-wrap">
                {Object.entries(counts).map(([status, count]) => (
                  <span key={status} className={`text-xs px-2 py-0.5 rounded ${STATUS_COLORS[status as PriorityRow['status']]}`}>
                    {status}: {count}
                  </span>
                ))}
              </div>
            </header>
            <details className="text-sm">
              <summary className="cursor-pointer text-blue-600 hover:underline">
                Show {batch.length} row{batch.length === 1 ? '' : 's'}
              </summary>
              <table className="w-full mt-2 text-xs">
                <thead>
                  <tr className="text-left text-gray-500">
                    <th className="py-1">Email</th>
                    <th className="py-1">First name</th>
                    <th className="py-1">Company</th>
                    <th className="py-1">Status</th>
                    <th className="py-1"></th>
                  </tr>
                </thead>
                <tbody>
                  {batch.map(r => (
                    <tr key={r.id} className="border-t border-gray-100">
                      <td className="py-1 font-mono">{r.email}</td>
                      <td className="py-1">{r.first_name ?? '—'}</td>
                      <td className="py-1">{r.company ?? '—'}</td>
                      <td className="py-1">
                        <span className={`px-2 py-0.5 rounded ${STATUS_COLORS[r.status]}`}>{r.status}</span>
                      </td>
                      <td className="py-1 text-right">
                        {r.status === 'pending' && (
                          <button
                            onClick={() => cancel(r.id)}
                            className="text-red-600 hover:underline text-xs"
                          >
                            Cancel
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </details>
          </section>
        );
      })}

      {showUpload && (
        <PriorityUploadModal
          onClose={() => setShowUpload(false)}
          onUploaded={() => { setShowUpload(false); load(); }}
        />
      )}
    </div>
  );
}
