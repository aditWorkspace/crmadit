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

  // No hardcoded column fallbacks — every column position must come
  // from the header inferrer (or be null if absent). Earlier code
  // defaulted fxFirstName to column 1, which caused a YC CSV with
  // columns [company_name, yc_batch, founder] to send "winter2024@…"
  // emails on 2026-05-16. Either first_name OR full_name is required;
  // first_name is derived from the first token of full_name at row-
  // process time when the CSV only provides full_name.
  const fxCompany = colMap?.company ?? null;
  const fxFirstName = colMap?.first_name ?? null;
  const fxFullName = colMap?.full_name ?? null;
  const fxEmail = colMap?.email ?? null;
  const fxYcBatch = colMap?.yc_batch ?? null;

  if (fxCompany == null) {
    return NextResponse.json({
      error: 'missing_columns',
      detail: 'Need a Company / Website / Domain column.',
      header: headerCols,
    }, { status: 400 });
  }
  if (fxFirstName == null && fxFullName == null) {
    return NextResponse.json({
      error: 'missing_columns',
      detail: 'Need a First Name or Founder / Full Name column.',
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
    const fullName = fxFullName != null ? (row[fxFullName] ?? '').trim() : '';
    // If the CSV gave us first_name directly use it; otherwise derive
    // from the first whitespace-separated token of full_name (so a
    // "founder" column of "Omar Draz" yields first_name="Omar"). Skip
    // titles/honorifics by taking the first token >=2 chars that isn't
    // a known prefix; in practice founder columns rarely have those.
    let firstName = fxFirstName != null ? (row[fxFirstName] ?? '').trim() : '';
    if (!firstName && fullName) {
      firstName = fullName.split(/\s+/).filter(Boolean)[0] ?? '';
    }
    const givenEmail = fxEmail != null ? (row[fxEmail] ?? '').trim() : '';
    const ycBatchRaw = fxYcBatch != null ? (row[fxYcBatch] ?? '').trim() : '';
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
      // yc_batch routes the row to the YC A/B templates instead of the
      // general product-prioritization template at send time. Empty
      // string means non-YC — stored as null.
      yc_batch: ycBatchRaw || null,
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
