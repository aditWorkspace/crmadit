// POST /api/cron/email-tool/draft/worker — fired by cron-job.org every minute
// (within the morning weekday window only).
//
// Research-heavy: each draft takes ~30s, far longer than cron-job.org's 30s
// request timeout. So this is FIRE-AND-FORGET — returns 200 immediately and
// does the work in the background via Next's after(), up to maxDuration.
//
// Concurrency: drafts are processed through DRAFT_WORKER_CONCURRENCY (5) slots.
// Each draft scrapes its pages sequentially, so ≤5 drafts in flight ⇒ ≤5
// concurrent Firecrawl requests (the Hobby browser limit). A GLOBAL single-
// runner lock (email_pool_state.draft_worker_lock_until) ensures overlapping
// minute-fired invocations don't stack past that.
//
// Outcome mapping (anti-fabrication contract):
//   ready   → status='ready' with subject/body/tier/score/evidence
//   skipped → status='skipped' (un-sendable lead; no spend wasted)
//   retry   → provider failure: attempt_count++ with backoff, or 'failed' at
//             the cap. NEVER a silent tier-6 fallback. (Firecrawl failures are
//             handled inside the engine as Sonar-only, not retries.)
//   failed  → terminal (unexpected error, or claim-check failed even at tier 6)
export const maxDuration = 300;
export const runtime = 'nodejs';

import { NextRequest, NextResponse, after } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { type DraftInput, type DraftOutcome } from '@/lib/ai/cold-research';
import { processVisualDraftRow } from '@/lib/ai/visual-draft';
import {
  DRAFT_WORKER_BATCH,
  DRAFT_WORKER_BUDGET_MS,
  DRAFT_WORKER_CONCURRENCY,
  DRAFT_WORKER_LOCK_MS,
  DRAFT_LOCK_DURATION_MS,
  PER_DRAFT_TIMEOUT_MS,
  MAX_DRAFT_ATTEMPTS,
  DRAFT_RETRY_BACKOFF_MS,
  DEFAULT_DRAFT_DAILY_SPEND_CEILING_USD,
} from '@/lib/email-tool/cold-constants';

const SPEND_WINDOW_MS = 24 * 60 * 60 * 1000;

type Supa = ReturnType<typeof createAdminClient>;

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

interface Stats { processed: number; ready: number; skipped: number; retried: number; failed: number; recovered: number }

export async function POST(req: NextRequest) {
  const auth = req.headers.get('authorization') ?? '';
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const supabase = createAdminClient();
  // Global single-runner lock: only one worker processes at a time, so its
  // 5 internal slots are the only Firecrawl/Sonar/LLM concurrency in flight.
  if (!(await acquireWorkerLock(supabase))) {
    return NextResponse.json({ ok: true, note: 'locked' });
  }
  // Run the heavy loop after the response so cron-job.org gets a fast 200
  // (it would otherwise time out at 30s and eventually disable the job).
  after(runDraftWorker(supabase));
  return NextResponse.json({ ok: true, note: 'worker_started' });
}

async function acquireWorkerLock(supabase: Supa): Promise<boolean> {
  const nowIso = new Date().toISOString();
  const lockUntil = new Date(Date.now() + DRAFT_WORKER_LOCK_MS).toISOString();
  // CAS: take the lock only if it's null or expired. Single atomic UPDATE.
  const { data } = await supabase
    .from('email_pool_state')
    .update({ draft_worker_lock_until: lockUntil })
    .eq('id', 1)
    .or(`draft_worker_lock_until.is.null,draft_worker_lock_until.lt.${nowIso}`)
    .select('id')
    .maybeSingle();
  return !!data;
}

async function releaseWorkerLock(supabase: Supa): Promise<void> {
  try {
    await supabase.from('email_pool_state').update({ draft_worker_lock_until: null }).eq('id', 1);
  } catch { /* lock auto-expires regardless */ }
}

async function runDraftWorker(supabase: Supa): Promise<void> {
  const startMs = Date.now();
  const stats: Stats = { processed: 0, ready: 0, skipped: 0, retried: 0, failed: 0, recovered: 0 };
  try {
    await recoverStuckDrafts(supabase, stats);

    // Spend guard (rolling 24h) — checked once up front; a single run can only
    // add ~DRAFT_WORKER_BATCH drafts, so it can't blow past the ceiling.
    const since = new Date(Date.now() - SPEND_WINDOW_MS).toISOString();
    const { data: costRows } = await supabase.from('cold_email_drafts').select('cost_usd').gte('researched_at', since);
    const spent = (costRows ?? []).reduce((a, r) => a + Number((r as { cost_usd: number }).cost_usd || 0), 0);
    const ceiling = Number(process.env.DRAFT_DAILY_SPEND_CEILING_USD ?? DEFAULT_DRAFT_DAILY_SPEND_CEILING_USD);
    if (spent >= ceiling) {
      console.log('[draft-worker] spend_ceiling_reached', { spent_24h: spent, ceiling, ...stats });
      return;
    }

    // Process drafts through N concurrent slots. Each slot independently
    // claims (CAS) + processes until the budget/batch is hit or work runs out.
    const slot = async () => {
      while (Date.now() - startMs < DRAFT_WORKER_BUDGET_MS && stats.processed < DRAFT_WORKER_BATCH) {
        const draft = await claimNextDraft(supabase);
        if (!draft) break;
        await processAndPersist(supabase, draft, stats);
      }
    };
    await Promise.all(Array.from({ length: DRAFT_WORKER_CONCURRENCY }, () => slot()));
    console.log('[draft-worker] done', stats);
  } catch (err) {
    console.error('[draft-worker] crashed', err instanceof Error ? err.message : String(err), stats);
  } finally {
    await releaseWorkerLock(supabase);
  }
}

// Claim the next queued, retry-eligible draft via CAS. Loops on lost races
// (another slot grabbed the candidate); returns null only when no work remains.
async function claimNextDraft(supabase: Supa): Promise<ClaimedDraft | null> {
  for (;;) {
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
    if (!candidate) return null;

    const prevLock = (candidate as { worker_locked_until: string | null }).worker_locked_until;
    const q = supabase
      .from('cold_email_drafts')
      .update({ status: 'researching', worker_locked_until: lockUntilIso })
      .eq('id', (candidate as { id: string }).id)
      .eq('status', 'queued');
    const qLock = prevLock === null ? q.is('worker_locked_until', null) : q.eq('worker_locked_until', prevLock);
    const { data: claimed } = await qLock
      .select('id, pool_id, email, first_name, full_name, company, domain, sender_account_id, sender_name, sender_email, attempt_count, cost_usd')
      .maybeSingle();
    if (claimed) return claimed as ClaimedDraft;
    // lost the race; the candidate is now 'researching' so re-select finds another
  }
}

async function processAndPersist(supabase: Supa, draft: ClaimedDraft, stats: Stats): Promise<void> {
  const input: DraftInput = {
    id: draft.id, pool_id: draft.pool_id, email: draft.email,
    first_name: draft.first_name, full_name: draft.full_name, company: draft.company,
    domain: draft.domain, sender_account_id: draft.sender_account_id,
    sender_name: draft.sender_name, sender_email: draft.sender_email,
  };
  const nowIso = new Date().toISOString();

  let outcome: DraftOutcome;
  try {
    // Hard wall-clock cap: one slow draft must never run past the function
    // limit. On timeout, retry (recoverStuckDrafts re-queues anything left mid-write).
    outcome = await Promise.race([
      processVisualDraftRow(input, supabase),
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
    return;
  }

  const newCost = Number(draft.cost_usd || 0) + outcome.cost_usd;
  const base = { worker_locked_until: null as string | null, researched_at: nowIso, cost_usd: newCost };

  if (outcome.kind === 'ready') {
    await supabase.from('cold_email_drafts').update({
      ...base, status: 'ready',
      subject: outcome.subject, body: outcome.body,
      opener_tier: outcome.opener_tier, signal_score: outcome.signal_score,
      evidence_cards: outcome.evidence_cards, selected_evidence_ids: outcome.selected_evidence_ids,
      // visual-outreach v2 output
      industry: outcome.industry ?? null,
      image_url: outcome.image_url ?? null,
      page_slug: outcome.page_slug ?? null,
      email_html: outcome.email_html ?? null,
      research_model: 'visual', decider_model: 'gemini-2.5-flash', writer_model: 'gemini-3.1-flash-image',
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

// Recover drafts a prior run left mid-process (function timeout/crash): an
// in-progress status whose lock has expired. Reset to 'queued' (bounded by the
// attempt cap) so they aren't stranded outside the 'queued' claim set.
async function recoverStuckDrafts(supabase: Supa, stats: Stats): Promise<void> {
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
