// Read-only accessors for the analytics RPCs added in migration 026.
// Used by the Overview tab + daily digest.

import type { createAdminClient } from '@/lib/supabase/admin';

type Supa = ReturnType<typeof createAdminClient>;

export interface VariantStats30d {
  variant_id: string;
  founder_id: string;
  label: string;
  is_active: boolean;
  sent: number;
  replied: number;
  reply_rate_pct: number;
}

export interface FounderStatsToday {
  today_sent: number;
  week_sent: number;
  today_failed: number;
  today_skipped: number;
}

export interface FounderReplyRate30d {
  sent_30d: number;
  replied_30d: number;
  reply_rate_pct: number;
}

export async function getVariantStats30d(supabase: Supa): Promise<VariantStats30d[]> {
  const { data, error } = await supabase.rpc('email_send_variant_stats_30d');
  if (error || !data) return [];
  // RPC returns rows; PostgREST encodes them as a flat array of objects
  return (data as Array<{
    variant_id: string;
    founder_id: string;
    label: string;
    is_active: boolean;
    sent: number;
    replied: number;
    reply_rate_pct: number;
  }>).map(r => ({
    ...r,
    sent: Number(r.sent),
    replied: Number(r.replied),
    reply_rate_pct: Number(r.reply_rate_pct),
  }));
}

export async function getFounderStatsToday(
  supabase: Supa,
  founderId: string,
): Promise<FounderStatsToday> {
  const { data, error } = await supabase.rpc('email_send_founder_stats_today', {
    p_founder_id: founderId,
  });
  if (error || !data) {
    return { today_sent: 0, week_sent: 0, today_failed: 0, today_skipped: 0 };
  }
  const d = data as Partial<FounderStatsToday>;
  return {
    today_sent: Number(d.today_sent ?? 0),
    week_sent: Number(d.week_sent ?? 0),
    today_failed: Number(d.today_failed ?? 0),
    today_skipped: Number(d.today_skipped ?? 0),
  };
}

export async function getFounderReplyRate30d(
  supabase: Supa,
  founderId: string,
): Promise<FounderReplyRate30d> {
  const { data, error } = await supabase.rpc('email_send_founder_reply_rate_30d', {
    p_founder_id: founderId,
  });
  if (error || !data) {
    return { sent_30d: 0, replied_30d: 0, reply_rate_pct: 0 };
  }
  const d = data as Partial<FounderReplyRate30d>;
  return {
    sent_30d: Number(d.sent_30d ?? 0),
    replied_30d: Number(d.replied_30d ?? 0),
    reply_rate_pct: Number(d.reply_rate_pct ?? 0),
  };
}

/**
 * Bounce-rate-7d wrapper. Reuses the RPC from migration 022.
 */
export async function getFounderBounceRate7d(
  supabase: Supa,
  founderId: string,
): Promise<{ sent: number; bounces: number; rate: number }> {
  const { data, error } = await supabase.rpc('email_send_bounce_rate_7d', {
    p_account_id: founderId,
  });
  if (error || !data) return { sent: 0, bounces: 0, rate: 0 };
  const d = data as { sent: number; bounces: number; rate: number };
  return {
    sent: Number(d.sent),
    bounces: Number(d.bounces),
    rate: Number(d.rate),
  };
}

/**
 * Pool runway in days at full volume (1200/day). Returns 0 when the
 * pool is exhausted.
 */
export async function getPoolRunwayDays(supabase: Supa): Promise<number> {
  const { data } = await supabase.rpc('email_tool_fresh_remaining');
  const remaining = Number(data ?? 0);
  if (remaining === 0) return 0;
  return Math.floor(remaining / 1200);
}
