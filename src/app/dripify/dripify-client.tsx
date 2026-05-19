'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import {
  Search,
  Linkedin,
  RefreshCw,
  ExternalLink,
  Loader2,
  Mail,
  CheckCircle2,
} from '@/lib/icons';
import {
  DRIPIFY_STATUS_LABELS,
  DRIPIFY_STATUS_COLORS,
  DRIPIFY_STATUS_ORDER,
} from '@/lib/dripify/constants';
import type { DripifyLead, DripifyLeadStatus } from '@/lib/dripify/types';

type StatusFilter = 'all' | DripifyLeadStatus;

interface Response {
  leads: DripifyLead[];
  total: number;
  counts: Partial<Record<DripifyLeadStatus, number>>;
}

function formatRelative(iso: string | null): string {
  if (!iso) return '—';
  const ts = new Date(iso).getTime();
  const diff = Date.now() - ts;
  const m = Math.floor(diff / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

export function DripifyClient() {
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [data, setData] = useState<Response>({ leads: [], total: 0, counts: {} });
  const [loading, setLoading] = useState(true);
  const [retryingId, setRetryingId] = useState<string | null>(null);

  // Debounce search.
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(t);
  }, [search]);

  const fetchLeads = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (statusFilter !== 'all') params.set('status', statusFilter);
      if (debouncedSearch) params.set('q', debouncedSearch);
      const res = await fetch(`/api/dripify/leads?${params.toString()}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json() as Response;
      setData(json);
    } catch (err) {
      toast.error(`Failed to load Dripify leads: ${(err as Error).message}`);
    } finally {
      setLoading(false);
    }
  }, [statusFilter, debouncedSearch]);

  useEffect(() => { fetchLeads(); }, [fetchLeads]);

  // Light polling for the demo — every 8s — until we wire up Supabase realtime
  // on this table. Cheap because the list endpoint returns at most 100 rows.
  useEffect(() => {
    const id = setInterval(fetchLeads, 8000);
    return () => clearInterval(id);
  }, [fetchLeads]);

  const retry = async (leadId: string) => {
    setRetryingId(leadId);
    try {
      const res = await fetch(`/api/dripify/leads/${leadId}/retry`, { method: 'POST' });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? 'retry_failed');
      toast.success(`Reset → ${json.new_status}. Next cron tick will process.`);
      fetchLeads();
    } catch (err) {
      toast.error(`Retry failed: ${(err as Error).message}`);
    } finally {
      setRetryingId(null);
    }
  };

  const totalAll = useMemo(
    () => Object.values(data.counts).reduce((s, n) => s + (n ?? 0), 0),
    [data.counts],
  );

  return (
    <div className="space-y-4">
      {/* Status filter chips */}
      <div className="flex flex-wrap items-center gap-2">
        <button
          onClick={() => setStatusFilter('all')}
          className={`text-xs px-2.5 py-1 rounded-full border transition ${
            statusFilter === 'all'
              ? 'bg-gray-900 text-white border-gray-900'
              : 'border-gray-200 text-gray-600 hover:bg-gray-50'
          }`}
        >
          All ({totalAll})
        </button>
        {DRIPIFY_STATUS_ORDER.map(s => (
          <button
            key={s}
            onClick={() => setStatusFilter(s)}
            className={`text-xs px-2.5 py-1 rounded-full border transition ${
              statusFilter === s
                ? DRIPIFY_STATUS_COLORS[s]
                : 'border-gray-200 text-gray-500 hover:bg-gray-50'
            }`}
          >
            {DRIPIFY_STATUS_LABELS[s]} ({data.counts[s] ?? 0})
          </button>
        ))}
      </div>

      {/* Search */}
      <div className="relative max-w-md">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-gray-400" />
        <input
          type="text"
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search name, company, email, LinkedIn URL…"
          className="w-full pl-9 pr-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-gray-900/10 focus:border-gray-300 placeholder:text-gray-400"
        />
      </div>

      {/* Table */}
      <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50/70 text-gray-500 text-xs">
              <tr>
                <th className="px-4 py-2.5 text-left font-medium">Lead</th>
                <th className="px-4 py-2.5 text-left font-medium">Company</th>
                <th className="px-4 py-2.5 text-left font-medium">Status</th>
                <th className="px-4 py-2.5 text-left font-medium">Email</th>
                <th className="px-4 py-2.5 text-left font-medium">Received</th>
                <th className="px-4 py-2.5 text-left font-medium">Sent</th>
                <th className="px-4 py-2.5 text-right font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {loading && data.leads.length === 0 ? (
                <tr>
                  <td colSpan={7} className="py-16 text-center text-gray-400">
                    <Loader2 className="inline h-4 w-4 animate-spin mr-2" />
                    Loading…
                  </td>
                </tr>
              ) : data.leads.length === 0 ? (
                <tr>
                  <td colSpan={7} className="py-16 text-center text-gray-400">
                    No Dripify leads yet. Fire a Test from Dripify Settings to see one here.
                  </td>
                </tr>
              ) : (
                data.leads.map(lead => (
                  <tr key={lead.id} className="border-t border-gray-100 hover:bg-gray-50/40">
                    <td className="px-4 py-3">
                      <div className="font-medium text-gray-900">
                        {lead.first_name || lead.full_name || '(no name)'} {lead.last_name ?? ''}
                      </div>
                      {lead.headline && (
                        <div className="text-xs text-gray-500 truncate max-w-[200px]">{lead.headline}</div>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <div className="text-gray-700">{lead.company_name ?? '—'}</div>
                      {lead.company_url && (
                        <a
                          href={lead.company_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-xs text-gray-400 hover:text-gray-600 inline-flex items-center gap-1"
                        >
                          <ExternalLink className="h-3 w-3" />
                          {new URL(lead.company_url.startsWith('http') ? lead.company_url : `https://${lead.company_url}`).hostname.replace(/^www\./, '')}
                        </a>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <span className={`text-xs px-2 py-0.5 rounded-full border ${DRIPIFY_STATUS_COLORS[lead.status]}`}>
                        {DRIPIFY_STATUS_LABELS[lead.status]}
                      </span>
                      {lead.last_error && (
                        <div className="text-xs text-red-500 mt-1 truncate max-w-[180px]" title={lead.last_error}>
                          {lead.last_error}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3 text-gray-700">
                      {lead.resolved_email ? (
                        <span className="inline-flex items-center gap-1.5">
                          <Mail className="h-3.5 w-3.5 text-gray-400" />
                          <span className="truncate max-w-[200px]">{lead.resolved_email}</span>
                        </span>
                      ) : (
                        <span className="text-gray-400">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-gray-500 text-xs">
                      {formatRelative(lead.created_at)}
                    </td>
                    <td className="px-4 py-3 text-gray-500 text-xs">
                      {lead.sent_at ? (
                        <span className="inline-flex items-center gap-1 text-emerald-600">
                          <CheckCircle2 className="h-3.5 w-3.5" />
                          {formatRelative(lead.sent_at)}
                        </span>
                      ) : (
                        <span className="text-gray-400">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right space-x-2">
                      {lead.linkedin_url && (
                        <a
                          href={lead.linkedin_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center justify-center h-7 w-7 rounded-md border border-gray-200 text-gray-500 hover:bg-gray-50"
                          title="Open LinkedIn"
                        >
                          <Linkedin className="h-3.5 w-3.5" />
                        </a>
                      )}
                      {['unresolvable', 'send_failed', 'skipped'].includes(lead.status) && (
                        <button
                          onClick={() => retry(lead.id)}
                          disabled={retryingId === lead.id}
                          className="inline-flex items-center justify-center h-7 px-2 rounded-md border border-gray-200 text-xs text-gray-600 hover:bg-gray-50 disabled:opacity-50"
                          title="Retry"
                        >
                          {retryingId === lead.id ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <RefreshCw className="h-3.5 w-3.5" />
                          )}
                        </button>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
