// GET /api/cron/email-tool/enrich/status?job_id=X — admin only.
//
// Returns the job's aggregate state + the most recently processed
// rows for the live terminal log. Used by:
//   - the upload modal (polls every 3s)
//   - the "re-open a past upload" view from the history list
export const maxDuration = 15;

import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/lib/session';
import { createAdminClient } from '@/lib/supabase/admin';

// Worst-case payload: 5000 rows × ~250 bytes/row = ~1.2MB. Comfortable
// for a poll. Modal renders most-recent-first; client keeps a Set of
// already-rendered row_index values and only appends new ones.
const ROW_LIMIT = 5000;

export async function GET(req: NextRequest) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  if (!session.is_admin) return NextResponse.json({ error: 'admin only' }, { status: 403 });

  const url = new URL(req.url);
  const job_id = url.searchParams.get('job_id');
  if (!job_id) return NextResponse.json({ error: 'job_id_required' }, { status: 400 });

  const supabase = createAdminClient();
  const { data: job, error: jobErr } = await supabase
    .from('enrich_jobs')
    .select('*')
    .eq('id', job_id)
    .maybeSingle();
  if (jobErr) return NextResponse.json({ error: 'lookup_failed', detail: jobErr.message }, { status: 500 });
  if (!job) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  // Return rows in row_index order — easier for the terminal log to
  // append in insertion order on each poll. We surface only
  // already-processed rows (no `pending`), capped at ROW_LIMIT to keep
  // payloads small. The client diffs row_index to know what's new.
  const { data: rows } = await supabase
    .from('enrich_job_rows')
    .select('row_index, first_name, full_name, company, domain, given_email, candidates_tried, final_email, status, bec_passes, bec_fails, icypeas_status, drop_reason, processed_at')
    .eq('job_id', job_id)
    .neq('status', 'pending')
    .order('row_index', { ascending: true })
    .limit(ROW_LIMIT);

  return NextResponse.json({ job, rows: rows ?? [] });
}
