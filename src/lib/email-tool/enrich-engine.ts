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
import { findEmail } from '@/lib/external/icypeas';
import { guessEmails } from './email-guesses';
import { looksLikeMatch } from './name-email-match';
import { probeDomainForCompany } from './domain-probe';

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

export async function processEnrichRow(input: EnrichRowInput): Promise<EnrichOutcome> {
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
      // Prefer the probe-discovered working domain over a raw company
      // name — Icypeas resolves domains faster + more reliably than
      // company-name lookups.
      const r = await findEmail({
        firstName: input.first_name,
        lastName,
        domainOrCompany: workingDomain || (input.company ?? ''),
      });
      icypeas_calls = 1;
      icypeas_status = r.status;
      if (r.status === 'DEBITED') cost_usd += 0.01;
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
