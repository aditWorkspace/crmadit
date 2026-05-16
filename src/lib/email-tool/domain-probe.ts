// Domain probe: when a CSV row has a company name but no domain
// extractable (e.g. "Indemni", "GetCrux"), try common TLDs and see
// which ones have MX records — those are real working domains. We
// then run our existing BEC email-guessing against the discovered
// domain instead of falling straight to the ~$0.01 Icypeas call.
//
// MX lookup is essentially free (a few hundred ms of DNS per row),
// done in parallel across TLDs, and orders-of-magnitude cheaper than
// blind Icypeas + far higher hit rate than guessing email patterns
// on a domain that might not even exist.

import { resolveMx } from 'node:dns/promises';

// TLDs tried in priority order. First few catch >80% of cases on a
// single try; the long tail (.dev / .xyz / etc) was added 2026-05-16
// after observing that YC companies like "Million" use .dev domains
// that our 7-TLD list missed. DNS is essentially free (parallel
// lookups, ~50ms each), so a longer list mostly costs initialization
// time and pays for itself any time a row otherwise would have fallen
// to a $0.01 Icypeas call.
const PROBE_TLDS = [
  'com', 'ai', 'io', 'co', 'so', 'app', 'tech',  // existing common
  'dev', 'xyz', 'gg', 'one', 'fm', 'org', 'ml',  // YC-common newer TLDs
  'sh', 'run', 'page', 'ventures', 'fund', 'cloud', // edge cases
] as const;

// Companies whose names contain non-alphanumeric junk shouldn't be
// probed — they'd produce invalid domain strings. Strip to lowercase
// alphanumerics; null if nothing's left.
function normalizeCompanyForDomain(company: string | null | undefined): string | null {
  if (!company) return null;
  const stripped = company.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (stripped.length < 2) return null;
  return stripped;
}

async function hasMx(domain: string): Promise<boolean> {
  try {
    const records = await resolveMx(domain);
    return Array.isArray(records) && records.length > 0;
  } catch {
    return false; // ENOTFOUND / ENODATA / etc. — domain has no mail server
  }
}

/**
 * Probe common TLDs in parallel for a given company name. Returns the
 * first TLD with valid MX records (highest priority winning ties), or
 * null if none of the probed domains have mail. Bounded to ~1s total
 * via Promise.all across the probe list.
 */
export async function probeDomainForCompany(company: string | null | undefined): Promise<string | null> {
  const domains = await probeAllValidDomains(company);
  return domains[0] ?? null;
}

/**
 * Like probeDomainForCompany but returns ALL TLDs with valid MX records,
 * not just the first. Used by the icypeas-experiment + multi-TLD
 * strategy to give Icypeas multiple shots at finding the email even
 * when our domain extraction would have settled on a wrong/parked TLD.
 * Returned domains preserve PROBE_TLDS priority order.
 */
export async function probeAllValidDomains(company: string | null | undefined): Promise<string[]> {
  const base = normalizeCompanyForDomain(company);
  if (!base) return [];

  const probes = PROBE_TLDS.map(async tld => {
    const candidate = `${base}.${tld}`;
    const ok = await hasMx(candidate);
    return { tld, candidate, ok };
  });

  const results = await Promise.all(probes);
  const validInPriorityOrder: string[] = [];
  for (const tld of PROBE_TLDS) {
    const hit = results.find(r => r.tld === tld && r.ok);
    if (hit) validInPriorityOrder.push(hit.candidate);
  }
  return validInPriorityOrder;
}
