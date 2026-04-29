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
import type { SendMode } from './types';
import { log } from './log';

type Supa = ReturnType<typeof createAdminClient>;

export interface RunDailyStartOpts {
  /** Clock injection for testability (default: new Date()). */
  now?: Date;
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
  const idempotencyKey = formatPtDate(now);

  // ── Steps ①+②+③: claim today via RPC ──────────────────────────────────
  const { data: claim, error: claimErr } = await supabase.rpc('email_send_claim_today', {
    p_idempotency_key: idempotencyKey,
    p_now: now.toISOString(),
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
      return { kind: 'no_active_founders', campaign_id: campaignId };
    }

    const dailyTarget = cappedPerAcct * activeFounders.length;

    // ── Step ④a: priority list pull ───────────────────────────────────────
    const today = idempotencyKey; // YYYY-MM-DD PT
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

    // ── Step ⑤: pool pick for the remainder ───────────────────────────────
    const regularTarget = dailyTarget - cappedPriorityRows.length;
    let poolRows: PoolRow[] = [];
    if (regularTarget > 0) {
      const { data: pool } = await supabase.rpc('email_tool_pick_batch', { p_limit: regularTarget });
      poolRows = (pool ?? []) as PoolRow[];
    }
    if (cappedPriorityRows.length === 0 && poolRows.length === 0) {
      await supabase.from('email_send_campaigns')
        .update({ status: 'exhausted', completed_at: now.toISOString() })
        .eq('id', campaignId);
      log('warn', 'start_pool_exhausted', { campaign_id: campaignId });
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
        founderIdx = idx === -1 ? rrIdx++ % activeFounders.length : idx;
      } else {
        founderIdx = rrIdx++ % activeFounders.length;
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
    // Roll back blacklist insert for deferred POOL rows so they're pickable next campaign
    const deferredPoolEmails = deferred.filter(d => d.source === 'pool').map(d => d.email);
    if (deferredPoolEmails.length > 0) {
      await supabase.from('email_blacklist').delete().in('email', deferredPoolEmails);
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

    // ── Step ⑩: bulk insert into email_send_queue ─────────────────────────
    if (queueRows.length > 0) {
      const { error: insertErr } = await supabase.from('email_send_queue').insert(queueRows);
      if (insertErr) {
        log('error', 'start_queue_insert_failed', { campaign_id: campaignId, err: insertErr.message });
        await supabase.from('email_send_campaigns')
          .update({ status: 'aborted', abort_reason: 'queue_insert_error', completed_at: now.toISOString() })
          .eq('id', campaignId);
        return { kind: 'aborted', campaign_id: campaignId, reason: 'queue_insert_error' };
      }
    }

    // ── Step ⑪: priority status update + schedule advance + campaign running ──
    const usedPriorityIds = queueRows.filter(q => q.source === 'priority' && q.priority_id).map(q => q.priority_id!);
    if (usedPriorityIds.length > 0) {
      await supabase.from('email_send_priority_queue')
        .update({ status: 'scheduled', campaign_id: campaignId })
        .in('id', usedPriorityIds);
    }

    await supabase.from('email_send_campaigns')
      .update({
        status: 'running',
        started_at: now.toISOString(),
        total_picked: queueRows.length,
        warmup_day: warmupDay,
      })
      .eq('id', campaignId);

    await supabase.from('email_send_schedule')
      .update({ last_run_at: now.toISOString() })
      .eq('id', 1);

    log('info', 'start_campaign_running', { campaign_id: campaignId, queue_count: queueRows.length });
    return { kind: 'started', campaign_id: campaignId, queue_count: queueRows.length };
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
