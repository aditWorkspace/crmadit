-- Phase 17 PR 3: Link interactions to campaigns + variants, plus the
-- bounce-rate RPC for per-tick safety checks.
--
-- Pure additive — nullable columns + indexes + new function. No drops,
-- no narrowing alters. See spec §4.0 for the migration-split rationale
-- (this file lands with the consumer in PR 3, not front-loaded in PR 1).

-- ── 1) Link columns on existing interactions table ───────────────────────
ALTER TABLE interactions
  ADD COLUMN IF NOT EXISTS campaign_id          UUID REFERENCES email_send_campaigns(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS template_variant_id  UUID REFERENCES email_template_variants(id) ON DELETE SET NULL;

-- Partial indexes — most interactions never have a campaign_id (they're
-- replies, calls, notes, etc.), so the partial filter keeps the index
-- small while still covering the analytics queries in PR 5.
CREATE INDEX IF NOT EXISTS interactions_campaign_id_idx
  ON interactions (campaign_id) WHERE campaign_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS interactions_template_variant_id_idx
  ON interactions (template_variant_id) WHERE template_variant_id IS NOT NULL;

-- ── 2) Bounce-rate-over-last-7-days RPC ──────────────────────────────────
-- Used by safety-checks.ts checkBounceRate() before each send. Returns a
-- JSONB object: { sent: int, bounces: int, rate: numeric }
--
-- Bounce detection: a queue row in 'failed' or 'skipped' status whose
-- last_error column starts with 'hard_bounce' (matches the prefix the
-- send pipeline writes when classifying 5xx Gmail errors as hard bounces).
CREATE OR REPLACE FUNCTION public.email_send_bounce_rate_7d(p_account_id UUID)
RETURNS JSONB
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  WITH stats AS (
    SELECT
      COUNT(*) FILTER (WHERE status = 'sent')                              AS sent_count,
      COUNT(*) FILTER (WHERE status IN ('failed', 'skipped')
                         AND last_error LIKE 'hard_bounce%')               AS bounce_count
    FROM email_send_queue
    WHERE account_id = p_account_id
      AND created_at > now() - interval '7 days'
  )
  SELECT jsonb_build_object(
    'sent', sent_count,
    'bounces', bounce_count,
    'rate', CASE WHEN sent_count > 0
                 THEN bounce_count::numeric / sent_count
                 ELSE 0 END
  ) FROM stats;
$$;

REVOKE ALL ON FUNCTION public.email_send_bounce_rate_7d(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.email_send_bounce_rate_7d(UUID) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.email_send_bounce_rate_7d(UUID) TO service_role;
