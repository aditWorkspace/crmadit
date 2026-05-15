// POST /api/cron/email-tool/csv-filter — admin-only CSV upload + filter.
// Accepts multipart form-data with one `file` field. Three modes selected
// via the `mode` field:
//
//   mode=blacklist (default) — legacy "I'm sending these manually" flow.
//     Drops rows whose email is already blacklisted, BLACKLISTS the
//     survivors (so future pool batches skip them), and returns the
//     cleaned CSV.
//
//   mode=pool_top — add survivors to email_pool with sequence values
//     BELOW the current pointer and rewind the pointer so they get
//     picked FIRST by the next batch. Survivors are NOT blacklisted (we
//     want to send them); commit_batch will blacklist them once picked.
//
//   mode=pool_bottom — add survivors to email_pool with sequence values
//     ABOVE MAX(sequence) so they're picked LAST. Survivors not
//     blacklisted (same reasoning as pool_top).
//
// In all modes:
//   - Rows with no parseable email are SKIPPED entirely (reported in
//     X-Skipped-No-Email header).
//   - Rows whose email is already in email_blacklist are dropped.
//   - For pool modes, rows whose email is already in email_pool are
//     also dropped to avoid duplicate sends.
export const maxDuration = 120;

import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/lib/session';
import { createAdminClient } from '@/lib/supabase/admin';
import { looksLikeMatch } from '@/lib/email-tool/name-email-match';

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
// PostgREST URL length cap is ~8KB on Supabase's gateway. With avg
// email ~30 chars, 200 emails per IN() keeps the URL well under that
// while still letting us batch through ~3k uploads in a handful of
// round trips. The previous 1000 produced URLs >30KB and reliably
// 414'd as `blacklist_lookup_failed`.
const LOOKUP_CHUNK = 200;
// Inserts go via POST body, so the chunk size is bounded by payload
// rather than URL. 1000 is fine for both blacklist and pool inserts.
const INSERT_CHUNK = 1000;

type Mode = 'blacklist' | 'pool_top' | 'pool_bottom';

interface PoolRow {
  email: string;
  company: string | null;
  full_name: string | null;
  first_name: string | null;
}

// Single-pass streaming CSV parser. Honors RFC 4180 quoting INCLUDING
// multi-line quoted fields — a literal newline inside `"..."` stays
// inside the cell instead of tearing the row in two.
//
// Built in response to the 2026-05-15 incident: previous code split on
// \r?\n first then parsed each line independently, so a pitchbook-style
// row with a multi-line Company description would split into two
// "lines", and downstream rows would read the wrong column indices
// (off-by-N alignment between email and first_name/company).
function parseCsvText(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cur = '';
  let inQuotes = false;
  let cellStarted = false; // tracks whether we've consumed any non-quote chars in the current cell
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { cur += '"'; i++; }   // escaped quote ""
        else inQuotes = false;                          // closing quote
      } else {
        cur += c;
      }
    } else {
      if (c === ',') {
        row.push(cur);
        cur = '';
        cellStarted = false;
      } else if (c === '\r') {
        // ignore — row ends on \n; \r\n becomes single \n boundary
      } else if (c === '\n') {
        row.push(cur);
        cur = '';
        cellStarted = false;
        if (row.some(f => f !== '')) rows.push(row);
        row = [];
      } else if (c === '"' && !cellStarted) {
        inQuotes = true;
        cellStarted = true;
      } else {
        cur += c;
        cellStarted = true;
      }
    }
  }
  // EOF — flush partial cell/row if any content present.
  if (cur !== '' || row.length > 0) {
    row.push(cur);
    if (row.some(f => f !== '')) rows.push(row);
  }
  return rows.map(r => r.map(f => f.trim()));
}

// Helper for rendering rows back to a CSV-safe line — used to build
// the response CSV. Wraps any field that contains a comma, quote, or
// newline in quotes and escapes embedded quotes per RFC 4180.
function csvField(s: string): string {
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function csvLine(cols: string[]): string {
  return cols.map(csvField).join(',');
}

// Determine which column index maps to which pool field, based on the
// header row. Falls back to fixed positions matching pitchbook export
// format (Company, Contact, First Name, Email) when no header.
function inferColumnMap(header: string[] | null): {
  email: number;
  company: number | null;
  full_name: number | null;
  first_name: number | null;
} {
  if (header) {
    const norm = header.map(h => h.toLowerCase());
    const findIdx = (...keys: string[]) =>
      norm.findIndex(h => keys.some(k => h.includes(k)));
    const emailIdx = findIdx('email');
    const firstIdx = findIdx('first');
    // "contact" or "full name" — prefer a column that isn't already
    // first_name. The pitchbook format uses "Contact" for the full
    // person name.
    let fullIdx = norm.findIndex(h => h === 'contact' || h.includes('full name') || h === 'name');
    if (fullIdx === firstIdx) fullIdx = -1;
    const companyIdx = findIdx('company', 'organization', 'org');
    return {
      email: emailIdx >= 0 ? emailIdx : 3,
      company: companyIdx >= 0 ? companyIdx : null,
      full_name: fullIdx >= 0 ? fullIdx : null,
      first_name: firstIdx >= 0 ? firstIdx : null,
    };
  }
  return { email: 3, company: 0, full_name: 1, first_name: 2 };
}

export async function POST(req: NextRequest) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ ok: false, reason: 'unauthenticated' }, { status: 401 });
  if (!session.is_admin) return NextResponse.json({ ok: false, reason: 'forbidden' }, { status: 403 });

  let file: File | null = null;
  let modeRaw: FormDataEntryValue | null = null;
  try {
    const form = await req.formData();
    const f = form.get('file');
    if (typeof f !== 'string' && f) file = f as File;
    modeRaw = form.get('mode');
  } catch {
    return NextResponse.json({ ok: false, reason: 'bad_form' }, { status: 400 });
  }

  if (!file) {
    return NextResponse.json({ ok: false, reason: 'no_file' }, { status: 400 });
  }

  const mode: Mode =
    modeRaw === 'pool_top' ? 'pool_top'
    : modeRaw === 'pool_bottom' ? 'pool_bottom'
    : 'blacklist';

  const text = await file.text();
  const allRows = parseCsvText(text);
  if (allRows.length === 0) {
    return NextResponse.json({ ok: false, reason: 'empty_csv' }, { status: 400 });
  }

  // Header detection: if any field in the first row matches the email
  // regex, the first row IS data (no header); otherwise treat it as a
  // header. Reset EMAIL_RE between tests because of the /g flag.
  const firstRowHasEmail = allRows[0].some(f => { EMAIL_RE.lastIndex = 0; return EMAIL_RE.test(f); });
  EMAIL_RE.lastIndex = 0;
  const headerCols = firstRowHasEmail ? null : allRows[0];
  const dataRows = firstRowHasEmail ? allRows : allRows.slice(1);
  const colMap = inferColumnMap(headerCols);

  type Row = { cols: string[]; email: string };
  const rows: Row[] = [];
  let skippedNoEmail = 0;
  let skippedNameMismatch = 0;
  for (const cols of dataRows) {
    // Pull email from the mapped column. We no longer regex-hunt across
    // the whole row — the column is authoritative now that the parser
    // is RFC-4180 correct. If the cell isn't an email-shaped string,
    // count as no-email and skip.
    const emailCell = (cols[colMap.email] ?? '').trim();
    EMAIL_RE.lastIndex = 0;
    if (!emailCell || !EMAIL_RE.test(emailCell)) {
      EMAIL_RE.lastIndex = 0;
      skippedNoEmail++;
      continue;
    }
    EMAIL_RE.lastIndex = 0;
    const email = emailCell.toLowerCase();
    // Name-email match guard. User explicitly: "I would rather not
    // send the email than send with wrong info." See
    // src/lib/email-tool/name-email-match.ts for the heuristic.
    const firstName = colMap.first_name != null ? cols[colMap.first_name] ?? null : null;
    const fullName = colMap.full_name != null ? cols[colMap.full_name] ?? null : null;
    const match = looksLikeMatch(firstName, fullName, email);
    if (!match.ok) {
      skippedNameMismatch++;
      continue;
    }
    rows.push({ cols, email });
  }

  const inputRows = rows.length;
  const allEmails = Array.from(new Set(rows.map(r => r.email)));

  const supabase = createAdminClient();

  // Look up which of these emails are already blacklisted. Smaller
  // chunk than the insert chunk because GET URL length is the bottleneck.
  const alreadyBlacklisted = new Set<string>();
  for (let i = 0; i < allEmails.length; i += LOOKUP_CHUNK) {
    const slice = allEmails.slice(i, i + LOOKUP_CHUNK);
    const { data, error } = await supabase
      .from('email_blacklist')
      .select('email')
      .in('email', slice);
    if (error) {
      return NextResponse.json({
        ok: false,
        reason: 'blacklist_lookup_failed',
        detail: error.message,
        chunk_start: i,
        chunk_size: slice.length,
      }, { status: 500 });
    }
    for (const r of (data ?? []) as Array<{ email: string }>) {
      alreadyBlacklisted.add(r.email);
    }
  }

  // Survivors = rows whose email isn't already blacklisted.
  const survivingRows: Row[] = [];
  for (const r of rows) {
    if (alreadyBlacklisted.has(r.email)) continue;
    survivingRows.push(r);
  }
  const uniqueSurvivingEmails = Array.from(new Set(survivingRows.map(r => r.email)));

  let newlyBlacklisted = 0;
  let poolInserted = 0;
  let alreadyInPool = 0;

  if (mode === 'blacklist') {
    // Existing behavior: blacklist the survivors so the automated pool
    // never re-contacts them.
    const beforeRes = await supabase
      .from('email_blacklist')
      .select('*', { count: 'exact', head: true });
    const before = beforeRes.count ?? 0;

    for (let i = 0; i < uniqueSurvivingEmails.length; i += INSERT_CHUNK) {
      const slice = uniqueSurvivingEmails.slice(i, i + INSERT_CHUNK).map(email => ({ email }));
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
    newlyBlacklisted = (afterRes.count ?? 0) - before;
  } else {
    // pool_top / pool_bottom — first drop rows whose email is already in
    // the pool to avoid double-add.
    const inPool = new Set<string>();
    for (let i = 0; i < uniqueSurvivingEmails.length; i += LOOKUP_CHUNK) {
      const slice = uniqueSurvivingEmails.slice(i, i + LOOKUP_CHUNK);
      const { data, error } = await supabase
        .from('email_pool')
        .select('email')
        .in('email', slice);
      if (error) {
        return NextResponse.json({ ok: false, reason: 'pool_lookup_failed', detail: error.message }, { status: 500 });
      }
      for (const r of (data ?? []) as Array<{ email: string }>) {
        inPool.add(r.email);
      }
    }
    alreadyInPool = inPool.size;

    // Build pool rows, deduping by email (first occurrence wins).
    const poolRowsByEmail = new Map<string, PoolRow>();
    for (const r of survivingRows) {
      if (inPool.has(r.email)) continue;
      if (poolRowsByEmail.has(r.email)) continue;
      const company = colMap.company != null ? (r.cols[colMap.company] || null) : null;
      const fullName = colMap.full_name != null ? (r.cols[colMap.full_name] || null) : null;
      const firstName = colMap.first_name != null ? (r.cols[colMap.first_name] || null) : null;
      poolRowsByEmail.set(r.email, {
        email: r.email,
        company: company && company.length > 0 ? company : null,
        full_name: fullName && fullName.length > 0 ? fullName : null,
        first_name: firstName && firstName.length > 0 ? firstName : null,
      });
    }
    const poolRows = Array.from(poolRowsByEmail.values());
    const N = poolRows.length;

    if (N > 0) {
      // Determine the starting sequence based on mode.
      let startSequence: number;
      let updatePointerTo: number | null = null;

      if (mode === 'pool_top') {
        // Insert at sequences (min - N) .. (min - 1) so they sort before
        // every existing row. Rewind the pointer to (min - N) so the
        // pick_batch query (sequence >= pointer) includes them. Existing
        // rows below the old pointer are all blacklisted by construction
        // (every commit_batch blacklists picked rows), so the anti-join
        // filters them out — safe to rewind past them.
        const { data: minRow, error: minErr } = await supabase
          .from('email_pool')
          .select('sequence')
          .order('sequence', { ascending: true })
          .limit(1)
          .single();
        if (minErr && minErr.code !== 'PGRST116') {
          return NextResponse.json({ ok: false, reason: 'pool_minmax_failed', detail: minErr.message }, { status: 500 });
        }
        const currentMin = (minRow as { sequence: number } | null)?.sequence ?? 0;
        startSequence = currentMin - N;
        updatePointerTo = startSequence;
      } else {
        // pool_bottom — insert above the current max.
        const { data: maxRow, error: maxErr } = await supabase
          .from('email_pool')
          .select('sequence')
          .order('sequence', { ascending: false })
          .limit(1)
          .single();
        if (maxErr && maxErr.code !== 'PGRST116') {
          return NextResponse.json({ ok: false, reason: 'pool_minmax_failed', detail: maxErr.message }, { status: 500 });
        }
        const currentMax = (maxRow as { sequence: number } | null)?.sequence ?? -1;
        startSequence = currentMax + 1;
      }

      const inserts = poolRows.map((r, idx) => ({
        sequence: startSequence + idx,
        email: r.email,
        company: r.company,
        full_name: r.full_name,
        first_name: r.first_name,
      }));

      for (let i = 0; i < inserts.length; i += INSERT_CHUNK) {
        const slice = inserts.slice(i, i + INSERT_CHUNK);
        const { error } = await supabase.from('email_pool').insert(slice);
        if (error) {
          return NextResponse.json({
            ok: false,
            reason: 'pool_insert_failed',
            detail: error.message,
            chunk_start: i,
            inserted_so_far: i,
          }, { status: 500 });
        }
      }
      poolInserted = inserts.length;

      // Adjust the pointer for pool_top, and in all pool-mode cases
      // invalidate the eff_remaining_* cache so the dashboard recomputes.
      if (updatePointerTo != null) {
        const { error: ptrErr } = await supabase
          .from('email_pool_state')
          .update({
            next_sequence: updatePointerTo,
            eff_remaining_seq: null,
            eff_remaining_fresh: null,
            eff_updated_at: null,
          })
          .eq('id', 1);
        if (ptrErr) {
          return NextResponse.json({
            ok: false,
            reason: 'pool_pointer_update_failed',
            detail: ptrErr.message,
            inserted: poolInserted,
            hint: 'rows inserted but pointer not advanced; rerun or set next_sequence manually',
          }, { status: 500 });
        }
      } else {
        await supabase
          .from('email_pool_state')
          .update({
            eff_remaining_seq: null,
            eff_remaining_fresh: null,
            eff_updated_at: null,
          })
          .eq('id', 1);
      }
    }
  }

  // Build the output CSV preserving the original lines verbatim. For
  // blacklist mode this is "the rows you should send manually." For
  // pool modes it's "the rows we just added to the pool."
  const outLines: string[] = [];
  if (headerCols !== null) outLines.push(csvLine(headerCols));
  for (const r of survivingRows) outLines.push(csvLine(r.cols));
  const outCsv = outLines.join('\n') + '\n';

  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `filtered-${mode}-${ts}.csv`;

  return new NextResponse(outCsv, {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'X-Mode': mode,
      'X-Input-Rows': String(inputRows),
      'X-Output-Rows': String(survivingRows.length),
      'X-Skipped-No-Email': String(skippedNoEmail),
      'X-Skipped-Name-Mismatch': String(skippedNameMismatch),
      'X-Already-Blacklisted': String(alreadyBlacklisted.size),
      'X-Newly-Blacklisted': String(newlyBlacklisted),
      'X-Pool-Inserted': String(poolInserted),
      'X-Already-In-Pool': String(alreadyInPool),
      'X-Pool-Removed': '0',
      'Access-Control-Expose-Headers':
        'X-Mode, X-Input-Rows, X-Output-Rows, X-Skipped-No-Email, X-Skipped-Name-Mismatch, X-Already-Blacklisted, X-Newly-Blacklisted, X-Pool-Inserted, X-Already-In-Pool, X-Pool-Removed, Content-Disposition',
    },
  });
}
