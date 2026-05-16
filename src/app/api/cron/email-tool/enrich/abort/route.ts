// POST /api/cron/email-tool/enrich/abort — admin only.
//
// Sets enrich_jobs.status = 'aborted' (idempotent — already-aborted /
// done jobs return ok without changes) AND marks all the job's
// pending enrich_job_rows as 'dropped' with drop_reason='job_aborted'
// so the worker can't accidentally pick them up next tick.
//
// The currently-executing worker tick (if any) will continue processing
// rows it already pulled out for ~remaining tick budget — but the
// status check at the top of each row iteration in the worker stops
// it within 1 row of the abort landing. Worst-case waste: 1 row's
// worth of BEC/Icypeas API spend after the click.
export const maxDuration = 15;

import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/lib/session';
import { createAdminClient } from '@/lib/supabase/admin';

export async function POST(req: NextRequest) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  if (!session.is_admin) return NextResponse.json({ error: 'admin only' }, { status: 403 });

  let job_id: string | null = null;
  try {
    const body = (await req.json()) as { job_id?: string };
    job_id = body.job_id ?? null;
  } catch {
    return NextResponse.json({ error: 'bad_json' }, { status: 400 });
  }
  if (!job_id) {
    const url = new URL(req.url);
    job_id = url.searchParams.get('job_id');
  }
  if (!job_id) return NextResponse.json({ error: 'job_id_required' }, { status: 400 });

  const supabase = createAdminClient();

  // 1) Flip job to aborted (idempotent — only updates rows still in
  //    queued/processing; done/error/aborted untouched).
  const { data: jobUpdate, error: jobErr } = await supabase
    .from('enrich_jobs')
    .update({
      status: 'aborted',
      worker_locked_until: null,
      completed_at: new Date().toISOString(),
      last_error: 'aborted_by_user',
    })
    .eq('id', job_id)
    .in('status', ['queued', 'processing'])
    .select('id, status')
    .maybeSingle();
  if (jobErr) return NextResponse.json({ error: 'job_update_failed', detail: jobErr.message }, { status: 500 });

  if (!jobUpdate) {
    // Job is either non-existent or already in a terminal state. Surface
    // the current state so the UI can refresh.
    const { data: existing } = await supabase
      .from('enrich_jobs')
      .select('id, status')
      .eq('id', job_id)
      .maybeSingle();
    if (!existing) return NextResponse.json({ error: 'not_found' }, { status: 404 });
    return NextResponse.json({ ok: true, note: 'already_terminal', status: existing.status });
  }

  // 2) Drop all pending rows for this job. Otherwise the worker would
  //    pick them up on the next tick (it filters by status='pending',
  //    not job status — defense in depth).
  const { error: rowsErr } = await supabase
    .from('enrich_job_rows')
    .update({
      status: 'dropped',
      drop_reason: 'job_aborted',
      processed_at: new Date().toISOString(),
    })
    .eq('job_id', job_id)
    .eq('status', 'pending');
  if (rowsErr) {
    return NextResponse.json({
      ok: true,
      job_status: 'aborted',
      note: 'job_aborted_but_row_cleanup_failed',
      detail: rowsErr.message,
    });
  }

  return NextResponse.json({ ok: true, job_status: 'aborted', job_id });
}
