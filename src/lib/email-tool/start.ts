// Daily start phase. Called from the tick handler when due (PR 4 wires
// the self-trigger; PR 3 ships the function and a debug entry point).
// See spec §5 for the 11-step orchestration.
//
// All steps complete in <30 seconds. Steps ①+②+③ run inside the
// email_send_claim_today RPC for atomic SERIALIZABLE-equivalent semantics.
// The rest run outside that transaction with the campaign id already
// established.
//
// Returns a tagged result so the caller (tick) can decide whether to
// alert, fall through to drain, or short-circuit.

import type { createAdminClient } from '@/lib/supabase/admin';
import { SAFETY_LIMITS } from './safety-limits';
import { computeNextRunAt } from './schedule';
import type { SendMode } from './types';
import { log } from './log';
import { sendCriticalAlert } from './alert';

type Supa = ReturnType<typeof createAdminClient>;

export interface RunDailyStartOpts {
  /** Clock injection for testability (default: new Date()). */
  now?: Date;
  /**
   * Override the idempotency_key. Default: today's PT date in YYYY-MM-DD
   * form. Used by the admin retry-today endpoint to generate a manual key
   * (e.g., 'manual-2026-04-28-<ts>') that doesn't collide with the
   * scheduled run's already-claimed key.
   */
  idempotencyKey?: string;
}

export type RunDailyStartResult =
  | { kind: 'started'; campaign_id: string; queue_count: number }
  | { kind: 'skipped' }
  | { kind: 'paused' }
  | { kind: 'idempotent_no_op' }
  | { kind: 'no_active_founders'; campaign_id: string }
  | { kind: 'disabled' }
  | { kind: 'aborted'; campaign_id: string | null; reason: string };

interface ClaimResult {
  outcome: 'started' | 'skipped' | 'idempotent_no_op' | 'paused' | 'disabled';
  campaign_id: string | null;
  send_mode: SendMode;
}

interface PoolRow {
  id: string;
  email: string;
  first_name: string | null;
  company: string | null;
  sequence: number;
}

interface PriorityRow {
  id: string;
  email: string;
  first_name: string | null;
  company: string | null;
  override_owner: string | null;
}

interface ActiveFounder {
  id: string;
  name: string;
  email: string;
}

interface AssignedItem {
  founderIdx: number;
  source: 'pool' | 'priority';
  email: string;
  first_name: string | null;
  company: string | null;
  priority_id: string | null;
}

export async function runDailyStart(
  supabase: Supa,
  opts: RunDailyStartOpts = {},
): Promise<RunDailyStartResult> {
  const now = opts.now ?? new Date();
  const idempotencyKey = opts.idempotencyKey ?? formatPtDate(now);

  // ── Steps ①+②+③: claim today via RPC ──────────────────────────────────
  // C11+C12 fix: compute nextRunAt once here; the RPC stores it in the
  // skip-flag path (C12), and step ⑪ reuses the same value (C11).
  const nextRunAt = computeNextRunAt(now);
  const { data: claim, error: claimErr } = await supabase.rpc('email_send_claim_today', {
    p_idempotency_key: idempotencyKey,
    p_now: now.toISOString(),
    p_next_run_at: nextRunAt?.toISOString() ?? null,
  });
  if (claimErr) {
    log('error', 'start_claim_rpc_error', { err: claimErr.message, idempotency_key: idempotencyKey });
    return { kind: 'aborted', campaign_id: null, reason: 'claim_rpc_error' };
  }
  const c = claim as ClaimResult;
  if (c.outcome === 'disabled') return { kind: 'disabled' };
  if (c.outcome === 'skipped') return { kind: 'skipped' };
  if (c.outcome === 'idempotent_no_op') return { kind: 'idempotent_no_op' };
  if (c.outcome === 'paused') return { kind: 'paused' };
  // c.outcome === 'started' — campaign_id is non-null
  const campaignId = c.campaign_id!;
  const sendMode = c.send_mode;

  log('info', 'start_claimed', { campaign_id: campaignId, send_mode: sendMode });

  try {
    // ── Step ④: warmup-aware daily cap + active founders ──────────────────
    const { data: scheduleRow } = await supabase
      .from('email_send_schedule')
      .select('warmup_day_completed')
      .eq('id', 1)
      .single();
    const warmupDay = (scheduleRow as { warmup_day_completed: number } | null)?.warmup_day_completed ?? 0;
    const dailyCapPerAcct = warmupDay === 0
      ? SAFETY_LIMITS.WARMUP_DAY_1_CAP
      : SAFETY_LIMITS.AUTOMATED_DAILY_TARGET_PER_ACCOUNT;
    const cappedPerAcct = Math.min(dailyCapPerAcct, SAFETY_LIMITS.ABSOLUTE_DAILY_CAP_PER_ACCOUNT);

    const { data: foundersData } = await supabase
      .from('team_members')
      .select('id, name, email, email_send_paused')
      .order('name', { ascending: true });
    const activeFounders = ((foundersData ?? []) as Array<ActiveFounder & { email_send_paused: boolean }>)
      .filter(f => !f.email_send_paused)
      .map(({ id, name, email }) => ({ id, name, email }));

    if (activeFounders.length === 0) {
      await supabase.from('email_send_campaigns')
        .update({ status: 'paused', abort_reason: 'no_active_founders', completed_at: now.toISOString() })
        .eq('id', campaignId);
      log('warn', 'start_no_active_founders', { campaign_id: campaignId });
      await sendCriticalAlert(supabase, {
        event: 'all_founders_paused',
        subject: 'All founders paused — campaign cannot run',
        body: `Today's scheduled campaign ${idempotencyKey} could not start because all 3 founders have email_send_paused=true.\n\nManual action: review per-founder pause reasons in the admin Overview tab and click "Resume All" once issues are resolved.`,
        context: { campaign_id: campaignId, idempotency_key: idempotencyKey },
      });
      return { kind: 'no_active_founders', campaign_id: campaignId };
    }

    const dailyTarget = cappedPerAcct * activeFounders.length;

    // ── Step ④a: priority list pull ───────────────────────────────────────
    // Always compute today's PT date locally — DON'T reuse idempotencyKey,
    // because retry-today passes a 'manual-<date>-<ms>' key that would
    // miss every scheduled_for_date row.
    const today = formatPtDate(now);
    const { data: priorityRowsData } = await supabase
      .from('email_send_priority_queue')
      .select('id, email, first_name, company, override_owner')
      .eq('scheduled_for_date', today)
      .eq('status', 'pending')
      .order('uploaded_at', { ascending: true });
    const allPriorityRows = (priorityRowsData ?? []) as PriorityRow[];
    const cappedPriorityRows = allPriorityRows.slice(0, dailyTarget);
    const overflowPriorityRows = allPriorityRows.slice(dailyTarget);
    if (overflowPriorityRows.length > 0) {
      await supabase.from('email_send_priority_queue')
        .update({ status: 'skipped', last_error: 'daily_cap_exceeded' })
        .in('id', overflowPriorityRows.map(r => r.id));
      log('warn', 'start_priority_overflow', {
        campaign_id: campaignId,
        cap: dailyTarget,
        overflow_count: overflowPriorityRows.length,
      });
    }

    // ── Step ⑤: pool pick + atomic blacklist claim ────────────────────────
    // The pick RPC is read-only; the claim RPC blacklists picked emails
    // (tagged with source='pool:<campaign_id>' so domain-dedup rollback
    // can undo only its own inserts) and advances email_pool_state's
    // pointer so subsequent campaigns won't re-pick these rows.
    const regularTarget = dailyTarget - cappedPriorityRows.length;
    let poolRows: PoolRow[] = [];
    if (regularTarget > 0) {
      const { data: pool } = await supabase.rpc('email_tool_pick_batch', { p_limit: regularTarget });
      poolRows = (pool ?? []) as PoolRow[];
      if (poolRows.length > 0) {
        const maxSeq = poolRows.reduce((m, r) => Math.max(m, r.sequence), -1);
        const pickedEmails = poolRows.map(r => r.email.toLowerCase());
        const { error: claimErr } = await supabase.rpc('email_send_pool_claim_batch', {
          p_picked_emails: pickedEmails,
          p_max_sequence:  maxSeq,
          p_campaign_id:   campaignId,
        });
        if (claimErr) {
          // Pool was selected but never claimed; abort and let admin
          // investigate. The selected rows remain pickable (no DB state
          // changed), and the campaign is marked aborted so the next
          // tick won't try to drain a half-built queue.
          log('error', 'start_pool_claim_failed', { campaign_id: campaignId, err: claimErr.message });
          await supabase.from('email_send_campaigns')
            .update({ status: 'aborted', abort_reason: 'pool_claim_failed', completed_at: now.toISOString() })
            .eq('id', campaignId);
          return { kind: 'aborted', campaign_id: campaignId, reason: 'pool_claim_failed' };
        }
      }
    }
    if (cappedPriorityRows.length === 0 && poolRows.length === 0) {
      await supabase.from('email_send_campaigns')
        .update({ status: 'exhausted', completed_at: now.toISOString() })
        .eq('id', campaignId);
      log('warn', 'start_pool_exhausted', { campaign_id: campaignId });
      await sendCriticalAlert(supabase, {
        event: 'pool_exhausted',
        subject: 'Email pool exhausted — no recipients available',
        body: `Today's campaign found zero recipients in email_pool (after blacklist filtering) and no pending priority rows. The campaign is marked exhausted.\n\nManual action: refresh the pool via /email-tool admin (or the existing CSV upload tool) and retry today's run.`,
        context: { campaign_id: campaignId, idempotency_key: idempotencyKey },
      });
      return { kind: 'aborted', campaign_id: campaignId, reason: 'pool_exhausted' };
    }

    // ── Step ⑥: round-robin assignment ────────────────────────────────────
    const combined: Array<{
      source: 'pool' | 'priority';
      email: string;
      first_name: string | null;
      company: string | null;
      override_owner: string | null;
      priority_id: string | null;
    }> = [
      ...cappedPriorityRows.map(p => ({
        source: 'priority' as const,
        email: p.email,
        first_name: p.first_name,
        company: p.company,
        override_owner: p.override_owner,
        priority_id: p.id,
      })),
      ...poolRows.map(p => ({
        source: 'pool' as const,
        email: p.email,
        first_name: p.first_name,
        company: p.company,
        override_owner: null,
        priority_id: null,
      })),
    ];

    const assigned: AssignedItem[] = [];
    let rrIdx = 0;
    for (const item of combined) {
      let founderIdx: number;
      if (item.source === 'priority' && item.override_owner) {
        const idx = activeFounders.findIndex(f => f.id === item.override_owner);
        // Use the override-owner directly. We still advance rrIdx so the
        // next non-override row doesn't bunch up against this founder
        // — keeps the rotation fair across the whole input list.
        founderIdx = idx === -1 ? rrIdx % activeFounders.length : idx;
        rrIdx++;
      } else {
        founderIdx = rrIdx % activeFounders.length;
        rrIdx++;
      }
      assigned.push({
        founderIdx,
        source: item.source,
        email: item.email,
        first_name: item.first_name,
        company: item.company,
        priority_id: item.priority_id,
      });
    }

    // ── Step ⑦: domain-dedup pass per founder ─────────────────────────────
    const dedupedByFounder: AssignedItem[][] = activeFounders.map(() => []);
    const deferred: AssignedItem[] = [];
    for (const a of assigned) {
      const domain = a.email.split('@')[1]?.toLowerCase() ?? '';
      const founderChunk = dedupedByFounder[a.founderIdx];
      const dupe = founderChunk.find(x => x.email.split('@')[1]?.toLowerCase() === domain);
      if (dupe) {
        deferred.push(a);
      } else {
        founderChunk.push(a);
      }
    }
    // Roll back blacklist insert for deferred POOL rows so they're pickable
    // next campaign. Filter by `source = 'pool:<campaign_id>'` so we can
    // never accidentally delete production unsubscribes (source IS NULL)
    // or other campaigns' tagged rows. See spec §11.5 ("Production
    // blacklist rows (source IS NULL) are never touched").
    const deferredPoolEmails = deferred.filter(d => d.source === 'pool').map(d => d.email.toLowerCase());
    if (deferredPoolEmails.length > 0) {
      await supabase.from('email_blacklist')
        .delete()
        .in('email', deferredPoolEmails)
        .eq('source', `pool:${campaignId}`);
    }
    // Re-mark deferred PRIORITY rows as 'pending' with a note
    const deferredPriorityIds = deferred
      .filter(d => d.source === 'priority' && d.priority_id)
      .map(d => d.priority_id!);
    if (deferredPriorityIds.length > 0) {
      await supabase.from('email_send_priority_queue')
        .update({ status: 'pending', last_error: 'deferred_domain_dedup' })
        .in('id', deferredPriorityIds);
    }

    // ── Step ⑧: variant pick per recipient (uniform random per founder) ──
    const { data: variantsData } = await supabase
      .from('email_template_variants')
      .select('id, founder_id')
      .eq('is_active', true);
    const variantsByFounder = new Map<string, string[]>();
    for (const v of (variantsData ?? []) as Array<{ id: string; founder_id: string }>) {
      const list = variantsByFounder.get(v.founder_id) ?? [];
      list.push(v.id);
      variantsByFounder.set(v.founder_id, list);
    }

    // ── Step ⑨: slot scheduling per founder (independent jitter cursors) ─
    const queueRows: Array<{
      campaign_id: string;
      account_id: string;
      recipient_email: string;
      recipient_name: string | null;
      recipient_company: string | null;
      template_variant_id: string;
      send_at: string;
      source: 'pool' | 'priority';
      priority_id: string | null;
    }> = [];
    const startMs = now.getTime();
    for (let fi = 0; fi < activeFounders.length; fi++) {
      const founder = activeFounders[fi];
      const founderVariants = variantsByFounder.get(founder.id) ?? [];
      if (founderVariants.length === 0) {
        log('warn', 'start_founder_no_active_variants', { founder_id: founder.id });
        continue; // skip this founder's chunk entirely
      }
      const chunk = dedupedByFounder[fi];
      let cursor = startMs + Math.floor(Math.random() * 10_000); // ≤10s initial offset
      for (const a of chunk) {
        const variantId = founderVariants[Math.floor(Math.random() * founderVariants.length)];
        queueRows.push({
          campaign_id: campaignId,
          account_id: founder.id,
          recipient_email: a.email.toLowerCase(),
          recipient_name: a.first_name,
          recipient_company: a.company,
          template_variant_id: variantId,
          send_at: new Date(cursor).toISOString(),
          source: a.source,
          priority_id: a.priority_id,
        });
        const range = SAFETY_LIMITS.INTER_SEND_JITTER_MAX_SECONDS - SAFETY_LIMITS.INTER_SEND_JITTER_MIN_SECONDS;
        const jitterSec = SAFETY_LIMITS.INTER_SEND_JITTER_MIN_SECONDS + Math.random() * range;
        const clampedSec = Math.max(
          SAFETY_LIMITS.MIN_INTER_SEND_GAP_SECONDS_HARD_FLOOR,
          Math.min(jitterSec, SAFETY_LIMITS.MAX_INTER_SEND_GAP_SECONDS_HARD_CEILING),
        );
        cursor += clampedSec * 1000;
      }
    }

    // ── Step ⑩: bulk insert (dedupe first to respect UNIQUE(campaign_id, recipient_email))
    // If a priority row and a pool row end up with the same email under
    // the same campaign, keep the FIRST occurrence (priority rows are
    // earlier in `combined` so priority wins). Without this dedupe, the
    // bulk insert would fail with 23505 on the unique constraint.
    const seenEmails = new Set<string>();
    const dedupedQueueRows = queueRows.filter(r => {
      if (seenEmails.has(r.recipient_email)) return false;
      seenEmails.add(r.recipient_email);
      return true;
    });
    if (dedupedQueueRows.length < queueRows.length) {
      log('warn', 'start_queue_dedupe', {
        campaign_id: campaignId,
        original: queueRows.length,
        deduped: dedupedQueueRows.length,
        dropped: queueRows.length - dedupedQueueRows.length,
      });
    }
    if (dedupedQueueRows.length > 0) {
      const { error: insertErr } = await supabase.from('email_send_queue').insert(dedupedQueueRows);
      if (insertErr) {
        log('error', 'start_queue_insert_failed', { campaign_id: campaignId, err: insertErr.message });
        await supabase.from('email_send_campaigns')
          .update({ status: 'aborted', abort_reason: 'queue_insert_error', completed_at: now.toISOString() })
          .eq('id', campaignId);
        return { kind: 'aborted', campaign_id: campaignId, reason: 'queue_insert_error' };
      }
    }

    // ── Step ⑪: priority status update + schedule advance + campaign running ──
    const usedPriorityIds = dedupedQueueRows.filter(q => q.source === 'priority' && q.priority_id).map(q => q.priority_id!);
    if (usedPriorityIds.length > 0) {
      await supabase.from('email_send_priority_queue')
        .update({ status: 'scheduled', campaign_id: campaignId })
        .in('id', usedPriorityIds);
    }

    await supabase.from('email_send_campaigns')
      .update({
        status: 'running',
        started_at: now.toISOString(),
        total_picked: dedupedQueueRows.length,
        warmup_day: warmupDay,
      })
      .eq('id', campaignId);

    // C11 fix: also denormalize next_run_at so the admin UI's "next run"
    // display is fresh. nextRunAt is computed once at the top of this
    // function and reused here.

    // ── Warmup ramp gate ──────────────────────────────────────────────────
    // Spec §5 step ⑪ + §13: increment warmup_day_completed if YESTERDAY's
    // run was clean (status='done', bounce_rate < 3%, no auto-pauses).
    // Today's cap is already locked in (step ④); the increment affects
    // TOMORROW's run.
    let nextWarmupDayCompleted = warmupDay;
    if (warmupDay < 2) {
      const ramped = await shouldRampWarmup(supabase, now);
      if (ramped) nextWarmupDayCompleted = warmupDay + 1;
    }

    await supabase.from('email_send_schedule')
      .update({
        last_run_at: now.toISOString(),
        next_run_at: nextRunAt?.toISOString() ?? null,
        warmup_day_completed: nextWarmupDayCompleted,
      })
      .eq('id', 1);
    if (nextWarmupDayCompleted !== warmupDay) {
      log('info', 'warmup_ramped', {
        from: warmupDay,
        to: nextWarmupDayCompleted,
        campaign_id: campaignId,
      });
    }

    log('info', 'start_campaign_running', { campaign_id: campaignId, queue_count: dedupedQueueRows.length });
    return { kind: 'started', campaign_id: campaignId, queue_count: dedupedQueueRows.length };
  } catch (err) {
    const e = err as Error;
    log('error', 'start_phase_threw', { campaign_id: campaignId, err: e.message });
    await supabase.from('email_send_errors').insert({
      campaign_id: campaignId,
      error_class: 'crash',
      error_message: `start_phase_threw: ${e.message}`,
      context: { stack: e.stack ?? null },
    });
    await supabase.from('email_send_campaigns')
      .update({ status: 'aborted', abort_reason: 'start_phase_exception', completed_at: now.toISOString() })
      .eq('id', campaignId);
    return { kind: 'aborted', campaign_id: campaignId, reason: 'start_phase_exception' };
  }
}

// PT date formatter for the idempotency_key.
// Returns 'YYYY-MM-DD' in the America/Los_Angeles timezone.
function formatPtDate(d: Date): string {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return fmt.format(d);
}

/**
 * Returns true if yesterday's campaign was clean enough to ramp the
 * warmup-day counter. "Clean" means:
 *   - There was a 'done' campaign yesterday (PT date)
 *   - bounce_rate over the last 7 days is < 3%
 *   - No 'account_paused_*' events in email_send_errors for any founder
 *     in the last 24h
 *
 * If we can't find yesterday's campaign (e.g., first day of operation),
 * return false — don't ramp until we have at least one clean day on the
 * books.
 */
async function shouldRampWarmup(supabase: Supa, now: Date): Promise<boolean> {
  // Yesterday's PT date
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const yesterdayKey = formatPtDate(yesterday);

  // Did yesterday's campaign succeed?
  const { data: yesterdayRow } = await supabase
    .from('email_send_campaigns')
    .select('status, total_failed')
    .eq('idempotency_key', yesterdayKey)
    .maybeSingle();
  if (!yesterdayRow) return false;
  const y = yesterdayRow as { status: string; total_failed: number };
  if (y.status !== 'done') return false;
  if (y.total_failed >= 5) return false;

  // Recent auto-pause events?
  const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  const { count: pauseCount } = await supabase
    .from('email_send_errors')
    .select('id', { count: 'exact', head: true })
    .gte('occurred_at', oneDayAgo)
    .or('error_class.eq.crash,error_message.ilike.%paused%');
  if ((pauseCount ?? 0) > 0) return false;

  // Bounce rate < 3% across all founders. Run the RPC for each and take max.
  const { data: foundersData } = await supabase
    .from('team_members')
    .select('id');
  const founderIds = ((foundersData ?? []) as Array<{ id: string }>).map(f => f.id);
  for (const fid of founderIds) {
    const { data: rate } = await supabase.rpc('email_send_bounce_rate_7d', { p_account_id: fid });
    const r = (rate as { rate?: number } | null)?.rate ?? 0;
    if (r >= 0.03) return false;
  }

  return true;
}
