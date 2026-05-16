// GET /api/cron/email-tool/enrich/job-stats?job_id=X — diagnostic
// breakdown of an enrich job's outcomes. Mirrors the manual SQL the
// admin would otherwise have to run to understand "where are rows
// dying?". Useful both as a one-shot terminal-friendly debug + as
// a small inline banner in the modal.
//
// Admin-only. Read-only on the DB.

export const maxDuration = 15;

import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/lib/session';
import { createAdminClient } from '@/lib/supabase/admin';

export async function GET(req: NextRequest) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  if (!session.is_admin) return NextResponse.json({ error: 'admin only' }, { status: 403 });

  const url = new URL(req.url);
  const jobId = url.searchParams.get('job_id');
  if (!jobId) return NextResponse.json({ error: 'job_id_required' }, { status: 400 });

  const supabase = createAdminClient();

  // Fetch every row's status + icypeas_status + drop_reason + bec counts.
  // For a 4k-row job that's ~120KB transferred; cheap. Pagination only
  // needed if we go past 50k rows in a single job.
  const rows: Array<{
    status: string;
    icypeas_status: string | null;
    drop_reason: string | null;
    bec_passes: number;
    bec_fails: number;
  }> = [];
  let offset = 0;
  while (true) {
    const { data, error } = await supabase
      .from('enrich_job_rows')
      .select('status, icypeas_status, drop_reason, bec_passes, bec_fails')
      .eq('job_id', jobId)
      .range(offset, offset + 999);
    if (error) {
      return NextResponse.json({ error: 'fetch_failed', detail: error.message }, { status: 500 });
    }
    const batch = (data ?? []) as typeof rows;
    rows.push(...batch);
    if (batch.length < 1000) break;
    offset += batch.length;
  }

  // Helper: did Icypeas hit on any of the multi-attempt parts? DEBITED
  // and FOUND are both success values; NOT_FOUND must be filtered out
  // before the prefix check because NOT_FOUND.startsWith('FOUND') is false
  // but contains "FOUND" as a substring.
  const icypeasHit = (s: string | null): boolean => {
    if (!s) return false;
    const parts = s.split('/');
    return parts.some(p => {
      const status = p.split('@')[0];
      return (status.startsWith('DEBITED') || status.startsWith('FOUND')) && !status.startsWith('NOT_');
    });
  };

  // Count buckets.
  let kept_via_bec_only = 0;
  let kept_via_icypeas = 0;
  let dropped_pre_dedupe = 0;
  let dropped_bec_and_icypeas_miss = 0;
  let dropped_no_bec_icypeas_miss = 0;
  let dropped_no_first_name = 0;
  let dropped_no_company = 0;
  let dropped_errors = 0;
  let dropped_name_mismatch = 0;
  let dropped_other = 0;
  let pending = 0;

  // Per icypeas_status pattern tally.
  const icypeas_strategy: Record<string, number> = {};

  for (const r of rows) {
    if (r.icypeas_status) {
      icypeas_strategy[r.icypeas_status] = (icypeas_strategy[r.icypeas_status] ?? 0) + 1;
    }
    if (r.status === 'pending') {
      pending++;
      continue;
    }
    if (r.status === 'kept') {
      if (r.icypeas_status && r.icypeas_status !== 'skipped_dedupe') {
        kept_via_icypeas++;
      } else {
        kept_via_bec_only++;
      }
      continue;
    }
    if (r.status === 'name_mismatch') { dropped_name_mismatch++; continue; }
    // status === 'dropped'
    if (r.icypeas_status === 'skipped_dedupe' || r.drop_reason === 'already_known_lead') {
      dropped_pre_dedupe++; continue;
    }
    if (r.drop_reason === 'no_first_name') { dropped_no_first_name++; continue; }
    if (r.drop_reason === 'no_company') { dropped_no_company++; continue; }
    if (r.icypeas_status?.startsWith('error') || r.icypeas_status?.includes('error')) {
      dropped_errors++; continue;
    }
    // Real misses: tried BEC, tried Icypeas, both failed.
    if (icypeasHit(r.icypeas_status)) {
      // shouldn't happen — if Icypeas hit, status should be kept. log as other.
      dropped_other++; continue;
    }
    if (r.bec_fails > 0) {
      dropped_bec_and_icypeas_miss++;
    } else {
      dropped_no_bec_icypeas_miss++;
    }
  }

  // Top-N icypeas_status patterns (sorted desc by count). Keep the
  // response compact — long tail < 5 in the trailing "other" bucket.
  const sortedPatterns = Object.entries(icypeas_strategy).sort(([, a], [, b]) => b - a);
  const top_patterns = sortedPatterns.slice(0, 12);
  const other_patterns_sum = sortedPatterns.slice(12).reduce((s, [, n]) => s + n, 0);

  // Pull job-level metadata for context.
  const { data: jobRow } = await supabase
    .from('enrich_jobs')
    .select('id, file_name, status, total_rows, processed, kept, dropped, cost_usd, bec_calls, icypeas_calls, started_at, completed_at')
    .eq('id', jobId)
    .maybeSingle();

  const total = rows.length;
  const processed_real = total - pending;
  const kept_total = kept_via_bec_only + kept_via_icypeas;
  const dropped_total =
    dropped_pre_dedupe + dropped_bec_and_icypeas_miss + dropped_no_bec_icypeas_miss +
    dropped_no_first_name + dropped_no_company + dropped_errors + dropped_other;

  return NextResponse.json({
    job: jobRow,
    total,
    pending,
    processed: processed_real,
    kept_total,
    kept_via_bec_only,
    kept_via_icypeas,
    dropped_total,
    dropped_breakdown: {
      pre_dedupe: dropped_pre_dedupe,
      bec_and_icypeas_miss: dropped_bec_and_icypeas_miss,
      no_bec_icypeas_miss: dropped_no_bec_icypeas_miss,
      no_first_name: dropped_no_first_name,
      no_company: dropped_no_company,
      errors: dropped_errors,
      name_mismatch: dropped_name_mismatch,
      other_unclassified: dropped_other,
    },
    icypeas_top_patterns: Object.fromEntries(top_patterns),
    icypeas_other_patterns_sum: other_patterns_sum,
  });
}
