'use client';

import { useCallback, useEffect, useState } from 'react';

interface VariantStat {
  id: string;
  founder_id: string;
  founder_name: string | null;
  label: string;
  subject_template: string;
  body_template: string;
  is_active: boolean;
  is_followup: boolean;
  sent: number;
  replied: number;
  reply_rate_pct: number;
  opened: number;
  open_rate_pct: number;
  ci_low_pct: number | null;
  ci_high_pct: number | null;
  ci_width_pct: number | null;
}

interface FollowupTotals { sent_today: number; pending: number }

interface ApiResp {
  variants?: VariantStat[];
  followups?: FollowupTotals;
  error?: string;
}

// Auto-refresh interval. 30s lets you watch the test progress live without
// hammering the RPC (which scans 30d of interactions).
const POLL_MS = 30_000;

export function AbTestTab() {
  const [variants, setVariants] = useState<VariantStat[] | null>(null);
  const [followups, setFollowups] = useState<FollowupTotals | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeOnly, setActiveOnly] = useState(true);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const q = activeOnly ? '?active_only=true' : '';
      const r = (await fetch(`/api/cron/email-tool/ab-test${q}`).then(r => r.json())) as ApiResp;
      if (r.error) { setError(r.error); return; }
      setVariants(r.variants ?? []);
      setFollowups(r.followups ?? null);
      setError(null);
    } catch {
      setError('network error');
    } finally {
      setLoading(false);
    }
  }, [activeOnly]);

  useEffect(() => {
    load();
    const t = setInterval(load, POLL_MS);
    return () => clearInterval(t);
  }, [load]);

  // Identify the winner: variant with the highest reply rate whose lower-CI
  // bound is strictly above every other variant's upper-CI bound. If no
  // variant clears that bar, there's no significant winner yet — we just
  // show the leader without a badge.
  const winnerId = (() => {
    if (!variants || variants.length < 2) return null;
    const eligible = variants.filter(v => v.ci_low_pct != null && v.sent >= 20);
    if (eligible.length < 2) return null;
    const sorted = [...eligible].sort((a, b) => (b.reply_rate_pct - a.reply_rate_pct));
    const leader = sorted[0];
    const everyoneElse = sorted.slice(1);
    const dominates = everyoneElse.every(o =>
      leader.ci_low_pct != null && o.ci_high_pct != null && leader.ci_low_pct > o.ci_high_pct
    );
    return dominates ? leader.id : null;
  })();

  return (
    <div className="flex flex-col gap-4">
      <header className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-gray-900">A/B Test</h2>
          <p className="text-xs text-gray-500 mt-1">
            Per-variant sent / replied / reply rate over the last 30 days. Only counts
            human replies — bounces, autoresponders, and out-of-office are filtered
            out by the Gmail sync before they land in <code>leads.first_reply_at</code>.
          </p>
        </div>
        <label className="flex items-center gap-2 text-xs text-gray-600">
          <input
            type="checkbox"
            checked={activeOnly}
            onChange={e => setActiveOnly(e.target.checked)}
          />
          Active variants only
        </label>
      </header>

      {followups && (
        <div className="flex gap-4 text-xs">
          <span className="bg-emerald-50 border border-emerald-200 rounded px-2 py-1">
            <span className="text-emerald-700 font-medium">Follow-ups sent today:</span>{' '}
            <span className="font-mono tabular-nums">{followups.sent_today.toLocaleString()}</span>
          </span>
          <span className="bg-amber-50 border border-amber-200 rounded px-2 py-1">
            <span className="text-amber-700 font-medium">Follow-ups pending:</span>{' '}
            <span className="font-mono tabular-nums">{followups.pending.toLocaleString()}</span>
          </span>
        </div>
      )}

      {loading && variants === null && (
        <p className="text-sm text-gray-400">Loading…</p>
      )}
      {error && (
        <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded p-2">{error}</p>
      )}

      {variants !== null && variants.length === 0 && (
        <p className="text-sm text-gray-500 italic">
          No variants have been sent yet — run a batch first.
        </p>
      )}

      {variants !== null && variants.length > 0 && (
        <div className="border border-gray-200 rounded overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-xs uppercase tracking-wider text-gray-500">
              <tr>
                <th className="text-left px-3 py-2">Variant</th>
                <th className="text-left px-3 py-2">Founder</th>
                <th className="text-right px-3 py-2">Sent</th>
                <th className="text-right px-3 py-2" title="Filtered open count — Apple MPP pre-fetches and known scanner UAs are excluded.">Opened</th>
                <th className="text-right px-3 py-2">Open rate</th>
                <th className="text-right px-3 py-2">Replied</th>
                <th className="text-right px-3 py-2">Reply rate</th>
                <th className="text-right px-3 py-2">95% CI</th>
              </tr>
            </thead>
            <tbody>
              {variants.map(v => (
                <Row
                  key={v.id}
                  variant={v}
                  isWinner={v.id === winnerId}
                  isExpanded={expandedId === v.id}
                  onToggle={() => setExpandedId(prev => prev === v.id ? null : v.id)}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="text-xs text-gray-400">
        Refreshes every {POLL_MS / 1000}s · Reply rate uses Wilson 95% CI · Winner
        badge appears when one variant&apos;s CI lower bound exceeds every other variant&apos;s
        CI upper bound (no significant tie).
      </p>
    </div>
  );
}

function Row({
  variant: v, isWinner, isExpanded, onToggle,
}: {
  variant: VariantStat;
  isWinner: boolean;
  isExpanded: boolean;
  onToggle: () => void;
}) {
  return (
    <>
      <tr
        className={`border-t border-gray-100 hover:bg-gray-50 cursor-pointer ${
          isWinner ? 'bg-emerald-50' : ''
        } ${!v.is_active ? 'opacity-60' : ''}`}
        onClick={onToggle}
      >
        <td className="px-3 py-2 font-mono text-xs">
          {isWinner && <span className="mr-1" title="Winner (CIs don't overlap)">🏆</span>}
          {v.is_followup && <span className="mr-1" title="Follow-up bump variant — sent as a reply in the original thread.">🔁</span>}
          {v.label}
          {!v.is_active && <span className="ml-2 text-gray-400">(inactive)</span>}
        </td>
        <td className="px-3 py-2 text-gray-700">{v.founder_name ?? '—'}</td>
        <td className="px-3 py-2 text-right tabular-nums">{v.sent.toLocaleString()}</td>
        <td className="px-3 py-2 text-right tabular-nums">{v.opened.toLocaleString()}</td>
        <td className="px-3 py-2 text-right tabular-nums text-blue-700">
          {v.sent > 0 ? `${v.open_rate_pct.toFixed(1)}%` : '—'}
        </td>
        <td className="px-3 py-2 text-right tabular-nums">{v.replied.toLocaleString()}</td>
        <td className="px-3 py-2 text-right tabular-nums font-medium">
          {v.sent > 0 ? `${v.reply_rate_pct.toFixed(1)}%` : '—'}
        </td>
        <td className="px-3 py-2 text-right text-xs text-gray-500 tabular-nums">
          {v.ci_low_pct != null && v.ci_high_pct != null
            ? `${v.ci_low_pct.toFixed(1)}–${v.ci_high_pct.toFixed(1)}%`
            : '—'}
        </td>
      </tr>
      {isExpanded && (
        <tr className="bg-gray-50 border-t border-gray-100">
          <td colSpan={8} className="px-3 py-3 text-xs">
            <div className="font-medium text-gray-700 mb-1">Subject</div>
            <div className="font-mono text-gray-600 mb-3 whitespace-pre-wrap">{v.subject_template}</div>
            <div className="font-medium text-gray-700 mb-1">Body</div>
            <div className="font-mono text-gray-600 whitespace-pre-wrap">{v.body_template}</div>
          </td>
        </tr>
      )}
    </>
  );
}
