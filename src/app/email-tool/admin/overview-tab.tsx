'use client';

import { useEffect, useState, useCallback } from 'react';

interface FounderStats {
  id: string;
  name: string;
  email: string;
  gmail_connected: boolean;
  paused: boolean;
  paused_reason: string | null;
  paused_at: string | null;
  active_variants: number;
  auto_pauses_30d: number;
  today: {
    today_sent: number;
    week_sent: number;
    today_failed: number;
    today_skipped: number;
  };
  reply_rate_30d: { sent_30d: number; replied_30d: number; reply_rate_pct: number };
  bounce_rate_7d: { sent: number; bounces: number; rate: number };
}

interface VariantStats {
  variant_id: string;
  founder_id: string;
  label: string;
  is_active: boolean;
  sent: number;
  replied: number;
  reply_rate_pct: number;
}

interface HealthData {
  founders: FounderStats[];
  aggregate: {
    pool_runway_days: number;
    total_sent_today: number;
    total_failed_today: number;
    total_skipped_today: number;
  };
  top_variants: VariantStats[];
}

const BOUNCE_THRESHOLD = 0.05; // 5%
const REPLY_RATE_FLOOR = 0.5;  // 0.5%
const MIN_ACTIVE_VARIANTS = 2;

export function OverviewTab() {
  const [data, setData] = useState<HealthData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = (await fetch('/api/cron/email-tool/health').then(r => r.json())) as HealthData & { error?: string };
      if (r.error) {
        setError(r.error);
        setData(null);
      } else {
        setData(r);
        setError(null);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'load failed');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function pauseFounder(id: string) {
    if (!window.confirm('Pause this founder\'s sends?')) return;
    const res = await fetch(`/api/cron/email-tool/founder/${id}/pause`, { method: 'POST' });
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      window.alert(d.error ?? 'pause failed');
      return;
    }
    load();
  }

  async function resumeFounder(id: string) {
    const res = await fetch(`/api/cron/email-tool/founder/${id}/resume`, { method: 'POST' });
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      window.alert(d.error ?? 'resume failed');
      return;
    }
    load();
  }

  if (loading) return <div className="text-sm text-gray-500 p-8 text-center">Loading...</div>;
  if (error) return <div className="text-sm text-red-600 p-8 text-center">Error: {error}</div>;
  if (!data) return null;

  const { founders, aggregate, top_variants } = data;

  return (
    <div className="space-y-6">
      {/* Aggregate row */}
      <section className="bg-white border border-gray-200 rounded-lg p-4">
        <div className="grid grid-cols-4 gap-4 text-sm">
          <Stat label="Pool runway" value={
            aggregate.pool_runway_days === 0
              ? <span className="text-red-700">EXHAUSTED</span>
              : <span>{aggregate.pool_runway_days} days</span>
          } />
          <Stat label="Sent today" value={<span className="text-green-700">{aggregate.total_sent_today}</span>} />
          <Stat label="Failed today" value={<span className="text-red-700">{aggregate.total_failed_today}</span>} />
          <Stat label="Skipped today" value={<span className="text-gray-700">{aggregate.total_skipped_today}</span>} />
        </div>
      </section>

      {/* Per-founder cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {founders.map(f => <FounderCard key={f.id} f={f} onPause={pauseFounder} onResume={resumeFounder} />)}
      </div>

      {/* Top variants */}
      <section className="bg-white border border-gray-200 rounded-lg p-4">
        <h2 className="text-lg font-semibold mb-3">Top Variants (last 30 days)</h2>
        {top_variants.length === 0 ? (
          <p className="text-sm text-gray-500 italic">No variant performance data yet.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-gray-500 text-xs">
                <th className="py-1">Variant</th>
                <th className="py-1">Active</th>
                <th className="py-1 text-right">Sent</th>
                <th className="py-1 text-right">Replied</th>
                <th className="py-1 text-right">Reply rate</th>
              </tr>
            </thead>
            <tbody>
              {top_variants.map(v => (
                <tr key={v.variant_id} className="border-t border-gray-100">
                  <td className="py-1">{v.label}</td>
                  <td className="py-1">{v.is_active ? '✓' : '—'}</td>
                  <td className="py-1 text-right">{v.sent}</td>
                  <td className="py-1 text-right">{v.replied}</td>
                  <td className="py-1 text-right font-mono">{v.reply_rate_pct.toFixed(1)}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <div className="text-xs text-gray-500 uppercase tracking-wide">{label}</div>
      <div className="text-lg font-semibold mt-0.5">{value}</div>
    </div>
  );
}

function FounderCard({
  f,
  onPause,
  onResume,
}: {
  f: FounderStats;
  onPause: (id: string) => void;
  onResume: (id: string) => void;
}) {
  const bounceRatePct = f.bounce_rate_7d.rate * 100;
  const bounceOK = f.bounce_rate_7d.rate <= BOUNCE_THRESHOLD;
  const replyRateOK = f.reply_rate_30d.reply_rate_pct >= REPLY_RATE_FLOOR;
  const variantsOK = f.active_variants >= MIN_ACTIVE_VARIANTS;

  let statusBadge: { text: string; color: string };
  if (f.paused) {
    statusBadge = { text: 'Paused', color: 'bg-red-100 text-red-800' };
  } else if (!bounceOK || !variantsOK || !f.gmail_connected) {
    statusBadge = { text: 'Unhealthy', color: 'bg-yellow-100 text-yellow-800' };
  } else {
    statusBadge = { text: 'Healthy', color: 'bg-green-100 text-green-800' };
  }

  return (
    <div className="bg-white border border-gray-200 rounded-lg p-4">
      <header className="flex items-start justify-between mb-3">
        <div>
          <h3 className="font-semibold">{f.name}</h3>
          <p className="text-xs text-gray-500 font-mono">{f.email}</p>
        </div>
        <span className={`text-xs px-2 py-0.5 rounded ${statusBadge.color}`}>{statusBadge.text}</span>
      </header>

      {f.paused && f.paused_reason && (
        <div className="bg-red-50 border border-red-200 rounded p-2 text-xs text-red-800 mb-3">
          Paused {f.paused_at ? new Date(f.paused_at).toLocaleString() : ''}
          <br />Reason: <code>{f.paused_reason}</code>
        </div>
      )}

      <div className="space-y-1.5 text-sm">
        <Row label="Sends today" value={
          <>
            <span className="font-mono">{f.today.today_sent}</span>
            {f.today.today_failed > 0 && <span className="text-red-600 text-xs ml-1">/{f.today.today_failed}f</span>}
            {f.today.today_skipped > 0 && <span className="text-gray-500 text-xs ml-1">/{f.today.today_skipped}s</span>}
          </>
        } />
        <Row label="Sends last 7d" value={<span className="font-mono">{f.today.week_sent}</span>} />
        <Row label="Bounce rate (7d)" value={
          <span className={`font-mono ${bounceOK ? 'text-green-700' : 'text-red-700'}`}>
            {bounceRatePct.toFixed(1)}% {bounceOK ? '✓' : '⚠'}
          </span>
        } />
        <Row label="Reply rate (30d)" value={
          <span className={`font-mono ${replyRateOK || f.reply_rate_30d.sent_30d < 50 ? 'text-gray-700' : 'text-yellow-700'}`}>
            {f.reply_rate_30d.reply_rate_pct.toFixed(1)}%
            <span className="text-gray-400 text-xs ml-1">({f.reply_rate_30d.replied_30d}/{f.reply_rate_30d.sent_30d})</span>
          </span>
        } />
        <Row label="Active variants" value={
          <span className={`font-mono ${variantsOK ? 'text-green-700' : 'text-red-700'}`}>
            {f.active_variants} {variantsOK ? '✓' : '⚠ need ≥2'}
          </span>
        } />
        <Row label="Gmail OAuth" value={
          f.gmail_connected
            ? <span className="text-green-700 text-xs">✓ connected</span>
            : <span className="text-red-700 text-xs">✗ disconnected</span>
        } />
        <Row label="Auto-pauses (30d)" value={<span className="font-mono">{f.auto_pauses_30d}</span>} />
      </div>

      <div className="mt-3 pt-3 border-t border-gray-100">
        {f.paused ? (
          <button
            onClick={() => onResume(f.id)}
            className="w-full px-3 py-1.5 bg-green-100 hover:bg-green-200 text-green-800 rounded text-sm font-medium"
          >
            Resume
          </button>
        ) : (
          <button
            onClick={() => onPause(f.id)}
            className="w-full px-3 py-1.5 bg-red-50 hover:bg-red-100 text-red-700 rounded text-sm font-medium"
          >
            Pause
          </button>
        )}
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between text-sm">
      <span className="text-gray-500 text-xs">{label}</span>
      <span>{value}</span>
    </div>
  );
}
