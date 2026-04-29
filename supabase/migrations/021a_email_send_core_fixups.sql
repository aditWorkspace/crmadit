-- Phase 17 PR 1 fixup: address review feedback from migration 021.
-- Pure additive (the index) + FK behavior change (DROP + re-ADD with
-- explicit ON DELETE clauses).
--
-- SAFE because: the tables have no data yet at the time of this fixup
-- (migration 021 was applied minutes earlier in the same dev cycle).
-- Verify with SELECT * FROM table LIMIT 1 before running this on prod.
--
-- Two issues addressed:
--   1) Missing index for spec §6 step ② "rescue stuck sending" query.
--   2) FK ON DELETE behavior was inconsistent across tables — only one
--      had explicit CASCADE, the rest defaulted to RESTRICT which would
--      block routine cleanup. Each FK is now annotated explicitly.

-- ── 1) Missing index for crash-recovery sweep ─────────────────────────────
CREATE INDEX IF NOT EXISTS email_send_queue_sending_started_idx
  ON email_send_queue (sending_started_at) WHERE status = 'sending';

-- ── 2) Explicit ON DELETE behavior on every FK ────────────────────────────
-- Pattern: DROP CONSTRAINT IF EXISTS, then ADD CONSTRAINT with the
-- desired ON DELETE clause. Wrapped in DO blocks so re-running is safe.

DO $$ BEGIN
  ALTER TABLE email_send_campaigns
    DROP CONSTRAINT IF EXISTS email_send_campaigns_created_by_fkey;
  ALTER TABLE email_send_campaigns
    ADD CONSTRAINT email_send_campaigns_created_by_fkey
    FOREIGN KEY (created_by) REFERENCES team_members(id) ON DELETE SET NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE email_send_queue
    DROP CONSTRAINT IF EXISTS email_send_queue_account_id_fkey;
  ALTER TABLE email_send_queue
    ADD CONSTRAINT email_send_queue_account_id_fkey
    FOREIGN KEY (account_id) REFERENCES team_members(id) ON DELETE RESTRICT;
END $$;

DO $$ BEGIN
  ALTER TABLE email_send_queue
    DROP CONSTRAINT IF EXISTS email_send_queue_template_variant_id_fkey;
  ALTER TABLE email_send_queue
    ADD CONSTRAINT email_send_queue_template_variant_id_fkey
    FOREIGN KEY (template_variant_id) REFERENCES email_template_variants(id) ON DELETE RESTRICT;
END $$;

DO $$ BEGIN
  ALTER TABLE email_send_queue
    DROP CONSTRAINT IF EXISTS email_send_queue_priority_id_fkey;
  ALTER TABLE email_send_queue
    ADD CONSTRAINT email_send_queue_priority_id_fkey
    FOREIGN KEY (priority_id) REFERENCES email_send_priority_queue(id) ON DELETE SET NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE email_send_errors
    DROP CONSTRAINT IF EXISTS email_send_errors_campaign_id_fkey;
  ALTER TABLE email_send_errors
    ADD CONSTRAINT email_send_errors_campaign_id_fkey
    FOREIGN KEY (campaign_id) REFERENCES email_send_campaigns(id) ON DELETE SET NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE email_send_errors
    DROP CONSTRAINT IF EXISTS email_send_errors_account_id_fkey;
  ALTER TABLE email_send_errors
    ADD CONSTRAINT email_send_errors_account_id_fkey
    FOREIGN KEY (account_id) REFERENCES team_members(id) ON DELETE SET NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE email_send_errors
    DROP CONSTRAINT IF EXISTS email_send_errors_queue_row_id_fkey;
  ALTER TABLE email_send_errors
    ADD CONSTRAINT email_send_errors_queue_row_id_fkey
    FOREIGN KEY (queue_row_id) REFERENCES email_send_queue(id) ON DELETE SET NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE email_send_priority_queue
    DROP CONSTRAINT IF EXISTS fk_priority_campaign;
  ALTER TABLE email_send_priority_queue
    ADD CONSTRAINT fk_priority_campaign
    FOREIGN KEY (campaign_id) REFERENCES email_send_campaigns(id) ON DELETE SET NULL;
END $$;

-- ── Note: email_send_queue.campaign_id keeps ON DELETE CASCADE (set in 021) ──
-- This is intentional: deleting a campaign should remove its queue rows.
-- We do NOT alter it here.
