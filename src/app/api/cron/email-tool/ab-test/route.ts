// GET /api/cron/email-tool/ab-test — variant-level A/B test analytics.
//
// Pulls per-variant sent/replied counts from the existing
// `email_send_variant_stats_30d()` RPC (defined in 026_email_send_analytics.sql)
// — which already filters real replies via leads.first_reply_at (auto-reply
// detector + bounce parser block fakes BEFORE that column gets populated).
// Joins to email_template_variants for label/subject/body. Joins to
// team_members for founder name. Computes Wilson 95% confidence intervals
// in JS so the UI can render error bars / overlap-aware winner highlighting.
//
// Lives under /api/cron/* per project convention (Vercel deployment-
// protection HTML-404 workaround). Not actually a cron route. Admin-only.
export const maxDuration = 30;

import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/lib/session';
import { createAdminClient } from '@/lib/supabase/admin';

interface RpcRow {
  variant_id: string;
  founder_id: string;
  label: string;
  is_active: boolean;
  sent: number;
  replied: number;
  reply_rate_pct: number;
}

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
  // Open-tracking pixel data. opened = # rows with at least one
  // FILTERED open (UA + timing heuristic passed). open_rate_pct =
  // opened / sent.
  opened: number;
  open_rate_pct: number;
  // Wilson 95% CI bounds for the reply rate, as percentages (0–100).
  // null when sent === 0 (no estimate possible).
  ci_low_pct: number | null;
  ci_high_pct: number | null;
  ci_width_pct: number | null;
}

interface FollowupTotals {
  /** Followup queue rows whose sent_at is today (PT) — successfully sent. */
  sent_today: number;
  /** Followup queue rows in pending status — scheduled but not yet sent. */
  pending: number;
}

// Wilson score interval for a binomial proportion at 95% confidence.
// Better than normal-approx when sample sizes are small or p is near 0/1.
function wilson95(sent: number, replied: number): { low: number; high: number } | null {
  if (sent <= 0) return null;
  const z = 1.96;
  const p = replied / sent;
  const denom = 1 + (z * z) / sent;
  const center = (p + (z * z) / (2 * sent)) / denom;
  const margin = (z * Math.sqrt((p * (1 - p) + (z * z) / (4 * sent)) / sent)) / denom;
  return {
    low: Math.max(0, center - margin),
    high: Math.min(1, center + margin),
  };
}

export async function GET(req: NextRequest) {
  const session = await getSessionFromRequest(req);
  if (!session) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }
  if (!session.is_admin) {
    return NextResponse.json({ error: 'admin only' }, { status: 403 });
  }

  const url = new URL(req.url);
  const founderFilter = url.searchParams.get('founder'); // UUID
  const activeOnly = url.searchParams.get('active_only') === 'true';

  const supabase = createAdminClient();

  // 1) RPC for sent/replied counts. Pre-filters auto-replies/bounces by
  //    construction: the RPC counts leads.first_reply_at, which the Gmail
  //    sync only populates for real human replies.
  const { data: statsData, error: statsErr } = await supabase.rpc('email_send_variant_stats_30d');
  if (statsErr) {
    return NextResponse.json({ error: 'rpc_failed', detail: statsErr.message }, { status: 500 });
  }
  const stats = (statsData ?? []) as RpcRow[];

  // 2) Pull variants for label/subject/body. Filter clients-side because
  //    the RPC already returns the variant_id we need to join on.
  const variantIds = stats.map(s => s.variant_id);
  if (variantIds.length === 0) {
    return NextResponse.json({ variants: [] });
  }
  const { data: variantRows, error: vErr } = await supabase
    .from('email_template_variants')
    .select('id, subject_template, body_template, is_followup')
    .in('id', variantIds);
  if (vErr) {
    return NextResponse.json({ error: 'variant_lookup_failed', detail: vErr.message }, { status: 500 });
  }
  const variantById = new Map(
    ((variantRows ?? []) as Array<{ id: string; subject_template: string; body_template: string; is_followup: boolean }>)
      .map(v => [v.id, v])
  );

  // 2a) Open counts per variant. Single query, COUNT(*) WHERE opened_at IS
  //     NOT NULL grouped by template_variant_id. PostgREST doesn't expose
  //     GROUP BY directly through the JS client, so we ask for every
  //     matching row's variant id (one column) and bucket in JS. With the
  //     partial index idx_queue_opened_per_variant this stays fast.
  const { data: openedRows, error: openErr } = await supabase
    .from('email_send_queue')
    .select('template_variant_id')
    .in('template_variant_id', variantIds)
    .not('opened_at', 'is', null);
  if (openErr) {
    return NextResponse.json({ error: 'opens_lookup_failed', detail: openErr.message }, { status: 500 });
  }
  const openedByVariant = new Map<string, number>();
  for (const r of (openedRows ?? []) as Array<{ template_variant_id: string }>) {
    openedByVariant.set(r.template_variant_id, (openedByVariant.get(r.template_variant_id) ?? 0) + 1);
  }

  // 3) Pull founder names. 3 rows total — no need to chunk.
  const { data: foundersData } = await supabase
    .from('team_members')
    .select('id, name');
  const founderNameById = new Map(
    ((foundersData ?? []) as Array<{ id: string; name: string }>).map(f => [f.id, f.name])
  );

  // 4) Stitch.
  const variants: VariantStat[] = stats
    .filter(s => !founderFilter || s.founder_id === founderFilter)
    .filter(s => !activeOnly || s.is_active)
    .map(s => {
      const ci = wilson95(Number(s.sent), Number(s.replied));
      const v = variantById.get(s.variant_id);
      const sent = Number(s.sent);
      const opened = openedByVariant.get(s.variant_id) ?? 0;
      return {
        id: s.variant_id,
        founder_id: s.founder_id,
        founder_name: founderNameById.get(s.founder_id) ?? null,
        label: s.label,
        subject_template: v?.subject_template ?? '',
        body_template: v?.body_template ?? '',
        is_active: s.is_active,
        is_followup: v?.is_followup ?? false,
        sent,
        replied: Number(s.replied),
        reply_rate_pct: Number(s.reply_rate_pct),
        opened,
        open_rate_pct: sent > 0 ? Math.round((opened / sent) * 1000) / 10 : 0,
        ci_low_pct: ci ? Math.round(ci.low * 1000) / 10 : null,
        ci_high_pct: ci ? Math.round(ci.high * 1000) / 10 : null,
        ci_width_pct: ci ? Math.round((ci.high - ci.low) * 1000) / 10 : null,
      };
    });

  // 5) Today's follow-up totals — small banner above the variants table.
  //    "today" = PT calendar date because that's the campaign's reference
  //    frame. We use UTC bounds: PT midnight → next PT midnight.
  const todayPt = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
  const todayStartIso = new Date(`${todayPt}T00:00:00-08:00`).toISOString();
  const tomorrowStartIso = new Date(new Date(`${todayPt}T00:00:00-08:00`).getTime() + 24 * 3_600_000).toISOString();
  const [sentTodayRes, pendingRes] = await Promise.all([
    supabase
      .from('email_send_queue')
      .select('id', { count: 'exact', head: true })
      .not('parent_queue_id', 'is', null)
      .eq('status', 'sent')
      .gte('sent_at', todayStartIso)
      .lt('sent_at', tomorrowStartIso),
    supabase
      .from('email_send_queue')
      .select('id', { count: 'exact', head: true })
      .not('parent_queue_id', 'is', null)
      .eq('status', 'pending'),
  ]);
  const followups: FollowupTotals = {
    sent_today: sentTodayRes.count ?? 0,
    pending: pendingRes.count ?? 0,
  };

  return NextResponse.json({ variants, followups });
}
