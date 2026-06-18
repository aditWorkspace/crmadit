'use client';

import { useEffect, useState } from 'react';

interface VariantStat {
  variant: string;
  label: string;
  sent: number;
  opened: number;
  open_rate_pct: number;
  replied: number;
  reply_rate_pct: number;
  ci_low_pct: number | null;
  ci_high_pct: number | null;
}
interface AbData {
  variants: VariantStat[];
  winner: string | null;
  total_sent: number;
  min_sends_for_winner: number;
}

const fmt = (n: number) => `${n}%`;

export function OutreachABCard() {
  const [data, setData] = useState<AbData | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const r = await fetch('/api/cron/email-tool/ab-visual').then(x => x.json());
        if (!alive) return;
        if (r.error) setErr(r.error);
        else setData(r);
      } catch { if (alive) setErr('failed to load'); }
      finally { if (alive) setLoading(false); }
    };
    load();
    const t = setInterval(load, 60_000); // refresh each minute
    return () => { alive = false; clearInterval(t); };
  }, []);

  return (
    <section className="rounded-xl border border-gray-200 bg-white p-5">
      <div className="flex items-baseline justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-sm font-semibold text-gray-700">Outreach A/B test</h2>
          <p className="text-xs text-gray-500 mt-0.5">3 email variants (same image + page) — which gets the best open &amp; reply rate</p>
        </div>
        {data && <span className="text-xs font-mono text-gray-500">{data.total_sent} sent</span>}
      </div>

      {loading && <div className="mt-4 text-sm text-gray-400 animate-pulse">loading…</div>}
      {err && <div className="mt-4 text-sm text-red-500">{err}</div>}
      {data && data.total_sent === 0 && (
        <div className="mt-4 text-sm text-gray-400">No A/B sends yet — results appear after the morning send goes out.</div>
      )}

      {data && data.total_sent > 0 && (
        <>
          <div className="mt-4 grid grid-cols-1 sm:grid-cols-3 gap-3">
            {data.variants.map(v => {
              const isWinner = data.winner === v.variant;
              return (
                <div key={v.variant}
                  className={`rounded-lg border p-4 ${isWinner ? 'border-emerald-300 bg-emerald-50' : 'border-gray-200 bg-gray-50'}`}>
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold uppercase tracking-wide text-gray-600">{v.label}</span>
                    {isWinner && <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-emerald-600 text-white">WINNER</span>}
                  </div>
                  <div className="mt-3 flex items-end gap-4">
                    <div>
                      <div className="text-2xl font-semibold tabular-nums text-gray-900">{fmt(v.reply_rate_pct)}</div>
                      <div className="text-[11px] text-gray-500 uppercase tracking-wide">reply rate</div>
                    </div>
                    <div>
                      <div className="text-lg font-semibold tabular-nums text-gray-700">{fmt(v.open_rate_pct)}</div>
                      <div className="text-[11px] text-gray-500 uppercase tracking-wide">open rate</div>
                    </div>
                  </div>
                  <div className="mt-2 font-mono text-[11px] text-gray-500">
                    {v.replied}/{v.sent} replied · {v.opened} opened
                  </div>
                  {v.ci_low_pct != null && (
                    <div className="font-mono text-[11px] text-gray-400">reply 95% CI {v.ci_low_pct}–{v.ci_high_pct}%</div>
                  )}
                </div>
              );
            })}
          </div>
          <p className="mt-3 text-[11px] text-gray-400">
            {data.winner
              ? `Variant ${data.winner} is the statistical winner (its 95% reply-rate interval clears the others).`
              : `No clear winner yet — declared once one variant's 95% reply-rate interval separates from the rest (≥${data.min_sends_for_winner} sends each). Open rate moves within hours; replies build over days.`}
          </p>
        </>
      )}
    </section>
  );
}
