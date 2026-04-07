const OUTREACH_PATTERN = /product prioritization at\s+(.+)/i;

// NDR/bounce subject prefixes — these are delivery failure notifications, not real replies
const BOUNCE_PREFIXES = [
  /^undeliverable:/i,
  /^delivery (has )?failed:/i,
  /^mail delivery failed/i,
  /^returned mail:/i,
  /^failure notice/i,
  /^delivery status notification/i,
  /^message not delivered/i,
  /^auto-?reply:/i,
  /^automatic reply:/i,
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
  return match[1].trim().replace(/[?.!,;]+$/, '') || null;
}
