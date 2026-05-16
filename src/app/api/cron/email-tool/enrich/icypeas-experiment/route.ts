// POST /api/cron/email-tool/enrich/icypeas-experiment
//
// One-off experimentation endpoint for the 2026-05-16 hit-rate diagnosis.
// Picks N rows from a given job where both Icypeas A and B returned
// NOT_FOUND, then runs FIVE different Icypeas input strategies against
// each row to find which strategies recover the email when our current
// strategy missed.
//
// Strategies tested:
//   A_replay    : firstname + lastname + workingDomain    (current attempt A)
//   C1_multi_tld: firstname + lastname + each MX-valid TLD (parallel)
//   C2_lastname : ""        + lastname + workingDomain
//   C3_firstname: firstname + ""       + workingDomain
//   C4_company  : firstname + lastname + bareCompanyName  (no TLD)
//
// All NOT_FOUND results are free per Icypeas docs; the only cost is
// $0.01 per DEBITED hit. Worst-case cost for N=15 rows ≈ N * ~$0.05.
//
// Returns a structured report: per-strategy recall + per-row matrix.
// Does NOT modify enrich_job_rows — purely a diagnostic / planning tool.
//
// Admin session OR CRON_SECRET Bearer.

export const maxDuration = 240;

import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/lib/session';
import { createAdminClient } from '@/lib/supabase/admin';
import { findEmail } from '@/lib/external/icypeas';
import { probeAllValidDomains } from '@/lib/email-tool/domain-probe';

interface JobRow {
  row_index: number;
  first_name: string | null;
  full_name: string | null;
  company: string | null;
  domain: string | null;
}

interface StrategyResult {
  email: string | null;
  status: string;
  domains_tried?: string[];
}

interface RowReport {
  row_index: number;
  first_name: string | null;
  full_name: string | null;
  company: string | null;
  csv_domain: string | null;
  probed_domains: string[];
  results: Record<string, StrategyResult>;
}

async function authOk(req: NextRequest): Promise<boolean> {
  const bearer = req.headers.get('authorization');
  if (bearer === `Bearer ${process.env.CRON_SECRET}`) return true;
  const session = await getSessionFromRequest(req);
  return Boolean(session?.is_admin);
}

export async function POST(req: NextRequest) {
  if (!(await authOk(req))) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }

  const url = new URL(req.url);
  const jobId = url.searchParams.get('job_id');
  const nParam = parseInt(url.searchParams.get('n') ?? '15', 10);
  const n = Math.max(1, Math.min(50, isFinite(nParam) ? nParam : 15));
  if (!jobId) return NextResponse.json({ error: 'job_id_required' }, { status: 400 });

  const supabase = createAdminClient();

  // Pull N rows that both A & B Icypeas attempts missed.
  const { data: rowsData, error: rowsErr } = await supabase
    .from('enrich_job_rows')
    .select('row_index, first_name, full_name, company, domain')
    .eq('job_id', jobId)
    .eq('status', 'dropped')
    .like('icypeas_status', '%NOT_FOUND@A/NOT_FOUND@B%')
    .order('row_index', { ascending: true })
    .limit(n);
  if (rowsErr) {
    return NextResponse.json({ error: 'fetch_failed', detail: rowsErr.message }, { status: 500 });
  }
  const rows = (rowsData ?? []) as JobRow[];
  if (rows.length === 0) {
    return NextResponse.json({ error: 'no_test_rows', detail: 'no rows with icypeas_status matching NOT_FOUND@A/NOT_FOUND@B in this job' }, { status: 404 });
  }

  // For each row, run all 5 strategies in parallel. Strategy C1 spawns
  // multiple Icypeas calls (one per MX-valid TLD), so it's the heaviest.
  const reports: RowReport[] = await Promise.all(rows.map(async row => {
    const firstName = row.first_name ?? '';
    const fullName = row.full_name ?? firstName;
    const tokens = fullName.split(/\s+/).filter(Boolean);
    const lastName = tokens.length >= 2 ? tokens.slice(1).join(' ') : '';
    const company = row.company ?? '';
    const csvDomain = row.domain ?? '';

    // DNS-probe ALL valid domains. Workingdomain = first one (matches
    // engine behavior). Probed list = all viable for C1.
    const probedDomains = await probeAllValidDomains(company);
    const workingDomain = csvDomain || probedDomains[0] || '';

    // Skip strategies that can't run because we lack inputs.
    const canA = Boolean(firstName && workingDomain);
    const canC1 = Boolean(firstName && lastName && probedDomains.length > 0);
    const canC2 = Boolean(lastName && workingDomain);
    const canC3 = Boolean(firstName && workingDomain);
    const canC4 = Boolean(firstName && company);

    // Strategy A replay: sanity check that A still misses with the
    // engine's current params. If A unexpectedly hits, we know icypeas
    // has indexed something new since the original run.
    const aPromise: Promise<StrategyResult> = canA
      ? findEmail({ firstName, lastName: lastName || undefined, domainOrCompany: workingDomain })
          .then(r => ({ email: r.email, status: r.status }))
          .catch(err => ({ email: null, status: `error:${(err as Error).message?.slice(0, 60)}` }))
      : Promise.resolve({ email: null, status: 'skipped:no_inputs' });

    // C1: try each MX-valid TLD in parallel; first hit wins; record all.
    const c1Promise: Promise<StrategyResult> = canC1
      ? Promise.all(probedDomains.map(async d => {
          try {
            const r = await findEmail({ firstName, lastName, domainOrCompany: d });
            return { domain: d, email: r.email, status: r.status };
          } catch (err) {
            return { domain: d, email: null, status: `error:${(err as Error).message?.slice(0, 60)}` };
          }
        })).then(arr => {
          const hit = arr.find(x => x.email);
          return {
            email: hit?.email ?? null,
            status: arr.map(x => `${x.status}@${x.domain}`).join(' / '),
            domains_tried: probedDomains,
          };
        })
      : Promise.resolve({ email: null, status: 'skipped:no_lastname_or_no_domain' });

    const c2Promise: Promise<StrategyResult> = canC2
      ? findEmail({ firstName: '', lastName, domainOrCompany: workingDomain })
          .then(r => ({ email: r.email, status: r.status }))
          .catch(err => ({ email: null, status: `error:${(err as Error).message?.slice(0, 60)}` }))
      : Promise.resolve({ email: null, status: 'skipped:no_inputs' });

    const c3Promise: Promise<StrategyResult> = canC3
      ? findEmail({ firstName, lastName: '', domainOrCompany: workingDomain })
          .then(r => ({ email: r.email, status: r.status }))
          .catch(err => ({ email: null, status: `error:${(err as Error).message?.slice(0, 60)}` }))
      : Promise.resolve({ email: null, status: 'skipped:no_inputs' });

    const c4Promise: Promise<StrategyResult> = canC4
      ? findEmail({ firstName, lastName: lastName || undefined, domainOrCompany: company })
          .then(r => ({ email: r.email, status: r.status }))
          .catch(err => ({ email: null, status: `error:${(err as Error).message?.slice(0, 60)}` }))
      : Promise.resolve({ email: null, status: 'skipped:no_inputs' });

    const [aRes, c1Res, c2Res, c3Res, c4Res] = await Promise.all([
      aPromise, c1Promise, c2Promise, c3Promise, c4Promise,
    ]);

    return {
      row_index: row.row_index,
      first_name: row.first_name,
      full_name: row.full_name,
      company: row.company,
      csv_domain: row.domain,
      probed_domains: probedDomains,
      results: {
        A_replay: aRes,
        C1_multi_tld: c1Res,
        C2_lastname: c2Res,
        C3_firstname: c3Res,
        C4_company: c4Res,
      },
    };
  }));

  // Tally per-strategy outcomes.
  const STRATEGIES = ['A_replay', 'C1_multi_tld', 'C2_lastname', 'C3_firstname', 'C4_company'] as const;
  const per_strategy_wins: Record<string, number> = {};
  const per_strategy_unique_wins: Record<string, number> = {};
  for (const s of STRATEGIES) {
    per_strategy_wins[s] = reports.filter(r => r.results[s].email).length;
    // Unique = won when A_replay (current strategy in engine) didn't.
    per_strategy_unique_wins[s] = reports.filter(r =>
      r.results[s].email && !r.results.A_replay.email
    ).length;
  }

  // Cost estimate: sum of DEBITED across all strategies × $0.01. FOUND is
  // typically free (cached); we assume only DEBITED charges.
  const cost_estimate_usd = reports.reduce((sum, r) => {
    let n = 0;
    for (const s of STRATEGIES) {
      const status = r.results[s].status;
      n += (status.match(/DEBITED/g) ?? []).length;
    }
    return sum + n * 0.01;
  }, 0);

  return NextResponse.json({
    job_id: jobId,
    n_tested: reports.length,
    cost_estimate_usd: Math.round(cost_estimate_usd * 100) / 100,
    per_strategy_wins,
    per_strategy_unique_wins,
    summary: {
      A_still_misses: reports.filter(r => !r.results.A_replay.email).length,
      any_new_strategy_recovers: reports.filter(r =>
        !r.results.A_replay.email && (
          r.results.C1_multi_tld.email ||
          r.results.C2_lastname.email ||
          r.results.C3_firstname.email ||
          r.results.C4_company.email
        )
      ).length,
    },
    rows: reports,
  });
}
