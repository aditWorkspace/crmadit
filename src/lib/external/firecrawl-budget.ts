// Daily Firecrawl credit ceiling. Every paid Firecrawl scrape flows through
// scrapeUrl(); this gate is called there once per scrape to atomically consume
// one credit against the day's budget (FIRECRAWL_DAILY_CREDIT_CAP). When the cap
// is reached the scrape is skipped and the caller falls back to the free plain-
// fetch path — so the monthly key can never be drained in a runaway loop.
//
// The check-and-increment is a single SQL statement (RPC `firecrawl_consume`,
// migration 042) so concurrent draft workers can't race past the cap.
//
// Fails OPEN (allows the scrape) when: running under unit tests, Supabase isn't
// configured locally, or the ledger call errors. The cap is a safety ceiling,
// not a transactional guarantee — a ledger blip must never block the pipeline.

import { createAdminClient } from '@/lib/supabase/admin';
import { FIRECRAWL_DAILY_CREDIT_CAP } from '@/lib/email-tool/cold-constants';

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD, UTC
}

/** Try to consume one Firecrawl credit against today's cap.
 *  @returns true if the scrape is allowed, false if the daily cap is reached. */
export async function consumeFirecrawlCredit(): Promise<boolean> {
  // Never touch the DB from unit tests (they mock fetch, not Supabase).
  if (process.env.VITEST || process.env.NODE_ENV === 'test') return true;
  // Not configured (e.g. local dev without the service role) → don't gate.
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY || !(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)) {
    return true;
  }
  try {
    const supabase = createAdminClient();
    const { data, error } = await supabase.rpc('firecrawl_consume', {
      p_day: todayUtc(),
      p_cap: FIRECRAWL_DAILY_CREDIT_CAP,
    });
    if (error) {
      console.warn('[firecrawl-budget] ledger rpc error, allowing scrape:', error.message);
      return true; // fail-open
    }
    if (data === false) {
      console.warn(`[firecrawl-budget] daily cap ${FIRECRAWL_DAILY_CREDIT_CAP} reached — using free fallback`);
    }
    return data !== false;
  } catch (err) {
    console.warn('[firecrawl-budget] ledger threw, allowing scrape:', err instanceof Error ? err.message : String(err));
    return true; // fail-open
  }
}
