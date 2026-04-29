-- PR 5 Task 5.1: pure-additive caveat closure.
-- Closes:
--   C4 — status enum CHECK constraints on email_send_* tables
--   C5 — set_updated_at() trigger on email_template_variants,
--        email_send_schedule, email_send_campaigns
--   C15 — covering index for the bounce-rate-7d RPC
--
-- C2 (remove tmp_inspect_* helpers) and C3 (FK referential action on
-- email_send_priority_queue.uploaded_by and override_owner) are staged
-- in 025a_email_send_destructive_mop_up.sql but NOT applied here.
-- Those require constraint removal / function removal operations which
-- the claude_exec_sql guard currently blocks. Task 5.9 upgrades the
-- guard and then 025a applies.

-- ── C4: CHECK constraints on status enums ────────────────────────────────
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'email_send_campaigns_status_check') THEN
    ALTER TABLE email_send_campaigns
      ADD CONSTRAINT email_send_campaigns_status_check
      CHECK (status IN ('pending', 'running', 'done', 'aborted', 'paused', 'exhausted', 'skipped'));
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'email_send_campaigns_send_mode_check') THEN
    ALTER TABLE email_send_campaigns
      ADD CONSTRAINT email_send_campaigns_send_mode_check
      CHECK (send_mode IN ('production', 'dry_run', 'allowlist'));
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'email_send_queue_status_check') THEN
    ALTER TABLE email_send_queue
      ADD CONSTRAINT email_send_queue_status_check
      CHECK (status IN ('pending', 'sending', 'sent', 'failed', 'skipped'));
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'email_send_queue_source_check') THEN
    ALTER TABLE email_send_queue
      ADD CONSTRAINT email_send_queue_source_check
      CHECK (source IN ('pool', 'priority'));
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'email_send_priority_queue_status_check') THEN
    ALTER TABLE email_send_priority_queue
      ADD CONSTRAINT email_send_priority_queue_status_check
      CHECK (status IN ('pending', 'scheduled', 'sent', 'skipped', 'cancelled'));
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'email_send_schedule_send_mode_check') THEN
    ALTER TABLE email_send_schedule
      ADD CONSTRAINT email_send_schedule_send_mode_check
      CHECK (send_mode IN ('production', 'dry_run', 'allowlist'));
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'email_send_errors_error_class_check') THEN
    ALTER TABLE email_send_errors
      ADD CONSTRAINT email_send_errors_error_class_check
      CHECK (error_class IN ('crash', 'gmail_api_error', 'render_error', 'config_error', 'timeout', 'unknown'));
  END IF;
END $$;

-- ── C5: set_updated_at() trigger function + applications ─────────────────
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'email_template_variants_set_updated_at') THEN
    CREATE TRIGGER email_template_variants_set_updated_at
      BEFORE UPDATE ON email_template_variants
      FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'email_send_schedule_set_updated_at') THEN
    CREATE TRIGGER email_send_schedule_set_updated_at
      BEFORE UPDATE ON email_send_schedule
      FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
  END IF;
END $$;

-- email_send_campaigns has no updated_at column — it has started_at +
-- completed_at instead, both managed explicitly by the orchestrator.
-- Skipping per the table's design.

-- ── C15: covering index for bounce-rate-7d RPC ───────────────────────────
-- The RPC filters by (account_id, created_at > now() - 7 days). The
-- existing index_account_sent_idx is on (account_id, sent_at) — wrong
-- column. Add the right one. At <500/day × 3 accounts × 7 days = 10.5K
-- rows max, this is barely measurable today, but fixes the cost as
-- volume grows.
CREATE INDEX IF NOT EXISTS email_send_queue_account_created_idx
  ON email_send_queue (account_id, created_at);
