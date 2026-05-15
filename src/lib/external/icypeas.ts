// Thin wrapper for Icypeas's email-finder API (icypeas.com).
//
// Docs (SPA, hard to scrape — empirical via curl):
//   POST https://app.icypeas.com/api/email-search
//     Auth header: `Authorization: <API_KEY>` (no Bearer prefix)
//     Body: { firstname, lastname?, domainOrCompany }
//     Response: { success: true, item: { _id, status: 'NONE' } }
//
//   POST https://app.icypeas.com/api/bulk-single-searchs/read
//     Auth header: same
//     Body: { id: <search_id> }
//     Response: { success, items: [{ results: { emails: [{ email, ... }] }, status, ... }] }
//
// Status lifecycle:
//   NONE → SCRAPING → DEBITED (found) | NOT_FOUND | other terminal
//   Roughly 1-5s end-to-end at low load. We poll every 1.5s up to 30s.
//
// Pricing: ~$0.01 per `DEBITED` result. NOT_FOUND is free per docs;
// treat as "no email found, drop the row".
//
// We use the simpler key-only auth scheme (confirmed via curl
// smoke-test). The user provided ICYPEAS_API_SECRET and ICYPEAS_USER_ID
// too — those are for an HMAC-signed scheme documented at
// /next/api-auth/compute-signature/ in their SPA docs. Not needed for
// these endpoints; left as env vars in case future endpoints require it.

const ENDPOINT_SEARCH = 'https://app.icypeas.com/api/email-search';
const ENDPOINT_READ = 'https://app.icypeas.com/api/bulk-single-searchs/read';

const POLL_INTERVAL_MS = 1_500;
const POLL_TIMEOUT_MS = 30_000;
const REQUEST_TIMEOUT_MS = 15_000;

export interface FindEmailArgs {
  firstName: string;
  lastName?: string;
  /** Either a bare domain ("acme.com") or a company name ("Acme Inc"). */
  domainOrCompany: string;
}

export interface FindEmailResult {
  email: string | null;
  /** Status string from Icypeas: 'DEBITED', 'NOT_FOUND', or a timeout/error tag. */
  status: string;
  searchId?: string;
}

interface SearchPostResponse {
  success: boolean;
  item?: { _id: string; status: string };
  message?: string;
}

interface ReadResponse {
  success: boolean;
  items?: Array<{
    _id: string;
    status: string;
    results?: {
      emails?: Array<{ email: string; certainty?: string }>;
    };
  }>;
}

function authHeader(): string {
  const key = process.env.ICYPEAS_API_KEY;
  if (!key) throw new Error('ICYPEAS_API_KEY env var missing');
  return key;
}

async function fetchWithTimeout(url: string, init: RequestInit, ms: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Kick off an email search, then poll until terminal status. Returns
 * the first found email (or null on NOT_FOUND / timeout). Caller
 * should treat timeout and NOT_FOUND identically (drop the row).
 */
export async function findEmail(args: FindEmailArgs): Promise<FindEmailResult> {
  const auth = authHeader();

  // 1) Submit the search.
  const submitRes = await fetchWithTimeout(
    ENDPOINT_SEARCH,
    {
      method: 'POST',
      headers: { 'Authorization': auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        firstname: args.firstName,
        lastname: args.lastName ?? '',
        domainOrCompany: args.domainOrCompany,
      }),
    },
    REQUEST_TIMEOUT_MS,
  );
  if (!submitRes.ok) {
    const txt = await submitRes.text().catch(() => '');
    throw new Error(`icypeas submit http_${submitRes.status}: ${txt.slice(0, 200)}`);
  }
  const submitData = (await submitRes.json()) as SearchPostResponse;
  if (!submitData.success || !submitData.item?._id) {
    throw new Error(`icypeas submit no_id: ${JSON.stringify(submitData).slice(0, 200)}`);
  }
  const searchId = submitData.item._id;

  // 2) Poll for terminal status. Backoff stays at fixed 1.5s (Icypeas
  //    is fast — usually done within 5s).
  const deadlineMs = Date.now() + POLL_TIMEOUT_MS;
  while (Date.now() < deadlineMs) {
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
    const readRes = await fetchWithTimeout(
      ENDPOINT_READ,
      {
        method: 'POST',
        headers: { 'Authorization': auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: searchId }),
      },
      REQUEST_TIMEOUT_MS,
    );
    if (!readRes.ok) {
      // Transient read failure; keep polling, don't bail.
      continue;
    }
    const readData = (await readRes.json()) as ReadResponse;
    const item = readData.items?.[0];
    if (!item) continue;
    const status = item.status;
    if (status === 'NONE' || status === 'SCRAPING' || status === 'IN_PROGRESS') {
      continue; // not done yet
    }
    // Terminal.
    const firstEmail = item.results?.emails?.[0]?.email ?? null;
    return { email: firstEmail, status, searchId };
  }

  return { email: null, status: 'POLL_TIMEOUT', searchId };
}
