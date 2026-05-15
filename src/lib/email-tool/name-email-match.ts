/**
 * Sanity-check that a recipient's first_name (and optionally full_name)
 * is plausibly the person at this email address.
 *
 * Built in response to the 2026-05-15 incident where a CSV import
 * misalignment shifted first_name/company by N rows against email,
 * causing rendered emails like:
 *
 *   To: dylan@cheers.tech
 *   Subject: pm workflow at IvyCheck
 *   Body: Hey Dustin, ...
 *
 * — a Dylan getting addressed as Dustin from a wrong company. We want
 * to NEVER ship that. User preference (verbatim): "I would rather not
 * send the email than send with wrong info."
 *
 * Strategy: the email's local-part is almost always derived from the
 * person's name (first name, last name, or first-initial+last-name).
 * We accept any of those three forms; if NONE match, the row is
 * suspicious and we drop / skip it. Role-based addresses like
 * `info@`, `founders@`, `hello@` will fail the check — that's fine,
 * those are low-value cold-outreach targets anyway.
 *
 * Returns:
 *   - ok: true if pass (legitimate-looking match OR insufficient data
 *     to validate)
 *   - ok: false otherwise, with a `reason` explaining which check
 *     fired (for logs)
 */
export interface NameMatchResult {
  ok: boolean;
  reason?: string;
}

function normalize(s: string | null | undefined): string {
  return (s ?? '').toLowerCase().replace(/[^a-z]/g, '');
}

export function looksLikeMatch(
  firstName: string | null,
  fullName: string | null,
  email: string
): NameMatchResult {
  const lp = normalize(email.split('@')[0]);
  if (lp.length < 2) {
    return { ok: true, reason: 'lp_too_short_to_check' };
  }
  const fn = normalize(firstName);
  // If no first name AND no full name, we can't validate — accept by
  // default. This is rare in practice (most leads have at least a
  // first_name), and rejecting them would block legitimate uploads.
  if (fn.length < 3 && !fullName) {
    return { ok: true, reason: 'no_name_to_check' };
  }

  const fnPrefix = fn.slice(0, 3);
  if (fn.length >= 3 && lp.startsWith(fnPrefix)) {
    return { ok: true, reason: 'fn_prefix_match' };
  }

  // Extract last-name from full_name (everything after the first token).
  const fnTokens = (fullName ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  const ln = normalize(fnTokens.slice(1).join(' '));
  if (ln.length >= 3) {
    const lnPrefix = ln.slice(0, 3);
    if (lp.startsWith(lnPrefix)) {
      return { ok: true, reason: 'ln_prefix_match' };
    }
    if (fn.length > 0 && lp.startsWith(fn[0] + lnPrefix)) {
      return { ok: true, reason: 'fi_plus_ln_prefix_match' };
    }
    // Also accept first-name + first-letter-of-last-name (e.g., "dylana" for "Dylan Allen")
    if (fn.length >= 3 && lp.startsWith(fnPrefix + ln[0])) {
      return { ok: true, reason: 'fn_prefix_plus_li_match' };
    }
  }

  return {
    ok: false,
    reason: `no_name_match(lp=${lp.slice(0, 20)},fn=${fn || '?'},ln=${ln || '?'})`,
  };
}
