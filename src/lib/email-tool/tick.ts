// Drain phase of the minute-tick. PR 3 ships drain only; PR 4 adds the
// orphan-recovery sweep + self-trigger + crash-counter wiring before
// this. See spec §6.

import type { createAdminClient } from '@/lib/supabase/admin';
import { sendCampaignEmail, type SendOutcome } from './send';
import { SAFETY_LIMITS } from './safety-limits';
import {
  checkBounceRate, checkPerSecondPace, checkRecipientDomainOnce,
  checkReplySinceQueue, checkActiveVariant,
  type SafetyVerdict,
} from './safety-checks';
import { log } from './log';
import { createLeadFromOutreach } from '@/lib/leads/auto-create';
import { getCampaignGmailClient, type CampaignGmailClient } from '@/lib/gmail/client';
import type { SendMode } from './types';
import { detectAndAbortOrphans } from './orphan-recovery';
import { runDailyStart } from './start';
import { WEEKDAY_START_TIMES_PT } from './schedule';

type Supa = ReturnType<typeof createAdminClient>;

export interface RunTickOpts {
  /** Clock injection for testability (default: new Date()). */
  now?: Date;
  /** Gmail-client factory injection for testability. Defaults to getGmailClientForMember. */
  gmailClientForMember?: (memberId: string) => Promise<CampaignGmailClient>;
}

export interface RunTickStats {
  processed: number;
  sent: number;
  failed: number;
  skipped: number;
}

interface QueueRow {
  id: string;
  campaign_id: string;
  account_id: string;
  recipient_email: string;
  recipient_name: string | null;
  recipient_company: string | null;
  template_variant_id: string;
  send_at: string;
  attempts: number;
}

interface FounderRow {
  id: string;
  name: string;
  email: string;
  email_send_paused: boolean;
}

interface VariantRow {
  subject_template: string;
  body_template: string;
}

export async function runTick(supabase: Supa, opts: RunTickOpts = {}): Promise<RunTickStats> {
  const now = opts.now ?? new Date();
  const startMs = Date.now();
  const stats: RunTickStats = { processed: 0, sent: 0, failed: 0, skipped: 0 };

  // ── Phase -1: orphan recovery ────────────────────────────────────────
  // Catches campaigns that were claimed but whose queue insert never
  // landed. Without this, today's campaign silently forfeits because the
  // self-trigger below would see already_started=true.
  await detectAndAbortOrphans(supabase, now);

  // ── Phase 0: self-trigger ────────────────────────────────────────────
  // If now ≥ today's scheduled start AND no campaign exists for today
  // AND the schedule is enabled, fire runDailyStart inline.
  await maybeSelfTrigger(supabase, now);

  // ── 1) Crash recovery sweep ───────────────────────────────────────────
  // Per spec §6 step ②, APPEND a marker to last_error rather than clobber
  // it — preserves upstream context (e.g., the last failed safety check or
  // gmail error before the crash). Stale rows are rare so the per-row
  // round-trip is acceptable.
  const staleCutoff = new Date(now.getTime() - SAFETY_LIMITS.CRASH_RECOVERY_STALE_MINUTES * 60_000).toISOString();
  const { data: staleRows } = await supabase
    .from('email_send_queue')
    .select('id, last_error')
    .eq('status', 'sending')
    .lt('sending_started_at', staleCutoff);
  for (const stale of (staleRows ?? []) as Array<{ id: string; last_error: string | null }>) {
    const newLastError = stale.last_error
      ? `${stale.last_error} [recovered_from_stale_sending]`
      : 'recovered_from_stale_sending';
    await supabase.from('email_send_queue')
      .update({
        status: 'pending',
        sending_started_at: null,
        last_error: newLastError,
      })
      .eq('id', stale.id);
  }

  // ── 2) Active accounts ────────────────────────────────────────────────
  const { data: foundersData } = await supabase
    .from('team_members')
    .select('id, name, email, email_send_paused');
  const allFounders = (foundersData ?? []) as FounderRow[];
  const activeFounders = allFounders.filter(f => !f.email_send_paused);
  if (activeFounders.length === 0) {
    log('info', 'tick_no_active_founders');
    return stats;
  }
  const activeIds = activeFounders.map(f => f.id);

  // ── 3) Send mode + allowlist ──────────────────────────────────────────
  const { data: scheduleRow } = await supabase
    .from('email_send_schedule')
    .select('send_mode')
    .eq('id', 1)
    .single();
  const sendMode: SendMode = ((scheduleRow as { send_mode: SendMode } | null)?.send_mode) ?? 'production';
  const allowlist = (process.env.EMAIL_SEND_ALLOWLIST ?? '')
    .split(',')
    .map(s => s.trim().toLowerCase())
    .filter(Boolean);

  // ── 4) Pull due rows ──────────────────────────────────────────────────
  const { data: dueData } = await supabase
    .from('email_send_queue')
    .select('id, campaign_id, account_id, recipient_email, recipient_name, recipient_company, template_variant_id, send_at, attempts')
    .eq('status', 'pending')
    .lte('send_at', now.toISOString())
    .in('account_id', activeIds)
    .order('send_at', { ascending: true })
    .limit(SAFETY_LIMITS.TICK_BUDGET_SENDS_PER_RUN);
  const dueRows = (dueData ?? []) as QueueRow[];
  if (dueRows.length === 0) return stats;

  const todayStartIso = ptStartOfDay(now);

  // ── 5) Per-row processing ─────────────────────────────────────────────
  for (const row of dueRows) {
    if (Date.now() - startMs > SAFETY_LIMITS.TICK_BUDGET_DURATION_SECONDS * 1000) {
      log('info', 'tick_budget_exceeded', { processed: stats.processed });
      break;
    }
    stats.processed++;

    // Claim ownership: UPDATE pending → sending. If 0 rows updated, someone else got it.
    const { data: claimed } = await supabase
      .from('email_send_queue')
      .update({ status: 'sending', sending_started_at: now.toISOString() })
      .eq('id', row.id)
      .eq('status', 'pending')
      .select('id');
    if (!claimed || claimed.length === 0) {
      // Race: another tick claimed it. Skip silently.
      stats.processed--;
      continue;
    }

    const founder = activeFounders.find(f => f.id === row.account_id);
    if (!founder) {
      // Founder paused between queue load and now. Revert and continue.
      await supabase.from('email_send_queue')
        .update({ status: 'pending', sending_started_at: null })
        .eq('id', row.id);
      continue;
    }

    // Safety checks in spec §6 ⑤a order (cheap pause-trigger first, then
    // cheap defer-trigger, then table-scoped checks, with variant lookup
    // last because it hits a different table than the others).
    const checksToRun: Array<() => Promise<SafetyVerdict>> = [
      () => checkBounceRate(supabase, row.account_id),
      () => checkPerSecondPace(supabase, row.account_id),
      () => checkRecipientDomainOnce(supabase, row.account_id, row.recipient_email, todayStartIso),
      () => checkReplySinceQueue(supabase, row.recipient_email),
      () => checkActiveVariant(supabase, row.account_id),
    ];
    let safetyFail: SafetyVerdict | null = null;
    for (const check of checksToRun) {
      const v = await check();
      if (!v.ok) { safetyFail = v; break; }
    }
    if (safetyFail && !safetyFail.ok) {
      const handled = await applySafetyFailure(supabase, row, safetyFail, now);
      if (handled === 'pause_account_continue') {
        // Account paused; this row reverted to pending. Filter it out
        // for the rest of this tick.
        const idx = activeIds.indexOf(row.account_id);
        if (idx >= 0) activeIds.splice(idx, 1);
        const fIdx = activeFounders.findIndex(f => f.id === row.account_id);
        if (fIdx >= 0) activeFounders.splice(fIdx, 1);
        continue;
      }
      if (handled === 'skipped') stats.skipped++;
      else if (handled === 'failed') stats.failed++;
      continue;
    }

    // Load the variant
    const { data: variantData } = await supabase
      .from('email_template_variants')
      .select('subject_template, body_template')
      .eq('id', row.template_variant_id)
      .maybeSingle();
    const variant = variantData as VariantRow | null;
    if (!variant) {
      await supabase.from('email_send_queue')
        .update({ status: 'failed', last_error: 'variant_not_found' })
        .eq('id', row.id);
      stats.failed++;
      continue;
    }

    // Get gmail client for this founder
    let gmail: CampaignGmailClient;
    try {
      gmail = opts.gmailClientForMember
        ? await opts.gmailClientForMember(row.account_id)
        : await getCampaignGmailClient(row.account_id);
    } catch (err) {
      const e = err as Error;
      log('error', 'tick_gmail_client_error', { account_id: row.account_id, err: e.message });
      await supabase.from('email_send_errors').insert({
        campaign_id: row.campaign_id,
        account_id: row.account_id,
        queue_row_id: row.id,
        error_class: 'config_error',
        error_message: `gmail_client_init_failed: ${e.message}`,
      });
      await supabase.from('email_send_queue')
        .update({ status: 'failed', last_error: 'gmail_client_init_failed' })
        .eq('id', row.id);
      stats.failed++;
      continue;
    }

    // Send (with try/catch around the whole thing)
    let outcome: SendOutcome;
    try {
      outcome = await sendCampaignEmail({
        queueRow: { ...row, status: 'pending' as const },
        variant,
        founder: { id: founder.id, name: founder.name, email: founder.email },
        sendMode,
        allowlist,
      }, gmail);
    } catch (err) {
      const e = err as Error;
      log('error', 'tick_send_threw', { queue_row_id: row.id, err: e.message });
      await supabase.from('email_send_errors').insert({
        campaign_id: row.campaign_id,
        account_id: row.account_id,
        queue_row_id: row.id,
        error_class: 'gmail_api_error',
        error_message: `send_threw: ${e.message}`,
      });
      await supabase.from('email_send_queue')
        .update({ status: 'failed', last_error: 'send_threw' })
        .eq('id', row.id);
      stats.failed++;
      continue;
    }

    // Apply the tagged outcome
    const result = await applySendOutcome(supabase, row, founder, variant, outcome, now);
    if (result === 'sent') stats.sent++;
    else if (result === 'skipped') stats.skipped++;
    else if (result === 'failed') stats.failed++;
    else if (result === 'pause_account_return') {
      log('info', 'tick_account_paused_exit', { account_id: row.account_id });
      return stats;
    }
    // 'rate_limit_retry' → counted neither sent/failed/skipped (row went back to pending)
  }

  // ── Campaign completion sweep (C8 closure) ────────────────────────────
  // For each distinct campaign whose rows we just terminated, check if
  // any pending rows remain. If zero, mark the campaign 'done'. Without
  // this, campaigns sit in 'running' forever and analytics treat them
  // as in-flight even after every queue row has reached a terminal state.
  const touchedCampaignIds = new Set(dueRows.map(r => r.campaign_id));
  for (const campaignId of touchedCampaignIds) {
    const { count: pendingCount } = await supabase
      .from('email_send_queue')
      .select('id', { count: 'exact', head: true })
      .eq('campaign_id', campaignId)
      .eq('status', 'pending');
    if ((pendingCount ?? 0) === 0) {
      // Also check sending — if anything is mid-send we're not done yet
      const { count: sendingCount } = await supabase
        .from('email_send_queue')
        .select('id', { count: 'exact', head: true })
        .eq('campaign_id', campaignId)
        .eq('status', 'sending');
      if ((sendingCount ?? 0) === 0) {
        // Aggregate final counts for the campaign
        const { data: agg } = await supabase
          .from('email_send_queue')
          .select('status', { count: 'exact' })
          .eq('campaign_id', campaignId);
        const totals = { sent: 0, failed: 0, skipped: 0 };
        for (const r of (agg ?? []) as Array<{ status: string }>) {
          if (r.status === 'sent') totals.sent++;
          else if (r.status === 'failed') totals.failed++;
          else if (r.status === 'skipped') totals.skipped++;
        }
        // Only flip campaigns that are still 'running' (don't override
        // 'aborted' / 'paused' / 'exhausted' set elsewhere)
        await supabase.from('email_send_campaigns').update({
          status: 'done',
          completed_at: now.toISOString(),
          total_sent: totals.sent,
          total_failed: totals.failed,
          total_skipped: totals.skipped,
        }).eq('id', campaignId).eq('status', 'running');
        log('info', 'tick_campaign_completed', { campaign_id: campaignId, totals });
      }
    }
  }

  return stats;
}

// ── helpers ──────────────────────────────────────────────────────────────

async function applySafetyFailure(
  supabase: Supa,
  row: QueueRow,
  v: Extract<SafetyVerdict, { ok: false }>,
  now: Date,
): Promise<'pause_account_continue' | 'skipped' | 'failed' | 'deferred'> {
  if (v.outcome === 'pause_account') {
    await supabase.from('team_members').update({
      email_send_paused: true,
      email_send_paused_reason: v.reason,
      email_send_paused_at: now.toISOString(),
    }).eq('id', row.account_id);
    await supabase.from('email_send_queue')
      .update({ status: 'pending', sending_started_at: null, last_error: v.reason })
      .eq('id', row.id);
    log('warn', 'tick_account_paused_safety', { account_id: row.account_id, reason: v.reason });
    return 'pause_account_continue';
  }
  if (v.outcome === 'defer') {
    const newSendAt = new Date(now.getTime() + (v.defer_seconds ?? 15) * 1000).toISOString();
    await supabase.from('email_send_queue')
      .update({ status: 'pending', sending_started_at: null, send_at: newSendAt, last_error: v.reason })
      .eq('id', row.id);
    return 'deferred';
  }
  if (v.outcome === 'skip') {
    await supabase.from('email_send_queue')
      .update({ status: 'skipped', last_error: v.reason })
      .eq('id', row.id);
    return 'skipped';
  }
  // outcome === 'fail'
  await supabase.from('email_send_queue')
    .update({ status: 'failed', last_error: v.reason })
    .eq('id', row.id);
  return 'failed';
}

async function applySendOutcome(
  supabase: Supa,
  row: QueueRow,
  founder: FounderRow,
  variant: VariantRow,
  outcome: SendOutcome,
  now: Date,
): Promise<'sent' | 'skipped' | 'failed' | 'rate_limit_retry' | 'pause_account_return'> {
  switch (outcome.outcome) {
    case 'sent': {
      await supabase.from('email_send_queue').update({
        status: 'sent',
        sent_at: now.toISOString(),
        gmail_message_id: outcome.gmail_message_id,
      }).eq('id', row.id);

      // CRM integration — failures here are logged but don't fail the send
      try {
        const { leadId } = await createLeadFromOutreach({
          email: row.recipient_email,
          fullName: row.recipient_name,
          company: row.recipient_company,
          ownedBy: row.account_id,
          source: 'mass_email',
        });
        await supabase.from('interactions').insert({
          lead_id: leadId,
          team_member_id: row.account_id,
          type: 'email_outbound',
          subject: outcome.rendered_subject,
          body: outcome.rendered_body,
          gmail_message_id: outcome.gmail_message_id,
          gmail_thread_id: outcome.gmail_thread_id,
          campaign_id: row.campaign_id,
          template_variant_id: row.template_variant_id,
          occurred_at: now.toISOString(),
        });
      } catch (err) {
        log('warn', 'tick_crm_integration_failed', {
          queue_row_id: row.id,
          err: (err as Error).message,
        });
      }
      return 'sent';
    }
    case 'skipped':
      await supabase.from('email_send_queue')
        .update({ status: 'skipped', last_error: outcome.last_error })
        .eq('id', row.id);
      return 'skipped';
    case 'rate_limit_retry': {
      const nextAttempt = row.attempts + 1;
      // Spec §6 ⑤d: max 3 retries on 429 with exponential backoff
      // (5s / 30s / 2m), then status='failed'. C7 closure.
      const delays = SAFETY_LIMITS.RATE_LIMIT_RETRY_DELAYS_MS;
      if (nextAttempt > delays.length) {
        await supabase.from('email_send_queue').update({
          status: 'failed',
          last_error: 'rate_limit_retry_exhausted',
          attempts: nextAttempt,
        }).eq('id', row.id);
        return 'failed';
      }
      const deferMs = delays[nextAttempt - 1];
      const newSendAt = new Date(now.getTime() + deferMs).toISOString();
      await supabase.from('email_send_queue').update({
        status: 'pending',
        send_at: newSendAt,
        sending_started_at: null,
        attempts: nextAttempt,
        last_error: `rate_limit_retry_${deferMs}ms`,
      }).eq('id', row.id);
      return 'rate_limit_retry';
    }
    case 'account_pause': {
      await supabase.from('team_members').update({
        email_send_paused: true,
        email_send_paused_reason: outcome.reason,
        email_send_paused_at: now.toISOString(),
      }).eq('id', row.account_id);
      await supabase.from('email_send_queue')
        .update({ status: 'pending', sending_started_at: null, last_error: outcome.reason })
        .eq('id', row.id);
      log('warn', 'tick_account_paused_send', { account_id: row.account_id, reason: outcome.reason });
      return 'pause_account_return';
    }
    case 'hard_bounce': {
      // Natural unsubscribe — leave source NULL so the dry-run cleanup
      // never matches it.
      await supabase.from('email_blacklist')
        .upsert({ email: row.recipient_email, source: null }, { onConflict: 'email', ignoreDuplicates: true });
      await supabase.from('email_send_queue').update({
        status: 'skipped',
        last_error: `hard_bounce:${outcome.code}:${outcome.reason}`,
      }).eq('id', row.id);
      return 'skipped';
    }
    case 'soft_bounce':
      await supabase.from('email_send_queue').update({
        status: 'failed',
        last_error: `soft_bounce:${outcome.code}:${outcome.reason}`,
      }).eq('id', row.id);
      return 'failed';
    case 'failed':
      await supabase.from('email_send_queue')
        .update({ status: 'failed', last_error: outcome.last_error })
        .eq('id', row.id);
      return 'failed';
  }
}

// ── PT helpers for tick's self-trigger (mirror schedule.ts internals) ───────
// These are kept private to tick.ts rather than exported from schedule.ts
// so the public API of schedule.ts stays minimal.

const PT_TZ = 'America/Los_Angeles';
const PT_DOW_FMT = new Intl.DateTimeFormat('en-US', { timeZone: PT_TZ, weekday: 'short' });
const PT_YMD_FMT = new Intl.DateTimeFormat('en-CA', {
  timeZone: PT_TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});
const PT_TZNAME_FMT = new Intl.DateTimeFormat('en-US', { timeZone: PT_TZ, timeZoneName: 'short' });

const PT_DOW_MAP: Record<string, number> = {
  Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
};

function formatPtDate(d: Date): string {
  return PT_YMD_FMT.format(d);
}

function ptDayOfWeekFromDate(d: Date): number {
  return PT_DOW_MAP[PT_DOW_FMT.format(d)] ?? 0;
}

function ptDatePartsFromDate(d: Date): { year: number; month: number; day: number } {
  const [y, m, dd] = PT_YMD_FMT.format(d).split('-').map(Number);
  return { year: y, month: m, day: dd };
}

function ptSlotInstant(y: number, mo: number, d: number, h: number, mi: number): Date {
  // Build tentative assuming PST (-08:00) then adjust if PDT.
  const tentative = new Date(Date.UTC(y, mo - 1, d, h + 8, mi));
  const parts = PT_TZNAME_FMT.formatToParts(tentative);
  const tz = parts.find(p => p.type === 'timeZoneName')?.value;
  const offsetMin = tz === 'PDT' ? -420 : -480;
  const diff = offsetMin - -480; // 0 for PST, +60 for PDT
  return new Date(tentative.getTime() - diff * 60_000);
}

/** Returns today's PT slot instant if today is a weekday, else null. */
function todaysSlotInstant(d: Date): Date | null {
  const dow = ptDayOfWeekFromDate(d);
  const slot = WEEKDAY_START_TIMES_PT[dow];
  if (!slot) return null;
  const { year, month, day } = ptDatePartsFromDate(d);
  return ptSlotInstant(year, month, day, slot.hour, slot.minute);
}

/**
 * Phase 0 self-trigger: invokes runDailyStart inline when today's schedule
 * time has arrived and no campaign yet exists for today's PT date.
 */
async function maybeSelfTrigger(supabase: Supa, now: Date): Promise<void> {
  const { data: scheduleRow } = await supabase
    .from('email_send_schedule')
    .select('enabled')
    .eq('id', 1)
    .single();
  const enabled = (scheduleRow as { enabled: boolean } | null)?.enabled ?? false;
  if (!enabled) return;

  const todayKey = formatPtDate(now);
  const { data: existing } = await supabase
    .from('email_send_campaigns')
    .select('id')
    .eq('idempotency_key', todayKey)
    .maybeSingle();
  if (existing) return; // already claimed (success, skipped, or aborted)

  const todaySlot = todaysSlotInstant(now);
  if (!todaySlot) return; // Sat/Sun
  if (now < todaySlot) return; // not yet due

  log('info', 'tick_self_trigger', { idempotency_key: todayKey });
  await runDailyStart(supabase, { now });
}

// Returns the start of "today" in PT as an ISO string.
function ptStartOfDay(d: Date): string {
  // YYYY-MM-DD in PT
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const ymd = fmt.format(d); // '2026-04-28'
  // Get the PT offset (PST=-8, PDT=-7) for the given date.
  const offsetFmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    timeZoneName: 'short',
  });
  const tzAbbrev = offsetFmt.formatToParts(d).find(p => p.type === 'timeZoneName')?.value ?? 'PST';
  const offset = tzAbbrev === 'PDT' ? '-07:00' : '-08:00';
  return `${ymd}T00:00:00${offset}`;
}
