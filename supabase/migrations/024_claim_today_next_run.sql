-- Phase 17 PR 4: extend email_send_claim_today RPC to also denormalize
-- next_run_at into email_send_schedule. Caller computes the value via
-- the TypeScript computeNextRunAt() (which has DST-correct PT logic)
-- and passes it as a parameter — keeps SQL ignorant of timezone math.
--
-- C11 + C12 fix: the skip-flag path now updates next_run_at alongside
-- last_run_at, so the admin UI's "next run" display stays fresh even
-- when a day is skipped.

CREATE OR REPLACE FUNCTION public.email_send_claim_today(
  p_idempotency_key TEXT,
  p_now             TIMESTAMPTZ,
  p_next_run_at     TIMESTAMPTZ DEFAULT NULL
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

  IF NOT v_schedule.enabled THEN
    RETURN jsonb_build_object('outcome', 'disabled', 'campaign_id', NULL, 'send_mode', v_schedule.send_mode);
  END IF;

  IF v_schedule.skip_next_run THEN
    INSERT INTO email_send_campaigns (idempotency_key, scheduled_for, status, send_mode)
      VALUES (p_idempotency_key, p_now, 'skipped', v_schedule.send_mode)
      ON CONFLICT (idempotency_key) DO NOTHING;
    UPDATE email_send_schedule
      SET skip_next_run = false,
          last_run_at = p_now,
          next_run_at = p_next_run_at
      WHERE id = 1;
    RETURN jsonb_build_object('outcome', 'skipped', 'campaign_id', NULL, 'send_mode', v_schedule.send_mode);
  END IF;

  SELECT COUNT(*) INTO v_active_count FROM team_members WHERE NOT email_send_paused;
  IF v_active_count = 0 THEN
    INSERT INTO email_send_campaigns (idempotency_key, scheduled_for, status, abort_reason, send_mode)
      VALUES (p_idempotency_key, p_now, 'paused', 'all_founders_paused', v_schedule.send_mode)
      ON CONFLICT (idempotency_key) DO NOTHING;
    RETURN jsonb_build_object('outcome', 'paused', 'campaign_id', NULL, 'send_mode', v_schedule.send_mode);
  END IF;

  INSERT INTO email_send_campaigns (idempotency_key, scheduled_for, status, send_mode)
    VALUES (p_idempotency_key, p_now, 'pending', v_schedule.send_mode)
    ON CONFLICT (idempotency_key) DO NOTHING
    RETURNING id INTO v_campaign_id;

  IF v_campaign_id IS NULL THEN
    RETURN jsonb_build_object('outcome', 'idempotent_no_op', 'campaign_id', NULL, 'send_mode', v_schedule.send_mode);
  END IF;

  RETURN jsonb_build_object('outcome', 'started', 'campaign_id', v_campaign_id, 'send_mode', v_schedule.send_mode);
END;
$$;

REVOKE ALL ON FUNCTION public.email_send_claim_today(TEXT, TIMESTAMPTZ, TIMESTAMPTZ) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.email_send_claim_today(TEXT, TIMESTAMPTZ, TIMESTAMPTZ) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.email_send_claim_today(TEXT, TIMESTAMPTZ, TIMESTAMPTZ) TO service_role;
