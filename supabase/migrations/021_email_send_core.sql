-- Phase 17: Automated cold-outreach pipeline (core scaffolding).
-- Pure additive — no destructive operations. See spec §4 for full design.
--
-- Tables created:
--   email_send_campaigns       — per-day campaign run record
--   email_template_variants    — per-founder template library (≥2 active required)
--   email_send_priority_queue  — admin-uploaded priority rows
--   email_send_queue           — individual send slots (jittered)
--   email_send_schedule        — singleton row holding weekday-only schedule state
--   email_send_errors          — observability table for crash counting
--
-- Columns added to existing tables:
--   team_members.email_send_paused           — per-account pause flag
--   team_members.email_send_paused_reason    — human-readable reason
--   team_members.email_send_paused_at        — timestamp of last pause
--   email_blacklist.source                   — nullable tag for dry-run cleanup
--
-- Migration order matters (FK dependencies):
--   1) email_send_campaigns (no FKs out)
--   2) email_template_variants (FK: team_members)
--   3) email_send_priority_queue (campaign_id FK added later)
--   4) email_send_queue (FKs: campaigns, team_members, variants, priority_queue)
--   5) email_send_schedule (no FKs)
--   6) email_send_errors (FKs: campaigns, team_members, queue)
--   7) ALTER email_send_priority_queue add cross-table FK to campaigns
--   8) ALTER team_members add new columns
--   9) ALTER email_blacklist add source column

-- ── 1) Campaigns ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS email_send_campaigns (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key TEXT NOT NULL,
  scheduled_for   TIMESTAMPTZ NOT NULL,
  started_at      TIMESTAMPTZ,
  completed_at    TIMESTAMPTZ,
  status          TEXT NOT NULL DEFAULT 'pending',
  total_picked    INT NOT NULL DEFAULT 0,
  total_sent      INT NOT NULL DEFAULT 0,
  total_failed    INT NOT NULL DEFAULT 0,
  total_skipped   INT NOT NULL DEFAULT 0,
  abort_reason    TEXT,
  warmup_day      INT,
  send_mode       TEXT NOT NULL DEFAULT 'production',
  created_by      UUID REFERENCES team_members(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS email_send_campaigns_idempotency_key_uniq
  ON email_send_campaigns (idempotency_key);
CREATE INDEX IF NOT EXISTS email_send_campaigns_status_scheduled_idx
  ON email_send_campaigns (status, scheduled_for);

-- ── 2) Template variants ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS email_template_variants (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  founder_id          UUID NOT NULL REFERENCES team_members(id) ON DELETE CASCADE,
  label               TEXT NOT NULL,
  subject_template    TEXT NOT NULL,
  body_template       TEXT NOT NULL,
  is_active           BOOLEAN NOT NULL DEFAULT TRUE,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (founder_id, label)
);
CREATE INDEX IF NOT EXISTS email_template_variants_founder_active_idx
  ON email_template_variants (founder_id, is_active);

-- ── 3) Priority queue (FK to campaigns added in step 7) ───────────────────
CREATE TABLE IF NOT EXISTS email_send_priority_queue (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email               TEXT NOT NULL CHECK (email = lower(email)),
  first_name          TEXT,
  company             TEXT,
  uploaded_by         UUID NOT NULL REFERENCES team_members(id),
  uploaded_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  scheduled_for_date  DATE NOT NULL,
  notes               TEXT,
  override_blacklist  BOOLEAN NOT NULL DEFAULT FALSE,
  override_owner      UUID REFERENCES team_members(id),
  status              TEXT NOT NULL DEFAULT 'pending',
  campaign_id         UUID,
  last_error          TEXT
);
CREATE INDEX IF NOT EXISTS email_send_priority_queue_date_status_idx
  ON email_send_priority_queue (scheduled_for_date, status);
CREATE UNIQUE INDEX IF NOT EXISTS email_send_priority_queue_email_date_uniq
  ON email_send_priority_queue (email, scheduled_for_date)
  WHERE status IN ('pending', 'scheduled');

-- ── 4) Send queue ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS email_send_queue (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id         UUID NOT NULL REFERENCES email_send_campaigns(id) ON DELETE CASCADE,
  account_id          UUID NOT NULL REFERENCES team_members(id),
  recipient_email     TEXT NOT NULL CHECK (recipient_email = lower(recipient_email)),
  recipient_name      TEXT,
  recipient_company   TEXT,
  template_variant_id UUID NOT NULL REFERENCES email_template_variants(id),
  send_at             TIMESTAMPTZ NOT NULL,
  status              TEXT NOT NULL DEFAULT 'pending',
  attempts            INT NOT NULL DEFAULT 0,
  last_error          TEXT,
  sending_started_at  TIMESTAMPTZ,
  sent_at             TIMESTAMPTZ,
  gmail_message_id    TEXT,
  source              TEXT NOT NULL DEFAULT 'pool',
  priority_id         UUID REFERENCES email_send_priority_queue(id),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (campaign_id, recipient_email)
);
CREATE INDEX IF NOT EXISTS email_send_queue_status_send_at_idx
  ON email_send_queue (status, send_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS email_send_queue_account_sent_idx
  ON email_send_queue (account_id, sent_at);
CREATE INDEX IF NOT EXISTS email_send_queue_campaign_status_idx
  ON email_send_queue (campaign_id, status);

-- ── 5) Schedule singleton ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS email_send_schedule (
  id                          INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  enabled                     BOOLEAN NOT NULL DEFAULT FALSE,
  send_mode                   TEXT NOT NULL DEFAULT 'production',
  warmup_started_on           DATE,
  warmup_day_completed        INT NOT NULL DEFAULT 0,
  skip_next_run               BOOLEAN NOT NULL DEFAULT FALSE,
  last_run_at                 TIMESTAMPTZ,
  next_run_at                 TIMESTAMPTZ,
  crashes_counter_reset_at    TIMESTAMPTZ,
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO email_send_schedule (id) VALUES (1) ON CONFLICT DO NOTHING;

-- ── 6) Errors / observability ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS email_send_errors (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id     UUID REFERENCES email_send_campaigns(id),
  account_id      UUID REFERENCES team_members(id),
  queue_row_id    UUID REFERENCES email_send_queue(id),
  error_class     TEXT NOT NULL,
  error_code      TEXT,
  error_message   TEXT,
  context         JSONB,
  occurred_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS email_send_errors_occurred_class_idx
  ON email_send_errors (occurred_at, error_class);
CREATE INDEX IF NOT EXISTS email_send_errors_campaign_idx
  ON email_send_errors (campaign_id) WHERE campaign_id IS NOT NULL;

-- ── 7) Add cross-table FK on priority_queue.campaign_id ───────────────────
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_priority_campaign'
  ) THEN
    ALTER TABLE email_send_priority_queue
      ADD CONSTRAINT fk_priority_campaign
      FOREIGN KEY (campaign_id) REFERENCES email_send_campaigns(id);
  END IF;
END $$;

-- ── 8) Add columns to team_members ────────────────────────────────────────
ALTER TABLE team_members
  ADD COLUMN IF NOT EXISTS email_send_paused        BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS email_send_paused_reason TEXT,
  ADD COLUMN IF NOT EXISTS email_send_paused_at     TIMESTAMPTZ;

-- ── 9) Add source column to email_blacklist for dry-run cleanup ──────────
ALTER TABLE email_blacklist
  ADD COLUMN IF NOT EXISTS source TEXT;
