-- Multi-contact-per-lead model. A lead represents a company; lead_contacts
-- holds the people at that company we've interacted with. The legacy
-- contact_name/contact_email/contact_role columns on leads remain as a
-- denormalized "primary contact" cache so existing queries keep working.
--
-- Backfill creates one is_primary=TRUE row per existing lead. Going forward,
-- the Gmail sync upserts additional rows for every external participant on
-- a thread (CC'd, forwarded, replied-from-different-address) so that name
-- search finds the lead regardless of which person at the company you type.

CREATE TABLE IF NOT EXISTS lead_contacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  name TEXT,
  email TEXT NOT NULL,
  role TEXT,
  is_primary BOOLEAN NOT NULL DEFAULT FALSE,
  -- 'primary' | 'cc' | 'reply' | 'matcher' | 'calendar' | 'manual'
  source TEXT NOT NULL DEFAULT 'manual',
  added_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS lead_contacts_lead_email_uniq
  ON lead_contacts (lead_id, LOWER(email));

CREATE INDEX IF NOT EXISTS lead_contacts_lead_id_idx
  ON lead_contacts (lead_id);

CREATE INDEX IF NOT EXISTS lead_contacts_email_idx
  ON lead_contacts (LOWER(email));

INSERT INTO lead_contacts (lead_id, name, email, role, is_primary, source)
SELECT id, contact_name, LOWER(contact_email), contact_role, TRUE, 'primary'
FROM leads
WHERE contact_email IS NOT NULL AND contact_email <> ''
ON CONFLICT DO NOTHING;
