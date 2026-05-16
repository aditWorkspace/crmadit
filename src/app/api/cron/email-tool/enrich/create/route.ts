// POST /api/cron/email-tool/enrich/create — admin only.
//
// Synchronously parses the CSV and persists it as a new enrich_job +
// N enrich_job_rows in 'pending' status. Returns { job_id } in
// <200ms. The actual enrichment happens in the worker, fired by
// cron-job.org every minute.
//
// Replaces the legacy SSE /enrich-upload route (which is kept around
// as dead code until the next cleanup commit so any in-flight tab
// keeps working).
export const maxDuration = 30;
export const runtime = 'nodejs';

import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/lib/session';
import { createAdminClient } from '@/lib/supabase/admin';
import { parseCsvText, inferEnrichColMap } from '@/lib/email-tool/csv-parse';
import { extractDomain } from '@/lib/email-tool/domain-extract';
import { prettifyCompanyName } from '@/lib/email-tool/company-name';

const EMAIL_RE = /^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/i;
const ROW_INSERT_CHUNK = 500;

export async function POST(req: NextRequest) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  if (!session.is_admin) return NextResponse.json({ error: 'admin only' }, { status: 403 });

  let file: File | null = null;
  let mode: 'pool_top' | 'pool_bottom' = 'pool_top';
  try {
    const form = await req.formData();
    const f = form.get('file');
    if (typeof f !== 'string' && f) file = f as File;
    const m = form.get('mode');
    if (m === 'pool_bottom') mode = 'pool_bottom';
  } catch {
    return NextResponse.json({ error: 'bad_form' }, { status: 400 });
  }
  if (!file) return NextResponse.json({ error: 'no_file' }, { status: 400 });

  const text = await file.text();
  const allRows = parseCsvText(text);
  if (allRows.length === 0) return NextResponse.json({ error: 'empty_csv' }, { status: 400 });

  // Header detection: assume first row is a header unless any cell
  // matches the email regex.
  const firstRowHasEmail = allRows[0].some(c => EMAIL_RE.test(c));
  const headerCols = firstRowHasEmail ? null : allRows[0];
  const dataRows = firstRowHasEmail ? allRows : allRows.slice(1);
  const colMap = headerCols ? inferEnrichColMap(headerCols) : null;

  const fxCompany = colMap?.company ?? 0;
  const fxFirstName = colMap?.first_name ?? 1;
  const fxFullName = colMap?.full_name ?? null;
  const fxEmail = colMap?.email ?? null;

  if (fxCompany == null || fxFirstName == null) {
    return NextResponse.json({
      error: 'missing_columns',
      detail: 'Need at least Company/Website and First Name columns.',
      header: headerCols,
    }, { status: 400 });
  }

  const supabase = createAdminClient();

  // Snapshot pool size before so the history UI can show a delta.
  const { data: poolFresh } = await supabase.rpc('email_tool_fresh_remaining');
  const poolSizeBefore = (poolFresh ?? null) as number | null;

  // Insert job row.
  const { data: jobInsert, error: jobErr } = await supabase
    .from('enrich_jobs')
    .insert({
      created_by: session.id,
      status: 'queued',
      mode,
      file_name: file.name,
      total_rows: dataRows.length,
      pool_size_before: poolSizeBefore,
    })
    .select('id')
    .single();
  if (jobErr || !jobInsert) {
    return NextResponse.json({ error: 'job_insert_failed', detail: jobErr?.message }, { status: 500 });
  }
  const job_id = jobInsert.id as string;

  // Bulk-insert per-row records. Chunked because Supabase's REST has
  // a row-count ceiling per request.
  const rowInserts = dataRows.map((row, i) => {
    const companyRaw = (row[fxCompany] ?? '').trim();
    const firstName = (row[fxFirstName] ?? '').trim();
    const fullName = fxFullName != null ? (row[fxFullName] ?? '').trim() : '';
    const givenEmail = fxEmail != null ? (row[fxEmail] ?? '').trim() : '';
    // Always extract domain from the raw value first (works whether the
    // CSV column was a URL, a "name.com" string, or a plain name with no
    // dots — extractDomain returns null in the last case). Then prettify
    // the company NAME for template substitution. URLs like
    // "https://elementary-data.com/" → "Elementary Data".
    return {
      job_id,
      row_index: i,
      first_name: firstName || null,
      full_name: fullName || null,
      company: prettifyCompanyName(companyRaw),
      domain: extractDomain(companyRaw),
      given_email: givenEmail && EMAIL_RE.test(givenEmail) ? givenEmail.toLowerCase() : null,
      status: 'pending',
    };
  });

  for (let i = 0; i < rowInserts.length; i += ROW_INSERT_CHUNK) {
    const slice = rowInserts.slice(i, i + ROW_INSERT_CHUNK);
    const { error } = await supabase.from('enrich_job_rows').insert(slice);
    if (error) {
      // Partial failure — record the error on the job and bail.
      await supabase
        .from('enrich_jobs')
        .update({ status: 'error', last_error: `row_insert_failed:${error.message}` })
        .eq('id', job_id);
      return NextResponse.json({ error: 'row_insert_failed', detail: error.message, job_id }, { status: 500 });
    }
  }

  return NextResponse.json({ job_id, total_rows: dataRows.length, mode });
}
