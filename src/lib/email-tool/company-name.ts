// Convert whatever the CSV gave us into something that reads naturally
// inside `pm workflow at {{company}}` and `If {{company}} is feeling the
// gap…`. Handles three messy real-world inputs:
//
//   "https://elementary-data.com/"  → "Elementary Data"
//   "https://www.manara.tech/"      → "Manara"
//   "Cloudthread"                   → "Cloudthread"
//   "CheckAndRent.Com"              → "CheckAndRent"
//   "OPEN AI" / null / ""           → "OPEN AI" / null / null
//
// The 2026-05-16 outage shipped 800 emails like "pm workflow at
// http://elementary-data.com/" because the enrich pipeline's CSV column
// inferrer mapped Website→company, then passed the raw URL through to
// template substitution. Pretty-printing fixes this at write-time AND
// at backfill; sanitizeCompanyForSend() below is the belt-and-suspenders
// last-mile check.

const URL_PROTOCOL_RE = /^https?:\/\//i;
const HAS_TLD_RE = /\.[a-z]{2,}(\.[a-z]{2})?$/i;

function titleCaseToken(t: string): string {
  if (!t) return t;
  if (t.length <= 2) return t.toUpperCase();
  return t[0].toUpperCase() + t.slice(1).toLowerCase();
}

/**
 * Best-effort pretty company name. Returns null only for unrecoverable
 * input (empty / whitespace). Callers that want hard-drop semantics
 * should also check looksLikeUrl() and decide independently.
 *
 * Strategy: for URL-shaped inputs, take the FIRST dot-separated label
 * after stripping protocol, path, and the www. subdomain — that's where
 * the company name lives in 99% of real-world inputs:
 *   https://elementary-data.com/    → "elementary-data" → "Elementary Data"
 *   https://www.manara.tech/        → "manara.tech"     → "manara" → "Manara"
 *   joseph@expressbuilding.ph (host: expressbuilding.ph) → "expressbuilding"
 *   verde.agr.br                    → "verde"           (not "agr" or "br")
 *
 * The previous take-last-label logic produced "PH" / "AGR" / "BR" for
 * country-code TLDs we hadn't enumerated. First-label is robust to any
 * TLD without an explicit allow-list.
 */
export function prettifyCompanyName(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let v = raw.trim();
  if (!v) return null;

  const looksUrlish = URL_PROTOCOL_RE.test(v) || HAS_TLD_RE.test(v);
  if (!looksUrlish) return v; // already a plain name like "Cloudthread"

  // Strip protocol
  v = v.replace(URL_PROTOCOL_RE, '');
  // Strip path / query / fragment
  v = v.split(/[/?#]/, 1)[0];
  // Strip leading www.
  v = v.replace(/^www\./i, '');
  // Take the FIRST dot-separated label — that's the company.
  const parts = v.split('.');
  v = parts[0] || '';

  // Hyphen / underscore → space. TitleCase each token.
  const tokens = v.split(/[-_]+/).filter(Boolean).map(titleCaseToken);
  const result = tokens.join(' ').trim();
  return result || null;
}

/** True if a string is obviously still a URL (didn't get prettified). */
export function looksLikeUrl(raw: string | null | undefined): boolean {
  if (!raw) return false;
  const v = raw.trim();
  return URL_PROTOCOL_RE.test(v) || HAS_TLD_RE.test(v);
}

/**
 * Last-mile sanitizer used at send time. If the stored company is still
 * URL-shaped (shouldn't happen post-2026-05-16 fix, but defense in
 * depth), prettify it. Never returns null — falls back to "your team"
 * as a generic stand-in so the email isn't broken.
 */
export function sanitizeCompanyForSend(raw: string | null | undefined): string {
  const pretty = prettifyCompanyName(raw);
  if (pretty && !looksLikeUrl(pretty)) return pretty;
  return 'your team';
}
