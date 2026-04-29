// Per-tick pre-send safety checks. Each check is a pure async function
// that takes context and returns a SafetyVerdict. The tick handler calls
// these in order before issuing the actual Gmail API call. See spec
// §6 step ⑤a + §11 (safety thresholds).
//
// Fail-open semantics: when an RPC or query returns an error, the check
// returns { ok: true } so a transient DB blip doesn't halt the entire
// pipeline. The exception is checkActiveVariant, which fails-closed
// because zero active variants makes a render impossible.

import type { createAdminClient } from '@/lib/supabase/admin';
import { SAFETY_LIMITS } from './safety-limits';

type Supa = ReturnType<typeof createAdminClient>;

// ---------------------------------------------------------------------------
// SafetyVerdict
// ---------------------------------------------------------------------------

export type SafetyVerdict =
  | { ok: true }
  | {
      ok: false;
      outcome: 'skip' | 'fail' | 'pause_account' | 'defer';
      reason: string;
      defer_seconds?: number; // only set when outcome === 'defer'
    };

// ---------------------------------------------------------------------------
// checkBounceRate — auto-pause if 7-day bounce rate > 5%
// ---------------------------------------------------------------------------

export async function checkBounceRate(supabase: Supa, accountId: string): Promise<SafetyVerdict> {
  const { data, error } = await supabase.rpc('email_send_bounce_rate_7d', { p_account_id: accountId });
  if (error || data == null) return { ok: true }; // Fail-open: don't block sends if RPC errors
  const rate = (data as { rate?: number }).rate ?? 0;
  if (rate > SAFETY_LIMITS.BOUNCE_RATE_PAUSE_THRESHOLD) {
    const ratePct = (rate * 100).toFixed(1);
    const thresholdPct = (SAFETY_LIMITS.BOUNCE_RATE_PAUSE_THRESHOLD * 100).toFixed(0);
    return {
      ok: false,
      outcome: 'pause_account',
      reason: `bounce_rate_${ratePct}%_exceeds_${thresholdPct}%`,
    };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// checkPerSecondPace — defer if last send was <5s ago
// ---------------------------------------------------------------------------

export async function checkPerSecondPace(supabase: Supa, accountId: string): Promise<SafetyVerdict> {
  const result = await supabase
    .from('email_send_queue')
    .select('sent_at')
    .eq('account_id', accountId)
    .eq('status', 'sent')
    .order('sent_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  // result is { data, error } from real Supabase; the data row has sent_at
  const last = (result as { data?: { sent_at: string } | null })?.data ?? (result as { sent_at?: string } | null);
  if (!last?.sent_at) return { ok: true };
  const elapsedMs = Date.now() - new Date(last.sent_at as string).getTime();
  const minMs = SAFETY_LIMITS.MIN_INTER_SEND_GAP_SECONDS_HARD_FLOOR * 1000;
  if (elapsedMs < minMs) {
    return {
      ok: false,
      outcome: 'defer',
      reason: 'per_second_pace_too_fast',
      defer_seconds: 15,
    };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// checkRecipientDomainOnce — skip if same-domain already sent today
// ---------------------------------------------------------------------------

export async function checkRecipientDomainOnce(
  supabase: Supa,
  accountId: string,
  recipientEmail: string,
  todayStartIso: string,
): Promise<SafetyVerdict> {
  const domain = recipientEmail.split('@')[1]?.toLowerCase();
  if (!domain) return { ok: true }; // No @ sign — let it through; render error happens elsewhere
  const { count } = await supabase
    .from('email_send_queue')
    .select('id', { count: 'exact', head: true })
    .eq('account_id', accountId)
    .eq('status', 'sent')
    .gte('sent_at', todayStartIso)
    .ilike('recipient_email', `%@${domain}`);
  if ((count ?? 0) >= SAFETY_LIMITS.MAX_SENDS_PER_DOMAIN_PER_ACCOUNT_PER_DAY) {
    return {
      ok: false,
      outcome: 'skip',
      reason: `domain_${domain}_already_sent_today`,
    };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// checkReplySinceQueue — skip if recipient replied to us in last 4h
//
// Catches the race where a founder's earlier send triggers a reply that
// arrives in the CRM before another scheduled send goes out to the same
// contact. Any inbound interaction in the last 4h where the lead's
// contact_email matches the recipient is treated as a "replied" signal.
// ---------------------------------------------------------------------------

export async function checkReplySinceQueue(supabase: Supa, recipientEmail: string): Promise<SafetyVerdict> {
  const fourHoursAgo = new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString();
  // Find leads whose contact_email matches the recipient AND have an
  // inbound interaction in the last 4 hours.
  const { data } = await supabase
    .from('interactions')
    .select('id, leads!inner(contact_email)')
    .eq('type', 'email_inbound')
    .gte('occurred_at', fourHoursAgo)
    .ilike('leads.contact_email', recipientEmail)
    .limit(1);
  if (data && data.length > 0) {
    return {
      ok: false,
      outcome: 'skip',
      reason: 'replied_during_campaign',
    };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// checkActiveVariant — fail if founder has 0 active variants
//
// Fails-closed (unlike the other checks) because if there are no active
// variants the render step will throw anyway — better to surface this
// as a config error immediately.
// ---------------------------------------------------------------------------

export async function checkActiveVariant(supabase: Supa, founderId: string): Promise<SafetyVerdict> {
  const { count } = await supabase
    .from('email_template_variants')
    .select('id', { count: 'exact', head: true })
    .eq('founder_id', founderId)
    .eq('is_active', true);
  if ((count ?? 0) === 0) {
    return {
      ok: false,
      outcome: 'fail',
      reason: 'no_active_variants',
    };
  }
  return { ok: true };
}
