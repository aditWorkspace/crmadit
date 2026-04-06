const OUTREACH_PATTERN = /product prioritization at\s+(.+)/i;

export function isOutreachThread(subject: string): boolean {
  return OUTREACH_PATTERN.test(subject);
}

export function extractCompanyFromSubject(subject: string): string | null {
  const match = subject.match(OUTREACH_PATTERN);
  if (!match) return null;
  return match[1].trim() || null;
}
