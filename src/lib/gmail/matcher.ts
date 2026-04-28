// Outreach subjects we recognize. The legacy single-pattern env override
// (OUTREACH_SUBJECT_PATTERN) still works — it just gets prepended to the
// list. We greedy-match across all patterns; first hit wins.
//
// Two phrasings are in use as of 2026-04-27:
//   "product prioritization at <Company>"
//   "customer feedback workflows at <Company>"  (also: "workflow at")
const OUTREACH_PATTERNS: RegExp[] = [
  ...(process.env.OUTREACH_SUBJECT_PATTERN
    ? [new RegExp(`${process.env.OUTREACH_SUBJECT_PATTERN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s+(.+)`, 'i')]
    : []),
  /product prioritization at\s+(.+)/i,
  /customer feedback workflows? at\s+(.+)/i,
];

// NDR/bounce/auto-reply subject prefixes — delivery failure notifications and
// mail-client autoresponders, not real human replies. Matching here prevents
// the thread from being treated as a prospect reply at sync time.
const BOUNCE_PREFIXES = [
  /^undeliverable:\s/i,
  /^delivery (has )?failed:\s/i,
  /^mail delivery failed/i,
  /^returned mail:\s/i,
  /^failure notice\b/i,
  /^delivery status notification\b/i,
  /^message not delivered/i,
  /^out of office:?\s/i,
  /^out-of-office:?\s/i,
  /^automatic reply:?\s/i,
  /^auto-reply:?\s/i,
  /^autoreply:?\s/i,
  /^auto:\s/i,
  /^ooo:?\s/i,
  /^on vacation:?\s/i,
  /^on (paternity|maternity|parental) leave\b/i,
  /^away from (the|my) office\b/i,
];

export function isBounceEmail(subject: string): boolean {
  return BOUNCE_PREFIXES.some(re => re.test(subject.trim()));
}

export function isOutreachThread(subject: string): boolean {
  if (isBounceEmail(subject)) return false;
  return OUTREACH_PATTERNS.some(re => re.test(subject));
}

export function extractCompanyFromSubject(subject: string): string | null {
  for (const re of OUTREACH_PATTERNS) {
    const match = subject.match(re);
    if (!match) continue;
    const company = match[1].trim().replace(/[?.!,;:]+$/, '').trim();
    if (company) return company;
  }
  return null;
}
