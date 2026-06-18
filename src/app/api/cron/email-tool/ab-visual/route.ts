// GET /api/cron/email-tool/ab-visual — per-variant (A/B/C) results for the
// visual cold-email A/B test. Each fresh visual send carries a `variant` on
// email_send_queue; this groups by it and reports sends / open-rate /
// reply-rate + a Wilson 95% CI on the reply rate and a winner when one
// variant's CI clears the others. Admin-only.
export const runtime = 'nodejs';
export const maxDuration = 30;

import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/lib/session';
import { createAdminClient } from '@/lib/supabase/admin';

const MIN_SENDS_FOR_WINNER = 30;

// Wilson score interval (95%) for a binomial proportion — robust for small n.
function wilson95(n: number, k: number): { low: number; high: number } | null {
  if (n <= 0) return null;
  const z = 1.96;
  const p = k / n;
  const denom = 1 + (z * z) / n;
  const center = (p + (z * z) / (2 * n)) / denom;
  const margin = (z * Math.sqrt((p * (1 - p) + (z * z) / (4 * n)) / n)) / denom;
  return { low: Math.max(0, center - margin), high: Math.min(1, center + margin) };
}

export async function GET(req: NextRequest) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  if (!session.is_admin) return NextResponse.json({ error: 'admin only' }, { status: 403 });

  const supabase = createAdminClient();
  // All variant-tagged fresh sends (variant only exists on visual fresh rows).
  const { data, error } = await supabase
    .from('email_send_queue')
    .select('variant, opened_at, replied_at')
    .eq('status', 'sent')
    .not('variant', 'is', null)
    .limit(50_000);
  if (error) return NextResponse.json({ error: 'database_error', detail: error.message }, { status: 500 });

  const rows = (data ?? []) as Array<{ variant: string; opened_at: string | null; replied_at: string | null }>;
  const agg: Record<string, { sent: number; opened: number; replied: number }> = { A: { sent: 0, opened: 0, replied: 0 }, B: { sent: 0, opened: 0, replied: 0 }, C: { sent: 0, opened: 0, replied: 0 } };
  for (const r of rows) {
    const a = (agg[r.variant] ??= { sent: 0, opened: 0, replied: 0 });
    a.sent++;
    if (r.opened_at) a.opened++;
    if (r.replied_at) a.replied++;
  }

  const variants = (['A', 'B', 'C'] as const).map(v => {
    const a = agg[v];
    const ci = wilson95(a.sent, a.replied);
    return {
      variant: v,
      label: { A: 'A · mutual connection', B: 'B · research / learning ask', C: 'C · short, no-pitch' }[v],
      sent: a.sent,
      opened: a.opened,
      open_rate_pct: a.sent ? Math.round((1000 * a.opened) / a.sent) / 10 : 0,
      replied: a.replied,
      reply_rate_pct: a.sent ? Math.round((1000 * a.replied) / a.sent) / 10 : 0,
      ci_low_pct: ci ? Math.round(ci.low * 1000) / 10 : null,
      ci_high_pct: ci ? Math.round(ci.high * 1000) / 10 : null,
    };
  });

  // Winner = highest reply rate whose CI lower bound clears every other's upper
  // bound (non-overlap ⇒ statistically separated), once all have enough sends.
  let winner: string | null = null;
  const eligible = variants.filter(v => v.sent >= MIN_SENDS_FOR_WINNER && v.ci_low_pct != null);
  if (eligible.length >= 2) {
    const top = [...eligible].sort((a, b) => b.reply_rate_pct - a.reply_rate_pct)[0];
    if (eligible.every(o => o.variant === top.variant || (top.ci_low_pct! > o.ci_high_pct!))) winner = top.variant;
  }

  const total_sent = variants.reduce((s, v) => s + v.sent, 0);
  return NextResponse.json({ variants, winner, total_sent, min_sends_for_winner: MIN_SENDS_FOR_WINNER });
}
