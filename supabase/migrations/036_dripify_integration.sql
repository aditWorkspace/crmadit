-- Dripify integration: LinkedIn outreach webhook capture + per-lead state.
--
-- Triggered when Dripify fires a webhook (today: "After a post is liked"),
-- the webhook handler logs the raw payload here and inserts a dripify_leads
-- row. A separate cron tick resolves the email via the existing email-tool
-- pipeline and sends the dripify-audience template from Adit's Gmail.
--
-- Replies to the sent email are picked up by the existing Gmail sync flow,
-- which creates a normal `leads` row; we link the two via crm_lead_id so
-- the UI can show the LinkedIn-then-email journey on a single timeline.
--
-- Additive only — no drops/truncates/narrowing alters.

CREATE TABLE IF NOT EXISTS dripify_webhook_events (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  received_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  event_type      TEXT,
  campaign_name   TEXT,
  raw_payload     JSONB NOT NULL,
  remote_ip       TEXT,
  user_agent      TEXT,
  signature_ok    BOOLEAN NOT NULL,
  processed_at    TIMESTAMPTZ,
  dripify_lead_id UUID
);

CREATE INDEX IF NOT EXISTS idx_dwe_received_at
  ON dripify_webhook_events(received_at DESC);
CREATE INDEX IF NOT EXISTS idx_dwe_processed
  ON dripify_webhook_events(processed_at)
  WHERE processed_at IS NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'dripify_lead_status') THEN
    CREATE TYPE dripify_lead_status AS ENUM (
      'pending_enrich',
      'unresolvable',
      'email_queued',
      'sent',
      'send_failed',
      'replied',
      'skipped'
    );
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS dripify_leads (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now(),

  linkedin_url              TEXT,
  linkedin_public_id        TEXT,
  first_name                TEXT,
  last_name                 TEXT,
  full_name                 TEXT,
  headline                  TEXT,
  location                  TEXT,

  company_name              TEXT,
  company_url               TEXT,
  company_domain            TEXT,

  dripify_event_type        TEXT NOT NULL,
  dripify_campaign_name     TEXT,
  dripify_event_received_at TIMESTAMPTZ NOT NULL,

  status                    dripify_lead_status NOT NULL DEFAULT 'pending_enrich',
  resolved_email            TEXT,
  enrich_outcome            JSONB,
  enrich_attempts           INT NOT NULL DEFAULT 0,
  last_attempt_at           TIMESTAMPTZ,
  last_error                TEXT,

  sent_at                   TIMESTAMPTZ,
  gmail_message_id          TEXT,
  gmail_thread_id           TEXT,
  rendered_subject          TEXT,
  rendered_body             TEXT,
  assigned_to               UUID REFERENCES team_members(id),

  replied_at                TIMESTAMPTZ,
  crm_lead_id               UUID REFERENCES leads(id),

  raw_webhook_payload       JSONB
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_dripify_leads_linkedin_url
  ON dripify_leads(linkedin_url) WHERE linkedin_url IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_dripify_leads_status_attempt
  ON dripify_leads(status, last_attempt_at NULLS FIRST)
  WHERE status IN ('pending_enrich', 'email_queued');
CREATE INDEX IF NOT EXISTS idx_dripify_leads_thread
  ON dripify_leads(gmail_thread_id) WHERE gmail_thread_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_dripify_leads_created_at
  ON dripify_leads(created_at DESC);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_dwe_lead'
  ) THEN
    ALTER TABLE dripify_webhook_events
      ADD CONSTRAINT fk_dwe_lead
      FOREIGN KEY (dripify_lead_id)
      REFERENCES dripify_leads(id) ON DELETE SET NULL;
  END IF;
END $$;
