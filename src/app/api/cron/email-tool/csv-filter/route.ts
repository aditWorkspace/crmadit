// POST /api/cron/email-tool/csv-filter — admin-only CSV upload + filter.
// Accepts multipart form-data with one `file` field. Reads the CSV,
// extracts the email from each row via regex (column-agnostic),
// drops rows whose email is already in email_blacklist, then bulk-
// inserts the SURVIVING emails into email_blacklist (ON CONFLICT DO
// NOTHING) — these are "about to be sent" so we mark them so future
// pool batches skip them.
//
// Lives under /api/cron/* as a Vercel deployment-protection workaround
// (matches the other email-tool routes).
//
// Returns text/csv with the surviving rows preserved verbatim from the
// input. Summary numbers are surfaced via custom X-* response headers.
//
// Note: we do NOT delete from email_pool. The pick_batch RPC anti-joins
// against the blacklist already, so freshly-blacklisted emails will be
// skipped automatically on the next batch.
export const maxDuration = 120;

import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/lib/session';
import { createAdminClient } from '@/lib/supabase/admin';

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const CHUNK = 1000;

export async function POST(req: NextRequest) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ ok: false, reason: 'unauthenticated' }, { status: 401 });
  if (!session.is_admin) return NextResponse.json({ ok: false, reason: 'forbidden' }, { status: 403 });

  let file: File | null = null;
  try {
    const form = await req.formData();
    const f = form.get('file');
    if (typeof f !== 'string' && f) file = f as File;
  } catch {
    return NextResponse.json({ ok: false, reason: 'bad_form' }, { status: 400 });
  }

  if (!file) {
    return NextResponse.json({ ok: false, reason: 'no_file' }, { status: 400 });
  }

  const text = await file.text();

  // Split on \r\n or \n; preserve the original line content for output.
  // Empty trailing lines are dropped.
  const rawLines = text.split(/\r?\n/);
  // Drop trailing empties so we don't write a trailing blank line into output.
  while (rawLines.length > 0 && rawLines[rawLines.length - 1] === '') rawLines.pop();

  if (rawLines.length === 0) {
    return NextResponse.json({ ok: false, reason: 'empty_csv' }, { status: 400 });
  }

  // Heuristic header detection: if the first line has no email-looking
  // string in it, treat it as a header and pass it through verbatim.
  const firstLine = rawLines[0];
  const firstLineHasEmail = EMAIL_RE.test(firstLine);
  // Reset regex state (global flag).
  EMAIL_RE.lastIndex = 0;

  const headerLine = firstLineHasEmail ? null : firstLine;
  const dataLines = firstLineHasEmail ? rawLines : rawLines.slice(1);

  // Pull out emails per row. Rows without any email are passed through
  // unchanged (we have no signal to filter on).
  type Row = { line: string; email: string | null };
  const rows: Row[] = dataLines.map(line => {
    const m = line.match(EMAIL_RE);
    return { line, email: m && m.length > 0 ? m[0].toLowerCase() : null };
  });

  const inputRows = rows.length;
  const allEmails = Array.from(new Set(rows.map(r => r.email).filter((e): e is string => !!e)));

  const supabase = createAdminClient();

  // Look up which of these emails are already blacklisted. Chunk the IN()
  // to stay under postgrest URL length limits on huge uploads.
  const alreadyBlacklisted = new Set<string>();
  for (let i = 0; i < allEmails.length; i += CHUNK) {
    const slice = allEmails.slice(i, i + CHUNK);
    const { data, error } = await supabase
      .from('email_blacklist')
      .select('email')
      .in('email', slice);
    if (error) {
      return NextResponse.json({ ok: false, reason: 'blacklist_lookup_failed', detail: error.message }, { status: 500 });
    }
    for (const r of (data ?? []) as Array<{ email: string }>) {
      alreadyBlacklisted.add(r.email);
    }
  }

  const survivingRows: Row[] = [];
  const survivingEmails: string[] = [];
  for (const r of rows) {
    if (r.email && alreadyBlacklisted.has(r.email)) continue;
    survivingRows.push(r);
    if (r.email) survivingEmails.push(r.email);
  }

  // Insert surviving emails into the blacklist so they don't get sent
  // out again from the pool in the future.
  const uniqueSurviving = Array.from(new Set(survivingEmails));
  const beforeRes = await supabase
    .from('email_blacklist')
    .select('*', { count: 'exact', head: true });
  const before = beforeRes.count ?? 0;

  for (let i = 0; i < uniqueSurviving.length; i += CHUNK) {
    const slice = uniqueSurviving.slice(i, i + CHUNK).map(email => ({ email }));
    const { error } = await supabase
      .from('email_blacklist')
      .upsert(slice, { onConflict: 'email', ignoreDuplicates: true });
    if (error) {
      return NextResponse.json({ ok: false, reason: 'blacklist_insert_failed', detail: error.message }, { status: 500 });
    }
  }

  const afterRes = await supabase
    .from('email_blacklist')
    .select('*', { count: 'exact', head: true });
  const after = afterRes.count ?? 0;
  const newlyBlacklisted = after - before;

  // Build the output CSV: same header (if any), then surviving rows.
  const outLines: string[] = [];
  if (headerLine !== null) outLines.push(headerLine);
  for (const r of survivingRows) outLines.push(r.line);
  // Trailing newline for friendliness with most CSV consumers.
  const outCsv = outLines.join('\n') + '\n';

  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `filtered-${ts}.csv`;

  return new NextResponse(outCsv, {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'X-Input-Rows': String(inputRows),
      'X-Output-Rows': String(survivingRows.length),
      'X-Already-Blacklisted': String(alreadyBlacklisted.size),
      'X-Newly-Blacklisted': String(newlyBlacklisted),
      'X-Pool-Removed': '0',
      // Lets the browser fetch read the X-* headers; without this they're
      // hidden by CORS-style allowlist on cross-origin reads. Same-origin
      // works without it but it's harmless and explicit.
      'Access-Control-Expose-Headers': 'X-Input-Rows, X-Output-Rows, X-Already-Blacklisted, X-Newly-Blacklisted, X-Pool-Removed, Content-Disposition',
    },
  });
}
