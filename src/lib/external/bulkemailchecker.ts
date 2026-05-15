// Thin wrapper for bulkemailchecker.com's real-time email validation API.
//
// Plan: see /Users/adit/.claude/plans/gleaming-inventing-glacier.md
// Docs: /Users/adit/CRMMAIN/bulkemailchecker.md
//
// Pricing: 1 credit per `passed` or `failed` result (`unknown` is free).
// Rate limits on the solo tier: 1,500 req/hr, 1 concurrent thread.
// Account credit balance is included in every response (`creditsRemaining`).
//
// Use sequentially from server routes — DO NOT call in parallel from a
// single request. The solo-tier 1-thread cap will return 429 if you do.

export type BecStatus = 'passed' | 'failed' | 'unknown';

export interface BecResult {
  status: BecStatus;
  event: string;
  details?: string;
  email: string;
  emailSuggested?: string;
  isDisposable?: boolean;
  isFreeService?: boolean;
  isRoleAccount?: boolean;
  isGibberish?: boolean;
  creditsRemaining?: number;
  hourlyQuotaRemaining?: number;
}

const ENDPOINT = 'https://api.bulkemailchecker.com/real-time/';
const TIMEOUT_MS = 20_000;

/**
 * Validate a single email address. Returns the parsed response
 * verbatim. The caller decides what to do with `status` and `event`
 * (typically: `passed` → keep, anything else → fall back to Icypeas).
 *
 * Throws if the API itself is unreachable or returns non-JSON; the
 * caller should catch and treat as "unknown" (don't credit-burn on
 * transient network errors).
 */
export async function verifyEmail(email: string): Promise<BecResult> {
  const apiKey = process.env.BULKEMAILCHECKER_API_KEY;
  if (!apiKey) throw new Error('BULKEMAILCHECKER_API_KEY env var missing');

  const url = `${ENDPOINT}?key=${encodeURIComponent(apiKey)}&email=${encodeURIComponent(email)}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    throw new Error(`bulkemailchecker http_${res.status}: ${await res.text().catch(() => '')}`);
  }
  const data = (await res.json()) as BecResult;
  return data;
}
