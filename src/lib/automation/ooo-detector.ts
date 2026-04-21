/**
 * Deterministic out-of-office / auto-responder detection.
 *
 * This runs BEFORE the AI classifier and BEFORE any scheduled auto-send.
 * We never want the AI to make a judgement call about an OOO reply — if any
 * of these high-precision patterns match, we short-circuit to manual-review
 * or delay, because the cost of a bad auto-send to someone on vacation is way
 * higher than the cost of delaying by a day.
 *
 * Patterns are intentionally conservative: only things a real person would
 * never phrase this way in a normal reply (e.g. "I am out of the office").
 */

// Subject-line prefixes that Gmail / Outlook / Exchange prepend to autoreplies.
const OOO_SUBJECT_PATTERNS: RegExp[] = [
  /^automatic reply\b/i,
  /^auto-reply\b/i,
  /^autoreply\b/i,
  /^auto:\s/i,
  /^ooo:\s/i,
  /^out of office\b/i,
  /^out-of-office\b/i,
  /^on vacation\b/i,
  /^away from (the|my) office\b/i,
  /^on (paternity|maternity|parental) leave\b/i,
];

// Body phrases that only appear in autoreplies / vacation notices. We match
// against the FIRST 1000 characters of the body so a stray "out of office"
// buried under a signature of a normal reply doesn't trip us.
const OOO_BODY_PATTERNS: RegExp[] = [
  /\bi am (currently )?out of (the )?office\b/i,
  /\bi'?m (currently )?out of (the )?office\b/i,
  /\bi will be out of (the )?office\b/i,
  /\bi'?ll be out of (the )?office\b/i,
  /\baway from (the|my) office\b/i,
  /\bon (paternity|maternity|parental) leave\b/i,
  /\bi am on vacation\b/i,
  /\bi'?m on vacation\b/i,
  /\bi am (currently )?traveling and\b/i,
  /\bi'?ll be back (in the office )?on\b/i,
  /\bi will be back (in the office )?on\b/i,
  /\bi (will )?return(ing)? to (the )?office on\b/i,
  /\bi (will )?return(ing)? on\b/i,
  /\blimited access to (my )?e-?mail\b/i,
  /\bno access to (my )?e-?mail\b/i,
  /\bthis is an automatic(ally generated)? (reply|response|message)\b/i,
  /\bplease (note|be advised) that i am\b.*\b(out|away|unavailable)\b/i,
  /\bi am (currently )?unavailable until\b/i,
  /\bfor urgent (matters|issues|requests)[,.]? please (contact|reach out to)\b/i,
];

export interface OooDetection {
  /** True if any of the subject or body signals fired. */
  isOoo: boolean;
  /** First signal that matched (for logging / manual review reasons). */
  reason: string | null;
  /** If we can parse "back on <date>", an ISO YYYY-MM-DD date to schedule follow-up. */
  returnDate: string | null;
}

/**
 * Conservative OOO detection over subject + body. Returns both "is OOO" and
 * an optional return date so the caller can schedule a later recontact.
 */
export function detectOutOfOffice(
  subject: string | null | undefined,
  body: string | null | undefined
): OooDetection {
  const s = (subject || '').trim();
  const b = (body || '').slice(0, 1000);

  for (const re of OOO_SUBJECT_PATTERNS) {
    if (re.test(s)) {
      return {
        isOoo: true,
        reason: `subject_match:${re.source}`,
        returnDate: extractReturnDate(b),
      };
    }
  }

  for (const re of OOO_BODY_PATTERNS) {
    if (re.test(b)) {
      return {
        isOoo: true,
        reason: `body_match:${re.source}`,
        returnDate: extractReturnDate(b),
      };
    }
  }

  return { isOoo: false, reason: null, returnDate: null };
}

// Extract a YYYY-MM-DD follow-up date from a body containing "back on …" /
// "return on …" phrases. Falls back to null if we can't parse confidently —
// in that case the caller uses a default (e.g. 7 days from now).
function extractReturnDate(body: string): string | null {
  const now = new Date();
  const currentYear = now.getUTCFullYear();

  // Match: "back on January 15" / "return on Feb 3" / "back on 1/15"
  const monthNames = [
    'january', 'february', 'march', 'april', 'may', 'june',
    'july', 'august', 'september', 'october', 'november', 'december',
  ];
  const monthAbbrev = monthNames.map(m => m.slice(0, 3));

  // "back on <MonthName> <day>" or "return(ing) on <MonthName> <day>"
  const monthDayRe = new RegExp(
    `(?:back|return|returning)\\s+(?:on|by)?\\s*(${monthNames.join('|')}|${monthAbbrev.join('|')})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?`,
    'i'
  );
  const mMatch = body.match(monthDayRe);
  if (mMatch) {
    const monthToken = mMatch[1].toLowerCase();
    const monthIdx =
      monthNames.indexOf(monthToken) !== -1
        ? monthNames.indexOf(monthToken)
        : monthAbbrev.indexOf(monthToken);
    const day = parseInt(mMatch[2], 10);
    if (monthIdx >= 0 && day >= 1 && day <= 31) {
      // If that date has already passed this year, roll over to next year.
      let year = currentYear;
      const candidate = new Date(Date.UTC(year, monthIdx, day));
      if (candidate.getTime() < now.getTime() - 24 * 60 * 60 * 1000) {
        year += 1;
      }
      const iso = new Date(Date.UTC(year, monthIdx, day))
        .toISOString()
        .split('T')[0];
      return iso;
    }
  }

  // "back on 1/15" or "return on 01/15/2026"
  const numericRe = /(?:back|return|returning)\s+(?:on|by)?\s*(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2,4}))?/i;
  const nMatch = body.match(numericRe);
  if (nMatch) {
    const month = parseInt(nMatch[1], 10);
    const day = parseInt(nMatch[2], 10);
    let year = nMatch[3] ? parseInt(nMatch[3], 10) : currentYear;
    if (year < 100) year += 2000;
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      const iso = new Date(Date.UTC(year, month - 1, day))
        .toISOString()
        .split('T')[0];
      return iso;
    }
  }

  return null;
}
