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

// TLDs tried in priority order. The first three (.com / .ai / .io)
// cover the vast majority of YC startups; .co / .so / .app / .tech
// catch the rest. We deliberately keep this short — every entry costs
// one DNS round trip per row when used.
const PROBE_TLDS = ['com', 'ai', 'io', 'co', 'so', 'app', 'tech'] as const;

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
 * via Promise.all across 7 DNS lookups.
 */
export async function probeDomainForCompany(company: string | null | undefined): Promise<string | null> {
  const base = normalizeCompanyForDomain(company);
  if (!base) return null;

  const probes = PROBE_TLDS.map(async tld => {
    const candidate = `${base}.${tld}`;
    const ok = await hasMx(candidate);
    return { tld, candidate, ok };
  });

  const results = await Promise.all(probes);
  // Honor PROBE_TLDS order (first match wins) rather than racing — gives
  // a stable, deterministic outcome.
  for (const tld of PROBE_TLDS) {
    const hit = results.find(r => r.tld === tld && r.ok);
    if (hit) return hit.candidate;
  }
  return null;
}
