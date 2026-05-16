// POST /api/cron/email-tool/enrich/worker — fired by cron-job.org every
// minute with the CRON_SECRET bearer.
//
// Picks the oldest queued/processing enrich_job whose worker lock is
// expired (or null), locks it for 5 min, processes pending rows
// sequentially via processEnrichRow, persists each result, and
// updates aggregate counters. When the last pending row is done,
// flushes kept rows into email_pool (top or bottom per the job's
// mode) and marks the job as `done`.
//
// Time budget: 300s on Hobby plan. We watch elapsed and bail at 280s
// to leave a 20s safety margin for the final commit. Next tick (1
// min later) picks up where this one left off.
//
// Concurrency: BEC is single-thread on solo tier, so per-row
// processing is sequential. Worst case ~15-20 rows per tick; a
// 1000-row upload takes ~50-67 ticks = ~50-67 min total in
// background.
export const maxDuration = 300;
export const runtime = 'nodejs';

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { processEnrichRow } from '@/lib/email-tool/enrich-engine';
import { prettifyCompanyName } from '@/lib/email-tool/company-name';

const BUDGET_MS = 280_000;
const LOCK_DURATION_MS = 5 * 60_000;
const POOL_INSERT_CHUNK = 1000;
const POOL_LOOKUP_CHUNK = 200;

interface JobRow {
  id: string;
  job_id: string;
  row_index: number;
  first_name: string | null;
  full_name: string | null;
  company: string | null;
  domain: string | null;
  given_email: string | null;
}

interface JobMeta {
  id: string;
  mode: 'pool_top' | 'pool_bottom';
  total_rows: number;
  processed: number;
  kept: number;
  dropped: number;
  bec_calls: number;
  icypeas_calls: number;
  cost_usd: number;
}

export async function POST(req: NextRequest) {
  const auth = req.headers.get('authorization') ?? '';
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const supabase = createAdminClient();
  const startMs = Date.now();
  const nowIso = new Date(startMs).toISOString();
  const lockUntilIso = new Date(startMs + LOCK_DURATION_MS).toISOString();

  // ── 1) Pick + lock the oldest claimable job ────────────────────────
  // Two-step pick: first SELECT a candidate id (cheap), then UPDATE
  // with CAS so concurrent workers don't both grab it.
  const { data: candidate } = await supabase
    .from('enrich_jobs')
    .select('id, worker_locked_until')
    .in('status', ['queued', 'processing'])
    .or(`worker_locked_until.is.null,worker_locked_until.lt.${nowIso}`)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();
  if (!candidate) {
    return NextResponse.json({ ok: true, note: 'no_op_empty_queue' });
  }
  const prevLock = candidate.worker_locked_until as string | null;

  // CAS update: only succeed if worker_locked_until is still what we
  // observed in the SELECT above. Prevents the "two workers race for
  // the same job" thundering herd.
  const claimQuery = supabase
    .from('enrich_jobs')
    .update({ status: 'processing', worker_locked_until: lockUntilIso, started_at: nowIso })
    .eq('id', candidate.id);
  // The .is/.eq for the CAS is fiddly because we want "worker_locked_until = prevLock OR null".
  // PostgREST's `.is('worker_locked_until', null)` only handles null. We'll just
  // do two attempts: null-only first; if 0 rows updated, retry with eq(prevLock).
  const claimQueryNull = prevLock === null
    ? claimQuery.is('worker_locked_until', null)
    : claimQuery.eq('worker_locked_until', prevLock);
  const { data: claimed } = await claimQueryNull.select('id, mode, total_rows, processed, kept, dropped, bec_calls, icypeas_calls, cost_usd').maybeSingle();
  if (!claimed) {
    // Another worker grabbed it. Bail; next tick will find another job.
    return NextResponse.json({ ok: true, note: 'lost_claim_race', job_id: candidate.id });
  }
  const job = claimed as JobMeta;

  // ── 2) Loop pending rows ───────────────────────────────────────────
  let processedThisTick = 0;
  let aggregateBec = 0;
  let aggregateIcy = 0;
  let aggregateCost = 0;
  let aggregateKept = 0;
  let aggregateDropped = 0;
  let abortedMidTick = false;
  // We use plain async/await sequential loop because BEC is single-thread.
  // Each iteration: pull next pending row, run engine, write result.
  while (Date.now() - startMs < BUDGET_MS) {
    // Abort check: cheap status re-read before each row. If the user
    // clicked "abort" via /enrich/abort, we stop within one row.
    const { data: live } = await supabase
      .from('enrich_jobs')
      .select('status')
      .eq('id', job.id)
      .maybeSingle();
    if (live?.status === 'aborted') {
      abortedMidTick = true;
      break;
    }

    const { data: nextRow } = await supabase
      .from('enrich_job_rows')
      .select('id, job_id, row_index, first_name, full_name, company, domain, given_email')
      .eq('job_id', job.id)
      .eq('status', 'pending')
      .order('row_index', { ascending: true })
      .limit(1)
      .maybeSingle();
    if (!nextRow) break; // no more pending rows for this job

    const row = nextRow as JobRow;
    const result = await processEnrichRow({
      row_index: row.row_index,
      first_name: row.first_name,
      full_name: row.full_name,
      company: row.company,
      domain: row.domain,
      given_email: row.given_email,
    });

    // Map outcome → row status.
    let rowStatus: string;
    if (result.status === 'kept') rowStatus = 'kept';
    else if (result.status === 'name_mismatch') rowStatus = 'name_mismatch';
    else rowStatus = 'dropped';

    // Persist row outcome.
    await supabase
      .from('enrich_job_rows')
      .update({
        candidates_tried: result.candidates_tried,
        final_email: result.final_email,
        status: rowStatus,
        bec_passes: result.bec_passes,
        bec_fails: result.bec_fails,
        icypeas_status: result.icypeas_status,
        drop_reason: result.drop_reason,
        processed_at: new Date().toISOString(),
      })
      .eq('id', row.id);

    processedThisTick++;
    aggregateBec += result.bec_calls;
    aggregateIcy += result.icypeas_calls;
    aggregateCost += result.cost_usd;
    if (result.status === 'kept') aggregateKept++;
    else aggregateDropped++;

    // Per-row aggregate flush so the modal's 3-second poll sees
    // processed/kept/dropped/cost ticking up in real time. Without
    // this, all the per-row writes pile up and the job aggregate
    // only updates once-per-tick at the bottom of the loop, leaving
    // the UI counters frozen at 0/N for minutes at a time.
    //
    // Cost: 1 extra UPDATE per row (~30ms) on top of the row write.
    // Worth it for the live feedback.
    await supabase
      .from('enrich_jobs')
      .update({
        processed: job.processed + processedThisTick,
        kept: job.kept + aggregateKept,
        dropped: job.dropped + aggregateDropped,
        bec_calls: job.bec_calls + aggregateBec,
        icypeas_calls: job.icypeas_calls + aggregateIcy,
        cost_usd: Number(job.cost_usd) + aggregateCost,
      })
      .eq('id', job.id);
  }

  // ── 3) If all rows are done, flush kept rows to email_pool ──────────
  const { count: pendingLeft } = await supabase
    .from('enrich_job_rows')
    .select('*', { count: 'exact', head: true })
    .eq('job_id', job.id)
    .eq('status', 'pending');

  if (pendingLeft === 0) {
    const result = await flushJobToPool(supabase, job.id, job.mode);
    await supabase
      .from('enrich_jobs')
      .update({
        status: result.error ? 'error' : 'done',
        completed_at: new Date().toISOString(),
        worker_locked_until: null,
        inserted_to_pool: result.inserted,
        already_in_pool: result.already_in_pool,
        already_blacklisted: result.already_blacklisted,
        pool_size_after: result.pool_size_after,
        last_error: result.error ?? null,
      })
      .eq('id', job.id);
    return NextResponse.json({
      ok: true,
      job_id: job.id,
      processed_this_tick: processedThisTick,
      finalized: true,
      inserted: result.inserted,
      pool_size_after: result.pool_size_after,
    });
  }

  // ── 4) Aborted mid-tick: release lock, leave status='aborted' ──────
  if (abortedMidTick) {
    await supabase
      .from('enrich_jobs')
      .update({ worker_locked_until: null })
      .eq('id', job.id);
    return NextResponse.json({
      ok: true,
      job_id: job.id,
      processed_this_tick: processedThisTick,
      aborted: true,
    });
  }

  // ── 5) Partial: release lock so next tick can re-claim ─────────────
  await supabase
    .from('enrich_jobs')
    .update({ worker_locked_until: null })
    .eq('id', job.id);

  return NextResponse.json({
    ok: true,
    job_id: job.id,
    processed_this_tick: processedThisTick,
    pending_left: pendingLeft,
    finalized: false,
  });
}

interface FlushResult {
  inserted: number;
  already_in_pool: number;
  already_blacklisted: number;
  pool_size_after: number | null;
  error: string | null;
}

async function flushJobToPool(
  supabase: ReturnType<typeof createAdminClient>,
  jobId: string,
  mode: 'pool_top' | 'pool_bottom',
): Promise<FlushResult> {
  // Pull all kept rows for this job.
  const { data: keptRows, error: keptErr } = await supabase
    .from('enrich_job_rows')
    .select('first_name, full_name, company, final_email')
    .eq('job_id', jobId)
    .eq('status', 'kept');
  if (keptErr) return { inserted: 0, already_in_pool: 0, already_blacklisted: 0, pool_size_after: null, error: `kept_lookup:${keptErr.message}` };

  const rows = (keptRows ?? []) as Array<{
    first_name: string | null;
    full_name: string | null;
    company: string | null;
    final_email: string;
  }>;
  if (rows.length === 0) {
    const { data: fresh } = await supabase.rpc('email_tool_fresh_remaining');
    return { inserted: 0, already_in_pool: 0, already_blacklisted: 0, pool_size_after: (fresh ?? 0) as number, error: null };
  }

  // Dedupe against existing pool + blacklist.
  const emails = Array.from(new Set(rows.map(r => r.final_email)));
  const inPool = new Set<string>();
  const inBlacklist = new Set<string>();
  for (let i = 0; i < emails.length; i += POOL_LOOKUP_CHUNK) {
    const slice = emails.slice(i, i + POOL_LOOKUP_CHUNK);
    const { data: pp } = await supabase.from('email_pool').select('email').in('email', slice);
    for (const r of (pp ?? []) as Array<{ email: string }>) inPool.add(r.email);
    const { data: bl } = await supabase.from('email_blacklist').select('email').in('email', slice);
    for (const r of (bl ?? []) as Array<{ email: string }>) inBlacklist.add(r.email);
  }
  const survivors = rows.filter(r => !inPool.has(r.final_email) && !inBlacklist.has(r.final_email));
  const alreadyInPool = rows.filter(r => inPool.has(r.final_email)).length;
  const alreadyBlacklisted = rows.filter(r => inBlacklist.has(r.final_email)).length;

  let insertedCount = 0;
  let restoredPtr: number | null = null;
  if (survivors.length > 0) {
    let startSequence: number;
    if (mode === 'pool_top') {
      const { data: minRow } = await supabase
        .from('email_pool')
        .select('sequence')
        .order('sequence', { ascending: true })
        .limit(1)
        .maybeSingle();
      const min = (minRow as { sequence: number } | null)?.sequence ?? 0;
      startSequence = min - survivors.length;
      restoredPtr = startSequence;
    } else {
      const { data: maxRow } = await supabase
        .from('email_pool')
        .select('sequence')
        .order('sequence', { ascending: false })
        .limit(1)
        .maybeSingle();
      const max = (maxRow as { sequence: number } | null)?.sequence ?? -1;
      startSequence = max + 1;
    }

    // Defense in depth: prettify company at pool-insert time, even
    // though /enrich/create now does this up-front. Any older
    // enrich_job_rows from before the 2026-05-16 fix that flush into
    // the pool here will still get cleaned ("https://x.com/" → "X").
    const inserts = survivors.map((s, idx) => ({
      sequence: startSequence + idx,
      email: s.final_email,
      company: prettifyCompanyName(s.company),
      full_name: s.full_name,
      first_name: s.first_name,
    }));

    for (let i = 0; i < inserts.length; i += POOL_INSERT_CHUNK) {
      const slice = inserts.slice(i, i + POOL_INSERT_CHUNK);
      const { error } = await supabase.from('email_pool').insert(slice);
      if (error) {
        return { inserted: insertedCount, already_in_pool: alreadyInPool, already_blacklisted: alreadyBlacklisted, pool_size_after: null, error: `pool_insert:${error.message}` };
      }
      insertedCount += slice.length;
    }

    if (mode === 'pool_top' && restoredPtr != null) {
      await supabase
        .from('email_pool_state')
        .update({ next_sequence: restoredPtr, eff_remaining_seq: null, eff_remaining_fresh: null, eff_updated_at: null })
        .eq('id', 1);
    } else {
      await supabase
        .from('email_pool_state')
        .update({ eff_remaining_seq: null, eff_remaining_fresh: null, eff_updated_at: null })
        .eq('id', 1);
    }
  }

  const { data: fresh } = await supabase.rpc('email_tool_fresh_remaining');
  return {
    inserted: insertedCount,
    already_in_pool: alreadyInPool,
    already_blacklisted: alreadyBlacklisted,
    pool_size_after: (fresh ?? 0) as number,
    error: null,
  };
}
