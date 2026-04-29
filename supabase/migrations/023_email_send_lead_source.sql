-- Phase 17 PR 4: Lead source attribution.
-- Adds a column linking leads to the campaign that first created them.
-- Pure additive — nullable column + partial index, no destructive ops.
--
-- The 'outreach_sent' lead stage is added in code (TypeScript) rather than
-- as a DB CHECK — leads.stage is unconstrained TEXT today. Adding the
-- value is a no-op at the DB layer; only the application narrows it.

ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS source_campaign_id UUID REFERENCES email_send_campaigns(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS leads_source_campaign_id_idx
  ON leads (source_campaign_id) WHERE source_campaign_id IS NOT NULL;
