// Admin endpoint: aggregates per-founder health stats + aggregate row.
// Used by the Overview tab. One round-trip from the client.

import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/lib/session';
import { createAdminClient } from '@/lib/supabase/admin';
import {
  getFounderStatsToday,
  getFounderReplyRate30d,
  getFounderBounceRate7d,
  getVariantStats30d,
  getPoolRunwayDays,
} from '@/lib/email-tool/health';

const TEAM_NAMES = ['Adit', 'Srijay', 'Asim'] as const;

export async function GET(req: NextRequest) {
  const session = await getSessionFromRequest(req);
  if (!session?.is_admin) {
    return NextResponse.json({ error: 'admin only' }, { status: 403 });
  }

  const supabase = createAdminClient();

  const { data: foundersData } = await supabase
    .from('team_members')
    .select('id, name, email, gmail_connected, email_send_paused, email_send_paused_reason, email_send_paused_at');

  const allFounders = (foundersData ?? []) as Array<{
    id: string;
    name: string;
    email: string;
    gmail_connected: boolean;
    email_send_paused: boolean;
    email_send_paused_reason: string | null;
    email_send_paused_at: string | null;
  }>;

  // Sort by canonical TEAM_NAMES order
  const sorted = allFounders.sort((a, b) => {
    const ai = TEAM_NAMES.findIndex(n => a.name.startsWith(n));
    const bi = TEAM_NAMES.findIndex(n => b.name.startsWith(n));
    return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
  });

  // Active variant count per founder (one query)
  const founderIds = sorted.map(f => f.id);
  const { data: variantsData } = await supabase
    .from('email_template_variants')
    .select('founder_id, is_active')
    .in('founder_id', founderIds);
  const activeVariantCount = new Map<string, number>();
  for (const v of (variantsData ?? []) as Array<{ founder_id: string; is_active: boolean }>) {
    if (v.is_active) {
      activeVariantCount.set(v.founder_id, (activeVariantCount.get(v.founder_id) ?? 0) + 1);
    }
  }

  // Auto-pauses last 30 days per founder (count of email_send_errors with
  // account_id matching and error_class='crash' OR pause-related reason)
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const autoPauses30d = new Map<string, number>();
  for (const f of sorted) {
    const { count } = await supabase
      .from('email_send_errors')
      .select('id', { count: 'exact', head: true })
      .eq('account_id', f.id)
      .gte('occurred_at', thirtyDaysAgo);
    autoPauses30d.set(f.id, count ?? 0);
  }

  // Per-founder rich stats (parallel)
  const founderStats = await Promise.all(
    sorted.map(async f => {
      const [today, replyRate, bounceRate] = await Promise.all([
        getFounderStatsToday(supabase, f.id),
        getFounderReplyRate30d(supabase, f.id),
        getFounderBounceRate7d(supabase, f.id),
      ]);
      return {
        id: f.id,
        name: f.name,
        email: f.email,
        gmail_connected: f.gmail_connected,
        paused: f.email_send_paused,
        paused_reason: f.email_send_paused_reason,
        paused_at: f.email_send_paused_at,
        active_variants: activeVariantCount.get(f.id) ?? 0,
        auto_pauses_30d: autoPauses30d.get(f.id) ?? 0,
        today,
        reply_rate_30d: replyRate,
        bounce_rate_7d: bounceRate,
      };
    })
  );

  // Aggregate
  const totalSentToday = founderStats.reduce((s, f) => s + f.today.today_sent, 0);
  const totalFailedToday = founderStats.reduce((s, f) => s + f.today.today_failed, 0);
  const totalSkippedToday = founderStats.reduce((s, f) => s + f.today.today_skipped, 0);
  const poolRunwayDays = await getPoolRunwayDays(supabase);

  // Top variants
  const topVariants = (await getVariantStats30d(supabase)).slice(0, 8);

  return NextResponse.json({
    founders: founderStats,
    aggregate: {
      pool_runway_days: poolRunwayDays,
      total_sent_today: totalSentToday,
      total_failed_today: totalFailedToday,
      total_skipped_today: totalSkippedToday,
    },
    top_variants: topVariants,
  });
}
