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

// Minimal CSV parser. Handles quoted fields with embedded commas and
// doubled-quote escapes. Doesn't handle multi-line quoted fields (the
// outer split('\n') would break those) — fine for our use case where
// quoting is only used to escape commas inside company names.
function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else inQuotes = false;
      } else {
        cur += c;
      }
    } else if (c === ',') {
      out.push(cur);
      cur = '';
    } else if (c === '"' && cur === '') {
      inQuotes = true;
    } else {
      cur += c;
    }
  }
  out.push(cur);
  return out.map(s => s.trim());
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
  const rawLines = text.split(/\r?\n/);
  while (rawLines.length > 0 && rawLines[rawLines.length - 1] === '') rawLines.pop();
  if (rawLines.length === 0) {
    return NextResponse.json({ ok: false, reason: 'empty_csv' }, { status: 400 });
  }

  // Header detection: if the first line has no email-looking string,
  // treat it as a header. Pass through verbatim in the response CSV.
  const firstLine = rawLines[0];
  const firstLineHasEmail = EMAIL_RE.test(firstLine);
  EMAIL_RE.lastIndex = 0;
  const headerLine = firstLineHasEmail ? null : firstLine;
  const dataLines = firstLineHasEmail ? rawLines : rawLines.slice(1);
  const headerCols = headerLine ? parseCsvLine(headerLine) : null;
  const colMap = inferColumnMap(headerCols);

  type Row = { line: string; cols: string[]; email: string };
  const rows: Row[] = [];
  let skippedNoEmail = 0;
  for (const line of dataLines) {
    // Skip totally blank lines (don't count them toward "no email" — they're
    // just whitespace artifacts).
    if (line.trim() === '') continue;
    const m = line.match(EMAIL_RE);
    if (!m || m.length === 0) {
      skippedNoEmail++;
      continue;
    }
    rows.push({ line, cols: parseCsvLine(line), email: m[0].toLowerCase() });
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
  if (headerLine !== null) outLines.push(headerLine);
  for (const r of survivingRows) outLines.push(r.line);
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
      'X-Already-Blacklisted': String(alreadyBlacklisted.size),
      'X-Newly-Blacklisted': String(newlyBlacklisted),
      'X-Pool-Inserted': String(poolInserted),
      'X-Already-In-Pool': String(alreadyInPool),
      'X-Pool-Removed': '0',
      'Access-Control-Expose-Headers':
        'X-Mode, X-Input-Rows, X-Output-Rows, X-Skipped-No-Email, X-Already-Blacklisted, X-Newly-Blacklisted, X-Pool-Inserted, X-Already-In-Pool, X-Pool-Removed, Content-Disposition',
    },
  });
}
