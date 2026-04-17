/**
 * Builds a Gmail web URL that opens a specific thread in the right account.
 *
 * Gmail's public web URL format:
 *   https://mail.google.com/mail/u/<accountIndex>/#inbox/%23thread-f%3A<decimalThreadId>
 *
 * `gmail_thread_id` as returned by the Gmail API is a hex string (e.g. "1862400816206824258"
 * is the decimal form of a hex ID). The web UI expects the decimal form, URL-encoded
 * as `#thread-f:<decimal>`.
 */

// Per-user Gmail account index hints. Adit's Berkeley account is the 4th
// signed-in Google account in his browser, so links must target u/4.
// Keys can be either the founder's display name or their primary email —
// whichever the caller has handy.
const ACCOUNT_INDEX_BY_IDENTIFIER: Record<string, number> = {
  adit: 4,
  'aditmittal@berkeley.edu': 4,
};

export function gmailAccountIndex(identifier?: string | null): number {
  if (!identifier) return 0;
  return ACCOUNT_INDEX_BY_IDENTIFIER[identifier.toLowerCase().trim()] ?? 0;
}

export function hexThreadIdToDecimal(threadId: string): string | null {
  if (!threadId) return null;
  // Accept either raw hex ("1983a9d0b5e3c001") or an already-decimal string.
  // If it parses as BigInt both ways, prefer hex interpretation since Gmail
  // API IDs are always hex.
  try {
    if (/^[0-9a-f]+$/i.test(threadId)) {
      return BigInt('0x' + threadId).toString(10);
    }
    if (/^\d+$/.test(threadId)) {
      return threadId;
    }
  } catch {
    return null;
  }
  return null;
}

export function buildGmailThreadUrl(
  threadId: string | null | undefined,
  accountEmail?: string | null,
): string | null {
  if (!threadId) return null;
  const decimal = hexThreadIdToDecimal(threadId);
  if (!decimal) return null;
  const idx = gmailAccountIndex(accountEmail);
  return `https://mail.google.com/mail/u/${idx}/#inbox/${encodeURIComponent(`#thread-f:${decimal}`)}`;
}
