// POST /api/cron/dripify-process
//
// Drains the Dripify pipeline. Picks up to BATCH_LIMIT rows where status is
// 'pending_enrich' or 'email_queued', oldest-first, and processes each via
// processDripifyLead. One pass through both phases per row — pending_enrich
// rows that resolve to email_queued in this tick will get SENT in the NEXT
// tick (we don't auto-recurse to avoid combining two slow ops in one row
// budget).
//
// Cadence: every 2 min via cron-job.org. Real Dripify webhook volume is
// expected to be ~5-20/day, so two rows/tick is plenty of throughput.
//
// Auth: CRON_SECRET bearer via verifyCronAuth (same as every other /api/cron
// endpoint).
//
// Side effects: writes to dripify_leads (status transitions, resolved_email,
// gmail_*_id, last_error). Calls Icypeas (paid, ~$0.005-0.05/lead) and Gmail
// (free). Never sends to a synthetic Bill Gates payload — that's handled by
// the test-recipient override in process.ts.

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { verifyCronAuth } from '@/lib/auth/cron';
import { processDripifyLead, type ProcessResult } from '@/lib/dripify/process';

export const maxDuration = 300;
export const dynamic = 'force-dynamic';

const BATCH_LIMIT = 10;

interface PickedRow {
  id: string;
  status: string;
}

export async function POST(req: NextRequest) {
  if (!verifyCronAuth(req).ok) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const supabase = createAdminClient();

  // Pick oldest pending work first. NULLS FIRST on last_attempt_at means rows
  // that have never been touched get priority over retries — matches the
  // partial index from migration 036.
  const { data, error } = await supabase
    .from('dripify_leads')
    .select('id, status')
    .in('status', ['pending_enrich', 'email_queued'])
    .order('last_attempt_at', { ascending: true, nullsFirst: true })
    .limit(BATCH_LIMIT);
  if (error) {
    return NextResponse.json({ error: 'pick_failed', detail: error.message }, { status: 500 });
  }
  const rows = (data ?? []) as PickedRow[];

  if (rows.length === 0) {
    return NextResponse.json({ ok: true, processed: 0, results: [] });
  }

  // Process sequentially. Icypeas calls (~30-60s p99) inside each row would
  // overwhelm Gmail rate limits if parallelized, and the tick has a 300s
  // budget — 10 rows × 30s p50 = 300s with some slack.
  const results: ProcessResult[] = [];
  for (const row of rows) {
    const r = await processDripifyLead(supabase, row.id);
    results.push(r);
  }

  return NextResponse.json({
    ok: true,
    processed: results.length,
    results,
  });
}

// GET surface for manual smoke-testing via curl (still gated by CRON_SECRET).
export async function GET(req: NextRequest) {
  return POST(req);
}
