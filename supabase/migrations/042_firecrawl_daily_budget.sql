-- ── Firecrawl daily credit ledger ──────────────────────────────────────────
-- Caps paid Firecrawl scrapes per UTC day (FIRECRAWL_DAILY_CREDIT_CAP, default
-- 700) so the monthly key is never drained in a runaway loop. Enforced in code
-- at the scrapeUrl() choke point via firecrawl_consume() below; over-cap scrapes
-- fall back to the free plain-fetch path. Additive only.

CREATE TABLE IF NOT EXISTS firecrawl_usage (
  day        DATE PRIMARY KEY,
  credits    INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Server-only: written exclusively by the service-role admin client. No public
-- policy (same posture as the other server-side tables).
ALTER TABLE firecrawl_usage ENABLE ROW LEVEL SECURITY;

-- Atomic check-and-consume: increments today's counter by 1 IFF it would stay
-- under p_cap, returning TRUE when the credit was granted and FALSE when the cap
-- is already reached. Single statement → no read-modify-write race across the
-- concurrent draft workers. The INSERT branch (first scrape of the day) always
-- succeeds; the ON CONFLICT UPDATE is gated by the WHERE, and when it is skipped
-- (cap hit) RETURNING yields no row, leaving v_after NULL.
CREATE OR REPLACE FUNCTION firecrawl_consume(p_day DATE, p_cap INTEGER)
RETURNS BOOLEAN
LANGUAGE plpgsql
AS $$
DECLARE
  v_after INTEGER;
BEGIN
  INSERT INTO firecrawl_usage (day, credits)
  VALUES (p_day, 1)
  ON CONFLICT (day) DO UPDATE
    SET credits = firecrawl_usage.credits + 1, updated_at = now()
    WHERE firecrawl_usage.credits < p_cap
  RETURNING credits INTO v_after;

  RETURN v_after IS NOT NULL;
END;
$$;
