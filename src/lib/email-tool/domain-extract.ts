// Robust URL → bare domain extraction for the enrich-upload flow.
//
// Handles all of:
//   "https://archil.com/"           → "archil.com"
//   "https://www.arcimus.com/"      → "arcimus.com"
//   "http://www.tara.ai/"           → "tara.ai"
//   "http://epic-aerospace.com/"    → "epic-aerospace.com"
//   "grey.co/"                      → "grey.co"
//   "marsauto.com"                  → "marsauto.com"
//   "Acme Inc."                     → null  (caller falls through to icypeas)
//   "Some Company (B2B)"            → null
//
// A "company name" returns null. Only inputs that look like a hostname
// (contain a dot and only valid hostname chars) get a non-null result.

const VALID_HOST_RE = /^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/i;

export function extractDomain(input: string | null | undefined): string | null {
  if (!input) return null;
  let s = input.trim();
  if (!s) return null;

  // Strip scheme.
  s = s.replace(/^https?:\/\//i, '');

  // Strip leading "www." (case-insensitive). Some pitchbook exports have
  // it, others don't.
  s = s.replace(/^www\./i, '');

  // Drop anything from the first slash, question mark, or hash.
  s = s.split(/[/?#]/, 1)[0];

  // Drop port if present.
  s = s.split(':', 1)[0];

  s = s.toLowerCase().trim();
  if (!s) return null;

  // Hostnames need at least one dot AND only hostname-legal chars.
  // Company names like "Acme Inc" fail this and return null.
  if (!VALID_HOST_RE.test(s)) return null;

  return s;
}

/**
 * Build a `<first_name>@<domain>` guess. Returns null if first_name
 * normalizes to <2 chars (likely junk) or if domain is missing.
 *
 * Lowercases and strips accents + non-[a-z0-9] from first_name so
 * "José" → "jose", "Hans-Peter" → "hanspeter", "Mary Anne" → "maryanne".
 */
export function guessEmail(firstName: string | null | undefined, domain: string | null | undefined): string | null {
  if (!domain) return null;
  const fn = (firstName ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // strip combining diacritics
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
  if (fn.length < 2) return null;
  return `${fn}@${domain}`;
}
