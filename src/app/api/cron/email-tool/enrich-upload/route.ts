// POST /api/cron/email-tool/enrich-upload — admin-only.
//
// Takes a CSV with First Name + Company/Website (Email optional) and
// enriches it via guess-then-verify-then-fallback before inserting
// survivors into email_pool. Streams per-row progress to the client as
// JSON-line events for a live terminal-style UI.
//
// Pipeline per row:
//   1. Pull first_name + company/website from row (header-aware).
//   2. Extract bare domain from company/website.
//   3. candidate_email = row.email ?? guess(`firstname@domain`)
//   4. If candidate present → call bulkemailchecker.
//      - passed: keep this email
//      - failed/unknown: fall through to icypeas
//      - api errors: skip bulkemailchecker, go straight to icypeas
//   5. Otherwise (no candidate / fell through) → icypeas search by
//      firstname + lastname? + domainOrCompany.
//      - returns email → keep it
//      - returns null → drop row
//   6. Final guard: name-email-match. Mismatch → drop.
//   7. Buffer kept rows; after all rows processed, batch-insert into
//      email_pool at top (sequence < min) or bottom (sequence > max).
//
// Response: text/event-stream. One JSON object per line, separated by
// \n\n. Event types: start, row, batch, done, error. See PER-ROW
// EVENT SHAPE below.
//
// /api/cron/* prefix is the project's Vercel deployment-protection
// workaround (matches /csv-filter, /ab-rebalance). Auth is admin
// session, not CRON_SECRET — recipients aren't hitting this; admins are.
//
// maxDuration = 300 is the Vercel Hobby plan cap. At ~10-15s per
// bulkemailchecker call + ~3-10s per icypeas roundtrip, this fits
// roughly 20-30 rows per upload. For bigger lists, the SSE stream
// will cut off mid-process and the user can re-upload the unprocessed
// tail (rows already added to email_pool are persisted via the
// batched insert step, but only AFTER the full loop finishes — so on
// timeout, NO rows are inserted). Plan upgrade required for larger
// batches; see plan file for the alternative chunked architecture.
export const maxDuration = 300;
export const runtime = 'nodejs';

import { NextRequest } from 'next/server';
import { getSessionFromRequest } from '@/lib/session';
import { createAdminClient } from '@/lib/supabase/admin';
import { parseCsvText, inferEnrichColMap } from '@/lib/email-tool/csv-parse';
import { extractDomain, guessEmail } from '@/lib/email-tool/domain-extract';
import { looksLikeMatch } from '@/lib/email-tool/name-email-match';
import { verifyEmail } from '@/lib/external/bulkemailchecker';
import { findEmail } from '@/lib/external/icypeas';

const INSERT_CHUNK = 1000;
const BEC_RATE_LIMIT_MS = 200; // tiny pad to stay under 1500/hr cap

type EnrichMode = 'pool_top' | 'pool_bottom';

interface KeptRow {
  email: string;
  first_name: string | null;
  full_name: string | null;
  company: string | null;
}

interface EmitFn {
  (event: Record<string, unknown>): void;
}

/** Helpers for SSE encoding. */
function makeEmitter(controller: ReadableStreamDefaultController<Uint8Array>): EmitFn {
  const encoder = new TextEncoder();
  return (event) => {
    try {
      controller.enqueue(encoder.encode(JSON.stringify(event) + '\n\n'));
    } catch {
      // Connection closed mid-stream. Swallow — the surrounding loop
      // will notice and break.
    }
  };
}

export async function POST(req: NextRequest) {
  const session = await getSessionFromRequest(req);
  if (!session) {
    return new Response(JSON.stringify({ error: 'unauthenticated' }), {
      status: 401, headers: { 'Content-Type': 'application/json' },
    });
  }
  if (!session.is_admin) {
    return new Response(JSON.stringify({ error: 'admin only' }), {
      status: 403, headers: { 'Content-Type': 'application/json' },
    });
  }

  // ── Form parsing (sync, before streaming starts) ───────────────────
  let file: File | null = null;
  let mode: EnrichMode = 'pool_top';
  try {
    const form = await req.formData();
    const f = form.get('file');
    if (typeof f !== 'string' && f) file = f as File;
    const m = form.get('mode');
    if (m === 'pool_bottom') mode = 'pool_bottom';
  } catch {
    return new Response(JSON.stringify({ error: 'bad_form' }), {
      status: 400, headers: { 'Content-Type': 'application/json' },
    });
  }
  if (!file) {
    return new Response(JSON.stringify({ error: 'no_file' }), {
      status: 400, headers: { 'Content-Type': 'application/json' },
    });
  }

  const text = await file.text();
  const allRows = parseCsvText(text);
  if (allRows.length === 0) {
    return new Response(JSON.stringify({ error: 'empty_csv' }), {
      status: 400, headers: { 'Content-Type': 'application/json' },
    });
  }
  // Header detection: assume first row is a header unless it contains
  // an email-looking value. (Lower bar than csv-filter's regex test
  // because we want to be tolerant of "Company, Name" headers.)
  const emailRe = /^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/i;
  const firstRowHasEmail = allRows[0].some(c => emailRe.test(c));
  const headerCols = firstRowHasEmail ? null : allRows[0];
  const dataRows = firstRowHasEmail ? allRows : allRows.slice(1);
  const colMap = headerCols ? inferEnrichColMap(headerCols) : null;
  // If no header detected and no colMap, fall back to fixed positions:
  // col 0 = company/website, col 1 = first_name, col 2 = email (optional).
  const fxCompany = colMap?.company ?? 0;
  const fxFirstName = colMap?.first_name ?? 1;
  const fxFullName = colMap?.full_name ?? null;
  const fxEmail = colMap?.email ?? null;
  if (fxCompany == null || fxFirstName == null) {
    return new Response(JSON.stringify({
      error: 'missing_columns',
      detail: 'Need at least Company/Website and First Name columns. Header detected: ' + JSON.stringify(headerCols),
    }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  }

  // ── Streaming response ────────────────────────────────────────────
  const supabase = createAdminClient();
  const kept: KeptRow[] = [];

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = makeEmitter(controller);
      let bec_calls = 0;
      let icypeas_calls = 0;
      let dropped = 0;
      let cost_usd = 0;

      emit({
        type: 'start',
        total: dataRows.length,
        mode,
        cols: { company: fxCompany, first_name: fxFirstName, full_name: fxFullName, email: fxEmail },
        bec_credits_remaining: null,
      });

      for (let i = 0; i < dataRows.length; i++) {
        const row = dataRows[i];
        const companyRaw = (row[fxCompany] ?? '').trim();
        const firstName = (row[fxFirstName] ?? '').trim();
        const fullName = fxFullName != null ? (row[fxFullName] ?? '').trim() : '';
        const givenEmail = fxEmail != null ? (row[fxEmail] ?? '').trim() : '';
        const domain = extractDomain(companyRaw);

        emit({
          type: 'row', i, stage: 'parse', first_name: firstName,
          company: companyRaw, domain,
        });

        // Decide candidate email.
        let candidate: string | null = null;
        if (givenEmail && emailRe.test(givenEmail)) {
          candidate = givenEmail.toLowerCase();
          emit({ type: 'row', i, stage: 'given_email', email: candidate });
        } else if (domain) {
          candidate = guessEmail(firstName, domain);
          if (candidate) {
            emit({ type: 'row', i, stage: 'guess', email: candidate });
          }
        }

        // 1) bulkemailchecker if we have a candidate.
        let kept_email: string | null = null;
        if (candidate) {
          try {
            const becStart = Date.now();
            const becResult = await verifyEmail(candidate);
            bec_calls++;
            // cost: passed/failed = 1 credit. unknown = free.
            if (becResult.status !== 'unknown') cost_usd += 0.001;
            emit({
              type: 'row', i, stage: 'bec_check',
              email: candidate,
              outcome: becResult.status,
              event_name: becResult.event,
              latency_ms: Date.now() - becStart,
              credits_left: becResult.creditsRemaining,
            });
            if (becResult.status === 'passed') {
              kept_email = candidate;
            }
          } catch (err) {
            // Network / API failure — treat as 'unknown' and fall through.
            emit({
              type: 'row', i, stage: 'bec_check',
              outcome: 'error',
              event_name: 'fetch_failed',
              error: (err as Error).message?.slice(0, 200),
            });
          }
          // Rate-limit pad before the next bec call.
          if (i < dataRows.length - 1) {
            await new Promise(r => setTimeout(r, BEC_RATE_LIMIT_MS));
          }
        }

        // 2) Icypeas fallback.
        if (!kept_email) {
          if (!firstName) {
            emit({ type: 'row', i, stage: 'dropped', reason: 'no_first_name' });
            dropped++;
            continue;
          }
          const domainOrCompany = domain || companyRaw;
          if (!domainOrCompany) {
            emit({ type: 'row', i, stage: 'dropped', reason: 'no_company' });
            dropped++;
            continue;
          }
          try {
            const icyStart = Date.now();
            // If full_name is present, parse out last name; otherwise omit.
            const tokens = fullName.split(/\s+/).filter(Boolean);
            const lastName = tokens.length >= 2 ? tokens.slice(1).join(' ') : undefined;
            emit({
              type: 'row', i, stage: 'icypeas_submit',
              first_name: firstName, last_name: lastName, domain_or_company: domainOrCompany,
            });
            const result = await findEmail({ firstName, lastName, domainOrCompany });
            icypeas_calls++;
            // cost: DEBITED = $0.01. NOT_FOUND is free per their pricing.
            if (result.status === 'DEBITED') cost_usd += 0.01;
            emit({
              type: 'row', i, stage: 'icypeas_result',
              status: result.status, email: result.email,
              latency_ms: Date.now() - icyStart,
            });
            if (result.email) kept_email = result.email.toLowerCase();
          } catch (err) {
            emit({
              type: 'row', i, stage: 'icypeas_result',
              status: 'error', error: (err as Error).message?.slice(0, 200),
            });
          }
        }

        if (!kept_email) {
          emit({ type: 'row', i, stage: 'dropped', reason: 'no_email_found' });
          dropped++;
          continue;
        }

        // 3) Final guard: name ↔ email match (looksLikeMatch handles
        //    nicknames + initials patterns; nuke obvious mismatches).
        const match = looksLikeMatch(firstName, fullName || firstName, kept_email);
        if (!match.ok) {
          emit({
            type: 'row', i, stage: 'dropped',
            reason: 'name_email_mismatch', detail: match.reason,
            email: kept_email,
          });
          dropped++;
          continue;
        }

        kept.push({
          email: kept_email,
          first_name: firstName || null,
          full_name: fullName || null,
          company: companyRaw || null,
        });
        emit({
          type: 'row', i, stage: 'kept', email: kept_email,
          kept_so_far: kept.length, dropped_so_far: dropped,
          bec_calls, icypeas_calls, cost_usd: Math.round(cost_usd * 1000) / 1000,
        });
      } // end for-row loop

      // ── Pool insert phase ─────────────────────────────────────────
      emit({
        type: 'batch', stage: 'pool_lookup',
        kept_count: kept.length, mode,
      });

      // Drop rows whose email is already in pool (avoid double-add).
      // Also drop rows whose email is in the blacklist (don't re-send).
      const allEmails = Array.from(new Set(kept.map(k => k.email)));
      const inPool = new Set<string>();
      const inBlacklist = new Set<string>();
      const LOOKUP_CHUNK = 200;
      for (let i = 0; i < allEmails.length; i += LOOKUP_CHUNK) {
        const slice = allEmails.slice(i, i + LOOKUP_CHUNK);
        const { data: pp } = await supabase.from('email_pool').select('email').in('email', slice);
        for (const r of (pp ?? []) as Array<{ email: string }>) inPool.add(r.email);
        const { data: bl } = await supabase.from('email_blacklist').select('email').in('email', slice);
        for (const r of (bl ?? []) as Array<{ email: string }>) inBlacklist.add(r.email);
      }

      const survivors = kept.filter(k => !inPool.has(k.email) && !inBlacklist.has(k.email));
      const skippedAlreadyInPool = kept.length - survivors.length - kept.filter(k => inBlacklist.has(k.email)).length;
      const skippedBlacklisted = kept.filter(k => inBlacklist.has(k.email)).length;
      emit({
        type: 'batch', stage: 'pool_dedupe',
        already_in_pool: skippedAlreadyInPool,
        already_blacklisted: skippedBlacklisted,
        will_insert: survivors.length,
      });

      let insertedCount = 0;
      let restoredPtr: number | null = null;
      if (survivors.length > 0) {
        // Choose sequences (top: below current min; bottom: above current max).
        let startSequence: number;
        if (mode === 'pool_top') {
          const { data: minRow } = await supabase
            .from('email_pool').select('sequence').order('sequence', { ascending: true }).limit(1).maybeSingle();
          const min = (minRow as { sequence: number } | null)?.sequence ?? 0;
          startSequence = min - survivors.length;
          restoredPtr = startSequence;
        } else {
          const { data: maxRow } = await supabase
            .from('email_pool').select('sequence').order('sequence', { ascending: false }).limit(1).maybeSingle();
          const max = (maxRow as { sequence: number } | null)?.sequence ?? -1;
          startSequence = max + 1;
        }

        const inserts = survivors.map((s, idx) => ({
          sequence: startSequence + idx,
          email: s.email,
          company: s.company,
          full_name: s.full_name,
          first_name: s.first_name,
        }));

        for (let i = 0; i < inserts.length; i += INSERT_CHUNK) {
          const slice = inserts.slice(i, i + INSERT_CHUNK);
          const { error } = await supabase.from('email_pool').insert(slice);
          if (error) {
            emit({
              type: 'error', stage: 'pool_insert',
              detail: error.message, inserted_so_far: insertedCount,
            });
            break;
          }
          insertedCount += slice.length;
          emit({
            type: 'batch', stage: 'pool_insert_progress',
            inserted: insertedCount, total: inserts.length,
          });
        }

        if (mode === 'pool_top' && restoredPtr != null) {
          await supabase
            .from('email_pool_state')
            .update({
              next_sequence: restoredPtr,
              eff_remaining_seq: null,
              eff_remaining_fresh: null,
              eff_updated_at: null,
            })
            .eq('id', 1);
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

      emit({
        type: 'done',
        total: dataRows.length,
        kept: kept.length,
        dropped,
        bec_calls,
        icypeas_calls,
        cost_usd: Math.round(cost_usd * 1000) / 1000,
        inserted: insertedCount,
        already_in_pool: skippedAlreadyInPool,
        already_blacklisted: skippedBlacklisted,
        mode,
        pool_pointer: restoredPtr,
      });
      controller.close();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      'X-Accel-Buffering': 'no',
    },
  });
}
