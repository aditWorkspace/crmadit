// Configurable via env var, fallback to original pattern
const OUTREACH_SUBJECT = process.env.OUTREACH_SUBJECT_PATTERN || 'product prioritization at';
const OUTREACH_PATTERN = new RegExp(`${OUTREACH_SUBJECT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s+(.+)`, 'i');

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
  return OUTREACH_PATTERN.test(subject);
}

export function extractCompanyFromSubject(subject: string): string | null {
  const match = subject.match(OUTREACH_PATTERN);
  if (!match) return null;
  const company = match[1].trim().replace(/[?.!,;:]+$/, '').trim();
  return company || null;
}
