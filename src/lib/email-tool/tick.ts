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
import { getGmailClientForMember, type CampaignGmailClient } from '@/lib/gmail/client';
import type { SendMode } from './types';

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

  // ── 1) Crash recovery sweep ───────────────────────────────────────────
  const staleCutoff = new Date(now.getTime() - SAFETY_LIMITS.CRASH_RECOVERY_STALE_MINUTES * 60_000).toISOString();
  await supabase.from('email_send_queue')
    .update({
      status: 'pending',
      sending_started_at: null,
      last_error: 'recovered_from_stale_sending',
    })
    .eq('status', 'sending')
    .lt('sending_started_at', staleCutoff);

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
    .select('id, campaign_id, account_id, recipient_email, recipient_name, recipient_company, template_variant_id, send_at')
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

    // Run safety checks
    const checksToRun: Array<() => Promise<SafetyVerdict>> = [
      () => checkBounceRate(supabase, row.account_id),
      () => checkActiveVariant(supabase, row.account_id),
      () => checkRecipientDomainOnce(supabase, row.account_id, row.recipient_email, todayStartIso),
      () => checkReplySinceQueue(supabase, row.recipient_email),
      () => checkPerSecondPace(supabase, row.account_id),
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
      if (opts.gmailClientForMember) {
        gmail = await opts.gmailClientForMember(row.account_id);
      } else {
        const client = await getGmailClientForMember(row.account_id);
        gmail = client.gmail as unknown as CampaignGmailClient;
      }
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
          subject: variant.subject_template,
          body: variant.body_template,
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
      const newSendAt = new Date(now.getTime() + 30_000).toISOString();
      await supabase.from('email_send_queue').update({
        status: 'pending',
        send_at: newSendAt,
        sending_started_at: null,
        attempts: 1, // simplified — PR 4 may track exponential backoff
        last_error: 'rate_limit_retry',
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
