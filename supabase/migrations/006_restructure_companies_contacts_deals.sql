-- Phase 5: Split monolithic leads table into companies, contacts, deals
-- This migration is additive — the existing leads table is NOT dropped.
-- A backward-compatible view (leads_v) provides the old shape for gradual migration.

-- ── Companies ─────────────────────────────────────────────────────────────────
CREATE TABLE companies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  domain TEXT,
  url TEXT,
  stage TEXT,
  size TEXT,
  industry TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX idx_companies_domain ON companies(domain) WHERE domain IS NOT NULL;
CREATE INDEX idx_companies_name ON companies(name);

-- ── Contacts ──────────────────────────────────────────────────────────────────
CREATE TABLE contacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID REFERENCES companies(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  role TEXT,
  linkedin TEXT,
  phone TEXT,
  is_primary BOOLEAN NOT NULL DEFAULT true,
  tags TEXT[] DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX idx_contacts_email ON contacts(email);
CREATE INDEX idx_contacts_company ON contacts(company_id);

-- ── Deals ─────────────────────────────────────────────────────────────────────
CREATE TABLE deals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id UUID REFERENCES contacts(id) ON DELETE SET NULL,
  company_id UUID REFERENCES companies(id) ON DELETE SET NULL,
  sourced_by UUID REFERENCES team_members(id) NOT NULL,
  owned_by UUID REFERENCES team_members(id) NOT NULL,
  call_participants UUID[] DEFAULT '{}',

  -- Pipeline
  stage lead_stage DEFAULT 'replied',
  priority TEXT DEFAULT 'medium' CHECK (priority IN ('critical', 'high', 'medium', 'low')),

  -- Timestamps
  first_reply_at TIMESTAMPTZ,
  our_first_response_at TIMESTAMPTZ,
  call_scheduled_for TIMESTAMPTZ,
  call_completed_at TIMESTAMPTZ,
  demo_sent_at TIMESTAMPTZ,
  product_access_granted_at TIMESTAMPTZ,
  last_contact_at TIMESTAMPTZ,
  next_followup_at TIMESTAMPTZ,

  -- Speed metrics
  time_to_our_response_hrs NUMERIC,
  time_to_schedule_hrs NUMERIC,
  time_to_call_hrs NUMERIC,
  time_to_send_demo_hrs NUMERIC,
  our_avg_reply_speed_hrs NUMERIC,

  -- Notes
  call_summary TEXT,
  call_notes TEXT,
  next_steps TEXT,
  tags TEXT[] DEFAULT '{}',

  -- POC
  poc_status TEXT DEFAULT 'not_started'
    CHECK (poc_status IN ('not_started', 'preparing', 'sent', 'in_review', 'completed', 'failed')),
  poc_notes TEXT,

  -- AI
  heat_score INTEGER DEFAULT 50 CHECK (heat_score >= 0 AND heat_score <= 100),
  ai_heat_reason TEXT,
  ai_next_action TEXT,
  ai_next_action_at TIMESTAMPTZ,

  -- State
  paused_until TIMESTAMPTZ,
  paused_previous_stage lead_stage,
  pinned_note TEXT,
  is_archived BOOLEAN DEFAULT false,

  -- Backlink to original lead for migration tracking
  legacy_lead_id UUID REFERENCES leads(id),

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_deals_stage ON deals(stage);
CREATE INDEX idx_deals_owned_by ON deals(owned_by);
CREATE INDEX idx_deals_contact ON deals(contact_id);
CREATE INDEX idx_deals_company ON deals(company_id);
CREATE INDEX idx_deals_legacy ON deals(legacy_lead_id) WHERE legacy_lead_id IS NOT NULL;

-- ── Nullable FK columns on related tables ─────────────────────────────────────
-- These allow gradual migration: old lead_id still works, new deal_id/contact_id are optional.
ALTER TABLE interactions ADD COLUMN IF NOT EXISTS deal_id UUID REFERENCES deals(id) ON DELETE CASCADE;
ALTER TABLE action_items ADD COLUMN IF NOT EXISTS deal_id UUID REFERENCES deals(id) ON DELETE CASCADE;
ALTER TABLE follow_up_queue ADD COLUMN IF NOT EXISTS deal_id UUID REFERENCES deals(id) ON DELETE CASCADE;
ALTER TABLE activity_log ADD COLUMN IF NOT EXISTS deal_id UUID REFERENCES deals(id) ON DELETE CASCADE;
ALTER TABLE transcripts ADD COLUMN IF NOT EXISTS deal_id UUID REFERENCES deals(id) ON DELETE CASCADE;

-- ── Backward-compatible view ──────────────────────────────────────────────────
-- Returns the same shape as the old leads table, sourced from the new tables.
-- Used during the transition period so existing queries/UI work unchanged.
CREATE OR REPLACE VIEW leads_v AS
SELECT
  d.id,
  c.name AS contact_name,
  c.email AS contact_email,
  c.role AS contact_role,
  c.linkedin AS contact_linkedin,
  co.name AS company_name,
  co.url AS company_url,
  co.stage AS company_stage,
  co.size AS company_size,
  d.sourced_by,
  d.owned_by,
  d.call_participants,
  d.stage,
  d.priority,
  d.first_reply_at,
  d.our_first_response_at,
  d.call_scheduled_for,
  d.call_completed_at,
  d.demo_sent_at,
  d.product_access_granted_at,
  d.last_contact_at,
  d.next_followup_at,
  d.time_to_our_response_hrs,
  d.time_to_schedule_hrs,
  d.time_to_call_hrs,
  d.time_to_send_demo_hrs,
  d.our_avg_reply_speed_hrs,
  d.call_summary,
  d.call_notes,
  d.next_steps,
  d.tags,
  d.poc_status,
  d.poc_notes,
  d.heat_score,
  d.ai_heat_reason,
  d.ai_next_action,
  d.ai_next_action_at,
  d.paused_until,
  d.paused_previous_stage,
  d.pinned_note,
  d.is_archived,
  d.created_at,
  d.updated_at,
  -- Extra fields for new model
  d.contact_id,
  d.company_id,
  d.legacy_lead_id
FROM deals d
LEFT JOIN contacts c ON c.id = d.contact_id
LEFT JOIN companies co ON co.id = d.company_id;
