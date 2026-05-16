// Multi-template email guesser. Returns 1–3 candidate addresses in
// decreasing probability order for the enrich-upload pipeline.
//
// Hit rate (empirical, from cold-outreach lead lists):
//   firstname@domain         ≈ 50%  (most common at small/mid startups)
//   finitial+lastname@domain ≈ 20%  additional (enterprise pattern)
//   firstname.lastname@domain ≈ 10% additional (formal pattern)
//   → ~80% combined; remaining 20% need Icypeas.
//
// The per-row pipeline tries candidates in order and short-circuits
// on the first BEC `passed`. Each BEC call is ~$0.001; trying all 3
// = $0.003. Still 3.3× cheaper than going straight to Icypeas ($0.01).

export interface GuessInput {
  firstName: string | null;
  /**
   * Last name. Preferred input if you have it separately. Otherwise
   * pass null and let `guessEmails` parse from `fullName`.
   */
  lastName?: string | null;
  fullName: string | null;
  domain: string | null;
}

/**
 * Normalize a name fragment for use in an email local-part:
 * lowercase, strip accents, drop everything that isn't [a-z0-9].
 *
 *   "José"        → "jose"
 *   "Hans-Peter"  → "hanspeter"
 *   "O'Brien"     → "obrien"
 */
function norm(s: string | null | undefined): string {
  return (s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // strip combining diacritics
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

/**
 * Pull a last-name guess from a full-name string. Returns "" if we
 * can't find a confident last token (single-word full names like
 * "Madonna" are skipped — no template needs them anyway).
 */
function deriveLastName(fullName: string | null): string {
  if (!fullName) return '';
  const tokens = fullName.split(/\s+/).filter(Boolean);
  if (tokens.length < 2) return '';
  // Last token. Skip suffixes like "Jr.", "III" etc.
  let last = tokens[tokens.length - 1];
  if (/^(jr|sr|i+|iv|v|ii?|iii)\.?$/i.test(last) && tokens.length >= 3) {
    last = tokens[tokens.length - 2];
  }
  return norm(last);
}

export function guessEmails(input: GuessInput): string[] {
  const domain = input.domain?.trim().toLowerCase();
  if (!domain || !domain.includes('.')) return [];

  const fn = norm(input.firstName);
  const ln = input.lastName ? norm(input.lastName) : deriveLastName(input.fullName);

  const out: string[] = [];

  // T1 — `firstname@domain` (most common).
  if (fn.length >= 2) {
    out.push(`${fn}@${domain}`);
  }

  // T2 — `f + lastname @ domain` (enterprise pattern, e.g., amittal@).
  // Skip if either part is missing.
  if (fn.length >= 1 && ln.length >= 2) {
    out.push(`${fn[0]}${ln}@${domain}`);
  }

  // T3 — `firstname.lastname @ domain` (formal pattern).
  if (fn.length >= 2 && ln.length >= 2) {
    out.push(`${fn}.${ln}@${domain}`);
  }

  // Dedupe while preserving order (rare but possible if name is one char).
  return Array.from(new Set(out));
}
