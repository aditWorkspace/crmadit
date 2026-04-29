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

-- ── 3) email_send_claim_today — atomic campaign claim + skip-flag handling ─
-- Wraps the §5 Transaction 1 into a SECURITY DEFINER PL/pgSQL function so
-- the JS caller can perform the SELECT FOR UPDATE + skip-flag read/clear +
-- INSERT-with-ON-CONFLICT atomically. Without this, racing /start
-- invocations could double-create a campaign for the same date.
--
-- Returns a JSONB describing the outcome:
--   { outcome: 'started',          campaign_id: <uuid>, send_mode: <text> }
--   { outcome: 'skipped',          campaign_id: null,    send_mode: <text> }
--   { outcome: 'idempotent_no_op', campaign_id: null,    send_mode: <text> }
--   { outcome: 'paused',           campaign_id: null,    send_mode: <text> }
--   { outcome: 'disabled',         campaign_id: null,    send_mode: <text> }
CREATE OR REPLACE FUNCTION public.email_send_claim_today(
  p_idempotency_key TEXT,
  p_now             TIMESTAMPTZ
)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_schedule       email_send_schedule;
  v_campaign_id    UUID;
  v_active_count   INT;
BEGIN
  SELECT * INTO v_schedule FROM email_send_schedule WHERE id = 1 FOR UPDATE;

  -- Schedule disabled — exit early
  IF NOT v_schedule.enabled THEN
    RETURN jsonb_build_object(
      'outcome', 'disabled',
      'campaign_id', NULL,
      'send_mode', v_schedule.send_mode
    );
  END IF;

  -- Skip-flag handling: record an audit-trail 'skipped' campaign and clear flag
  IF v_schedule.skip_next_run THEN
    INSERT INTO email_send_campaigns (idempotency_key, scheduled_for, status, send_mode)
      VALUES (p_idempotency_key, p_now, 'skipped', v_schedule.send_mode)
      ON CONFLICT (idempotency_key) DO NOTHING;
    UPDATE email_send_schedule
      SET skip_next_run = false, last_run_at = p_now
      WHERE id = 1;
    RETURN jsonb_build_object(
      'outcome', 'skipped',
      'campaign_id', NULL,
      'send_mode', v_schedule.send_mode
    );
  END IF;

  -- All founders paused — exit
  SELECT COUNT(*) INTO v_active_count FROM team_members WHERE NOT email_send_paused;
  IF v_active_count = 0 THEN
    INSERT INTO email_send_campaigns (idempotency_key, scheduled_for, status, abort_reason, send_mode)
      VALUES (p_idempotency_key, p_now, 'paused', 'all_founders_paused', v_schedule.send_mode)
      ON CONFLICT (idempotency_key) DO NOTHING;
    RETURN jsonb_build_object(
      'outcome', 'paused',
      'campaign_id', NULL,
      'send_mode', v_schedule.send_mode
    );
  END IF;

  -- Claim today's campaign
  INSERT INTO email_send_campaigns (idempotency_key, scheduled_for, status, send_mode)
    VALUES (p_idempotency_key, p_now, 'pending', v_schedule.send_mode)
    ON CONFLICT (idempotency_key) DO NOTHING
    RETURNING id INTO v_campaign_id;

  IF v_campaign_id IS NULL THEN
    -- Another invocation already claimed — idempotent no-op
    RETURN jsonb_build_object(
      'outcome', 'idempotent_no_op',
      'campaign_id', NULL,
      'send_mode', v_schedule.send_mode
    );
  END IF;

  RETURN jsonb_build_object(
    'outcome', 'started',
    'campaign_id', v_campaign_id,
    'send_mode', v_schedule.send_mode
  );
END;
$$;

REVOKE ALL ON FUNCTION public.email_send_claim_today(TEXT, TIMESTAMPTZ) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.email_send_claim_today(TEXT, TIMESTAMPTZ) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.email_send_claim_today(TEXT, TIMESTAMPTZ) TO service_role;

-- ── 4) email_send_pool_claim_batch — atomic blacklist + pointer-advance ───
-- Called by runDailyStart after email_tool_pick_batch returns the rows.
-- Inserts the picked emails into email_blacklist with source tag so the
-- domain-dedup rollback can identify and undo only its own inserts.
-- Advances email_pool_state.next_sequence past the picked rows so the
-- next campaign won't re-pick them.
--
-- Shape:
--   p_picked_emails : TEXT[]  (lowercased, from email_tool_pick_batch)
--   p_max_sequence  : INT     (max sequence from the picked rows)
--   p_campaign_id   : UUID    (for the source tag — 'pool:<campaign_id>')
-- Returns:
--   { blacklisted: INT, fresh_remaining: INT, new_next_sequence: INT }
CREATE OR REPLACE FUNCTION public.email_send_pool_claim_batch(
  p_picked_emails TEXT[],
  p_max_sequence  INT,
  p_campaign_id   UUID
)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_inserted_count   INT;
  v_new_next_seq     INT;
  v_fresh_count      INT;
  v_source_tag       TEXT;
BEGIN
  v_source_tag := 'pool:' || p_campaign_id::text;
  v_new_next_seq := p_max_sequence + 1;

  -- Atomic blacklist insert with source tag
  WITH inserted AS (
    INSERT INTO email_blacklist (email, source)
    SELECT lower(e), v_source_tag FROM unnest(p_picked_emails) e
    ON CONFLICT (email) DO NOTHING
    RETURNING email
  )
  SELECT COUNT(*) INTO v_inserted_count FROM inserted;

  -- Recompute fresh-remaining count past the new pointer
  SELECT COUNT(*) INTO v_fresh_count
  FROM email_pool p
  WHERE p.sequence >= v_new_next_seq
    AND NOT EXISTS (SELECT 1 FROM email_blacklist b WHERE b.email = p.email);

  -- Advance pointer + cache fields
  UPDATE email_pool_state
  SET next_sequence       = v_new_next_seq,
      eff_remaining_seq   = v_new_next_seq,
      eff_remaining_fresh = v_fresh_count,
      eff_updated_at      = now()
  WHERE id = 1;

  RETURN jsonb_build_object(
    'blacklisted',       v_inserted_count,
    'fresh_remaining',   v_fresh_count,
    'new_next_sequence', v_new_next_seq
  );
END;
$$;

REVOKE ALL ON FUNCTION public.email_send_pool_claim_batch(TEXT[], INT, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.email_send_pool_claim_batch(TEXT[], INT, UUID) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.email_send_pool_claim_batch(TEXT[], INT, UUID) TO service_role;
