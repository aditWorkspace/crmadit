// POST /api/cron/email-tool/draft/worker — fired by cron-job.org every minute
// with the CRON_SECRET bearer.
//
// Research-heavy: each draft takes ~30s, far longer than cron-job.org's 30s
// request timeout. So this is FIRE-AND-FORGET — it returns 200 immediately and
// does the work in the background via Next's after(), which keeps the function
// alive up to maxDuration. The cron always sees a fast success.
//
// Claims `queued` cold_email_drafts one at a time (CAS lock on
// worker_locked_until), researches + writes each via processDraftRow, and
// persists the outcome. Bounded by a time budget, a per-run count, a hard
// per-draft timeout, and a rolling 24h spend ceiling.
//
// Outcome mapping (the anti-fabrication contract):
//   ready   → status='ready' with subject/body/tier/score/evidence
//   skipped → status='skipped' (lead became un-sendable; no spend wasted)
//   retry   → provider failure: attempt_count++ with backoff, or 'failed' at
//             the cap. NEVER a silent tier-6 fallback.
//   failed  → terminal (unexpected error, or claim-check failed even at tier 6)
export const maxDuration = 300;
export const runtime = 'nodejs';

import { NextRequest, NextResponse, after } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { processDraftRow, type DraftInput, type DraftOutcome } from '@/lib/ai/cold-research';
import {
  COLD_RESEARCH_MODEL,
  COLD_WRITER_MODEL,
  DRAFT_WORKER_BATCH,
  DRAFT_WORKER_BUDGET_MS,
  DRAFT_LOCK_DURATION_MS,
  PER_DRAFT_TIMEOUT_MS,
  MAX_DRAFT_ATTEMPTS,
  DRAFT_RETRY_BACKOFF_MS,
  DEFAULT_DRAFT_DAILY_SPEND_CEILING_USD,
} from '@/lib/email-tool/cold-constants';

const SPEND_WINDOW_MS = 24 * 60 * 60 * 1000;

interface ClaimedDraft {
  id: string;
  pool_id: string;
  email: string;
  first_name: string | null;
  full_name: string | null;
  company: string | null;
  domain: string | null;
  sender_account_id: string;
  sender_name: string;
  sender_email: string;
  attempt_count: number;
  cost_usd: number;
}

type Supa = ReturnType<typeof createAdminClient>;

export async function POST(req: NextRequest) {
  const auth = req.headers.get('authorization') ?? '';
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  // Run the heavy loop after the response is sent so cron-job.org gets a fast
  // 200 (it would otherwise time out at 30s and eventually disable the job).
  after(runDraftWorker());
  return NextResponse.json({ ok: true, note: 'worker_started' });
}

async function runDraftWorker(): Promise<void> {
  const supabase = createAdminClient();
  const startMs = Date.now();
  const ceiling = Number(process.env.DRAFT_DAILY_SPEND_CEILING_USD ?? DEFAULT_DRAFT_DAILY_SPEND_CEILING_USD);
  const stats = { processed: 0, ready: 0, skipped: 0, retried: 0, failed: 0, recovered: 0 };

  try {
    await recoverStuckDrafts(supabase, stats);

    while (Date.now() - startMs < DRAFT_WORKER_BUDGET_MS && stats.processed < DRAFT_WORKER_BATCH) {
      // ── Spend guard (rolling 24h) ──────────────────────────────────────────
      const since = new Date(Date.now() - SPEND_WINDOW_MS).toISOString();
      const { data: costRows } = await supabase
        .from('cold_email_drafts').select('cost_usd').gte('researched_at', since);
      const spent = (costRows ?? []).reduce((a, r) => a + Number((r as { cost_usd: number }).cost_usd || 0), 0);
      if (spent >= ceiling) {
        console.log('[draft-worker] spend_ceiling_reached', { spent_24h: spent, ceiling, ...stats });
        return;
      }

      // ── Claim one queued, unlocked, retry-eligible draft (CAS) ─────────────
      const nowIso = new Date().toISOString();
      const lockUntilIso = new Date(Date.now() + DRAFT_LOCK_DURATION_MS).toISOString();
      const { data: candidate } = await supabase
        .from('cold_email_drafts')
        .select('id, worker_locked_until')
        .eq('status', 'queued')
        .or(`retry_at.is.null,retry_at.lte.${nowIso}`)
        .or(`worker_locked_until.is.null,worker_locked_until.lt.${nowIso}`)
        .order('created_at', { ascending: true })
        .limit(1)
        .maybeSingle();
      if (!candidate) break; // no claimable work

      const prevLock = (candidate as { worker_locked_until: string | null }).worker_locked_until;
      const claimQuery = supabase
        .from('cold_email_drafts')
        .update({ status: 'researching', worker_locked_until: lockUntilIso })
        .eq('id', (candidate as { id: string }).id)
        .eq('status', 'queued');
      const claimQueryLock = prevLock === null
        ? claimQuery.is('worker_locked_until', null)
        : claimQuery.eq('worker_locked_until', prevLock);
      const { data: claimed } = await claimQueryLock
        .select('id, pool_id, email, first_name, full_name, company, domain, sender_account_id, sender_name, sender_email, attempt_count, cost_usd')
        .maybeSingle();
      if (!claimed) continue; // lost the race; loop re-selects

      const draft = claimed as ClaimedDraft;
      const input: DraftInput = {
        id: draft.id, pool_id: draft.pool_id, email: draft.email,
        first_name: draft.first_name, full_name: draft.full_name, company: draft.company,
        domain: draft.domain, sender_account_id: draft.sender_account_id,
        sender_name: draft.sender_name, sender_email: draft.sender_email,
      };

      let outcome: DraftOutcome;
      try {
        // Hard wall-clock cap: a single slow draft must never run past the
        // function limit. On timeout, retry (recoverStuckDrafts re-queues
        // anything the orphaned promise leaves mid-write).
        outcome = await Promise.race([
          processDraftRow(input, supabase),
          new Promise<DraftOutcome>(resolve =>
            setTimeout(() => resolve({ kind: 'retry', reason: 'draft_timeout', cost_usd: 0 }), PER_DRAFT_TIMEOUT_MS)),
        ]);
      } catch (err) {
        await supabase.from('cold_email_drafts').update({
          status: 'failed',
          error: `worker_threw:${err instanceof Error ? err.message.slice(0, 160) : String(err)}`,
          worker_locked_until: null, researched_at: nowIso,
        }).eq('id', draft.id);
        stats.processed++; stats.failed++;
        continue;
      }

      const newCost = Number(draft.cost_usd || 0) + outcome.cost_usd;
      const base = { worker_locked_until: null as string | null, researched_at: nowIso, cost_usd: newCost };

      if (outcome.kind === 'ready') {
        await supabase.from('cold_email_drafts').update({
          ...base, status: 'ready',
          subject: outcome.subject, body: outcome.body,
          opener_tier: outcome.opener_tier, signal_score: outcome.signal_score,
          evidence_cards: outcome.evidence_cards, selected_evidence_ids: outcome.selected_evidence_ids,
          research_model: 'sonar', decider_model: COLD_RESEARCH_MODEL, writer_model: COLD_WRITER_MODEL,
          written_at: nowIso, ready_at: nowIso, error: null,
        }).eq('id', draft.id);
        stats.ready++;
      } else if (outcome.kind === 'skipped') {
        await supabase.from('cold_email_drafts').update({ ...base, status: 'skipped', skip_reason: outcome.reason }).eq('id', draft.id);
        stats.skipped++;
      } else if (outcome.kind === 'retry') {
        const attempt = draft.attempt_count + 1;
        if (attempt < MAX_DRAFT_ATTEMPTS) {
          const backoff = DRAFT_RETRY_BACKOFF_MS[Math.min(attempt - 1, DRAFT_RETRY_BACKOFF_MS.length - 1)];
          await supabase.from('cold_email_drafts').update({
            ...base, status: 'queued', attempt_count: attempt,
            retry_at: new Date(Date.now() + backoff).toISOString(), error: outcome.reason,
          }).eq('id', draft.id);
          stats.retried++;
        } else {
          await supabase.from('cold_email_drafts').update({
            ...base, status: 'failed', attempt_count: attempt, error: `max_attempts:${outcome.reason}`,
          }).eq('id', draft.id);
          stats.failed++;
        }
      } else {
        await supabase.from('cold_email_drafts').update({
          ...base, status: 'failed', error: outcome.reason, evidence_cards: outcome.evidence_cards ?? null,
        }).eq('id', draft.id);
        stats.failed++;
      }
      stats.processed++;
    }
    console.log('[draft-worker] done', stats);
  } catch (err) {
    console.error('[draft-worker] crashed', err instanceof Error ? err.message : String(err), stats);
  }
}

// Recover drafts a prior run left mid-process (function timeout/crash): an
// in-progress status whose lock has expired. Reset to 'queued' (bounded by the
// attempt cap) so they aren't stranded outside the 'queued' claim set.
async function recoverStuckDrafts(supabase: Supa, stats: { recovered: number }): Promise<void> {
  const { data: stuck } = await supabase
    .from('cold_email_drafts')
    .select('id, attempt_count')
    .in('status', ['researching', 'verifying_evidence', 'writing', 'checking'])
    .lt('worker_locked_until', new Date().toISOString());
  for (const d of (stuck ?? []) as Array<{ id: string; attempt_count: number }>) {
    const attempt = d.attempt_count + 1;
    await supabase.from('cold_email_drafts').update(
      attempt < MAX_DRAFT_ATTEMPTS
        ? { status: 'queued', worker_locked_until: null, attempt_count: attempt, error: 'recovered_from_stuck' }
        : { status: 'failed', worker_locked_until: null, attempt_count: attempt, error: 'max_attempts_stuck' },
    ).eq('id', d.id);
    stats.recovered++;
  }
}
