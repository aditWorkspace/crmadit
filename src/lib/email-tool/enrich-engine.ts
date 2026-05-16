// Per-row enrichment pipeline, extracted from the legacy SSE route so
// the background worker (/api/cron/email-tool/enrich/worker) can call
// the exact same logic.
//
// Pipeline (one DB row in → one outcome out):
//   1. Build candidate list:
//        - given_email (if CSV had one and it's well-formed) — always tried first
//        - guessEmails(first/full/domain) — 1–3 patterns in probability order
//   2. For each candidate in order, call bulkemailchecker.verify().
//      - status === 'passed' → accept candidate, short-circuit.
//      - status === 'failed' / 'unknown' → continue to next candidate.
//      - api error → continue (don't credit-burn on transient errors).
//   3. If no candidate passed → call icypeas.findEmail().
//      - returns email → accept it.
//      - returns null / timeout → drop row.
//   4. Final guard: looksLikeMatch(first_name, full_name, accepted_email).
//      Mismatch → drop with reason 'name_mismatch'.
//   5. Return outcome with all counters.
//
// The worker uses the returned counters to update both the per-row
// status AND the aggregate job-level counters atomically.

import { verifyEmail } from '@/lib/external/bulkemailchecker';
import { findEmailWithRetries, type RetryAttempt } from '@/lib/external/icypeas';
import { guessEmails } from './email-guesses';
import { looksLikeMatch } from './name-email-match';
import { probeDomainForCompany } from './domain-probe';
import type { createAdminClient } from '@/lib/supabase/admin';

type Supa = ReturnType<typeof createAdminClient>;

export interface EnrichRowInput {
  row_index: number;
  first_name: string | null;
  full_name: string | null;
  company: string | null;
  domain: string | null;
  given_email: string | null;
}

export type EnrichOutcomeStatus = 'kept' | 'dropped' | 'name_mismatch';

export interface EnrichOutcome {
  status: EnrichOutcomeStatus;
  final_email: string | null;
  candidates_tried: string[];
  bec_calls: number;
  bec_passes: number;
  bec_fails: number;
  icypeas_calls: number;
  icypeas_status: string | null;
  cost_usd: number;
  drop_reason: string | null;
}

const EMAIL_RE = /^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/i;

export async function processEnrichRow(
  input: EnrichRowInput,
  supabase?: Supa,
): Promise<EnrichOutcome> {
  // ── Pre-enrichment dedupe ────────────────────────────────────────────────
  // If a lead with this (first_name, company) is already in email_pool —
  // either pending or already sent — skip the entire enrichment pipeline.
  // The lead is already known: re-running BEC + Icypeas just burns API
  // credits with no upside (flushJobToPool would dedupe at insert time
  // anyway). Saves ~$0.005-$0.015 per skipped row.
  //
  // Match strategy: case-insensitive equality on first_name + company.
  // This catches the 2026-05-16 case where re-uploading yc_companies_final.csv
  // would re-process all 4149 rows and spend ~$0.66 on Icypeas calls for
  // rows that turned out to already be in email_pool / email_blacklist.
  //
  // Caveats:
  //  - Doesn't match across name variants ("Mike" vs "Michael", accents)
  //  - Doesn't match across company-name variants ("Acme" vs "Acme Inc")
  //  - Doesn't dedupe against email_blacklist directly (no name/company
  //    columns there). But blacklisted leads also remain in email_pool
  //    with sequence below the pointer, so the email_pool join catches
  //    them too.
  if (supabase && input.first_name && input.company) {
    const { data: existing } = await supabase
      .from('email_pool')
      .select('email')
      .ilike('first_name', input.first_name)
      .ilike('company', input.company)
      .limit(1);
    if (existing && existing.length > 0) {
      const knownEmail = (existing[0] as { email: string }).email;
      return {
        status: 'dropped',
        final_email: knownEmail,
        candidates_tried: [],
        bec_calls: 0,
        bec_passes: 0,
        bec_fails: 0,
        icypeas_calls: 0,
        icypeas_status: 'skipped_dedupe',
        cost_usd: 0,
        drop_reason: 'already_known_lead',
      };
    }
  }

  const candidates: string[] = [];
  // If CSV had a given_email and it's well-formed, try it first — user-
  // supplied beats anything we guess. We still verify it (BEC catches
  // dead mailboxes the user typed in).
  if (input.given_email && EMAIL_RE.test(input.given_email)) {
    candidates.push(input.given_email.toLowerCase());
  }

  // Resolve a working domain. Three sources tried in order:
  //   1. domain extracted from the CSV's company/url field (best)
  //   2. DNS MX probe of <company>.{com,ai,io,co,…} (free, ~1s)
  //   3. fall through to Icypeas with the company name (~$0.01)
  //
  // The DNS probe was added 2026-05-16 after observing that ~25% of YC
  // CSV rows were dropping to Icypeas NOT_FOUND because no domain was
  // available — many of those companies (e.g. "Indemni", "GetCrux") do
  // have real domains, just at .ai / .io / .so TLDs. Probing first
  // lets us reuse the cheaper BEC pattern guesser instead.
  let workingDomain: string | null = input.domain;
  if (!workingDomain && input.company) {
    workingDomain = await probeDomainForCompany(input.company);
  }

  if (workingDomain) {
    for (const g of guessEmails({
      firstName: input.first_name,
      fullName: input.full_name,
      domain: workingDomain,
    })) {
      if (!candidates.includes(g)) candidates.push(g);
    }
  }

  let bec_calls = 0;
  let bec_passes = 0;
  let bec_fails = 0;
  let cost_usd = 0;
  let accepted: string | null = null;
  for (const candidate of candidates) {
    try {
      const r = await verifyEmail(candidate);
      bec_calls++;
      if (r.status !== 'unknown') cost_usd += 0.001;
      if (r.status === 'passed') {
        accepted = candidate;
        bec_passes++;
        break;
      } else {
        bec_fails++;
      }
    } catch {
      // network/api error — pretend it was 'unknown', fall through to next candidate
    }
  }

  let icypeas_calls = 0;
  let icypeas_status: string | null = null;
  if (!accepted) {
    if (!input.first_name || (!workingDomain && !input.company)) {
      return {
        status: 'dropped',
        final_email: null,
        candidates_tried: candidates,
        bec_calls, bec_passes, bec_fails,
        icypeas_calls, icypeas_status,
        cost_usd,
        drop_reason: !input.first_name ? 'no_first_name' : 'no_company',
      };
    }
    try {
      const tokens = (input.full_name ?? '').split(/\s+/).filter(Boolean);
      const lastName = tokens.length >= 2 ? tokens.slice(1).join(' ') : undefined;
      const fullNameBlob = (input.full_name ?? input.first_name).trim();
      const bareCompany = (input.company ?? '').trim();
      const primaryDomain = workingDomain || bareCompany;
      // Run two Icypeas searches in parallel. NOT_FOUND is free so the
      // only cost is the wall-clock of the slower attempt, which races
      // the faster one. The B-mutator (full name as one blob + bare
      // company name) recovers rows where naive first/last tokenization
      // confuses Icypeas — names with parentheticals, suffixes, double
      // surnames, etc. See plan docs (gleaming-inventing-glacier.md)
      // for the rationale.
      const attempts: RetryAttempt[] = [
        {
          label: 'A',
          args: {
            firstName: input.first_name,
            lastName,
            domainOrCompany: primaryDomain,
          },
        },
      ];
      // Attempt B: pass the bare company name (no TLD) instead of the
      // DNS-probed domain. This wins when our domain probe accepted a
      // wrong/parked TLD (e.g. "Forge" → forge.ai which is unrelated;
      // Icypeas knows the real domain is forgehq.com). The 2026-05-16
      // experiment showed this strategy recovered 3 of 15 dead rows
      // that the prior fullName-blob B never won. We dropped the
      // fullName-blob mutator entirely — it won 0 rows in production
      // data, just doubled Icypeas load with no recall.
      //
      // Only add B if it differs from A — i.e. only when bareCompany
      // exists AND differs from primaryDomain. Otherwise we're paying
      // double poll-time for the identical query.
      const aDomain = primaryDomain;
      const bDomain = bareCompany;
      const bDiffers = bDomain && bDomain !== aDomain;
      if (bDiffers) {
        attempts.push({
          label: 'B',
          args: {
            firstName: input.first_name,
            lastName,
            domainOrCompany: bDomain,
          },
        });
      }
      // fullNameBlob no longer used as a mutator; keep the variable
      // declaration to avoid breaking the unused-vars lint elsewhere
      // — referenced here to keep TypeScript happy.
      void fullNameBlob;
      icypeas_calls = attempts.length;
      const r = await findEmailWithRetries(attempts);
      icypeas_status = r.status;
      // r.status is like "DEBITED@A/NOT_FOUND@B" — charge per DEBITED.
      // We don't double-count cost because the same person resolves to
      // the same Icypeas record across the two attempts in practice,
      // but be safe and count each DEBITED in the status string.
      const debitedCount = (r.status.match(/DEBITED/g) ?? []).length;
      cost_usd += 0.01 * debitedCount;
      if (r.email) accepted = r.email.toLowerCase();
    } catch (err) {
      icypeas_status = `error:${(err as Error).message?.slice(0, 100)}`;
    }
  }

  if (!accepted) {
    return {
      status: 'dropped',
      final_email: null,
      candidates_tried: candidates,
      bec_calls, bec_passes, bec_fails,
      icypeas_calls, icypeas_status,
      cost_usd,
      drop_reason: 'no_email_found',
    };
  }

  // Final guard — the looksLikeMatch heuristic catches obvious CSV
  // misalignment (Dustin@ vs Dylan name from the Friday incident).
  const match = looksLikeMatch(input.first_name, input.full_name ?? input.first_name, accepted);
  if (!match.ok) {
    return {
      status: 'name_mismatch',
      final_email: accepted,
      candidates_tried: candidates,
      bec_calls, bec_passes, bec_fails,
      icypeas_calls, icypeas_status,
      cost_usd,
      drop_reason: `name_email_mismatch:${match.reason}`,
    };
  }

  return {
    status: 'kept',
    final_email: accepted,
    candidates_tried: candidates,
    bec_calls, bec_passes, bec_fails,
    icypeas_calls, icypeas_status,
    cost_usd,
    drop_reason: null,
  };
}
