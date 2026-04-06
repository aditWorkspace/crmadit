-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Team Members (pre-seeded, no auth)
CREATE TABLE team_members (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  major TEXT,
  gmail_access_token TEXT,
  gmail_refresh_token TEXT,
  gmail_token_expires_at TIMESTAMPTZ,
  gmail_connected BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now()
);

INSERT INTO team_members (name, email, major) VALUES
  ('Adit', 'aditmittal@berkeley.edu', 'Business and CS'),
  ('Srijay', 'srijay@proxi.ai', 'TBD'),
  ('Asim', 'asim@proxi.ai', 'TBD');

-- Lead stages enum
CREATE TYPE lead_stage AS ENUM (
  'replied',
  'scheduling',
  'scheduled',
  'call_completed',
  'post_call',
  'demo_sent',
  'active_user',
  'paused',
  'dead'
);

-- Interaction type enum
CREATE TYPE interaction_type AS ENUM (
  'email_inbound',
  'email_outbound',
  'call',
  'note',
  'demo_sent',
  'follow_up_auto',
  'stage_change',
  'other'
);

-- Leads
CREATE TABLE leads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_name TEXT NOT NULL,
  contact_email TEXT NOT NULL,
  contact_role TEXT,
  contact_linkedin TEXT,
  company_name TEXT NOT NULL,
  company_url TEXT,
  company_stage TEXT,
  company_size TEXT,
  sourced_by UUID REFERENCES team_members(id) NOT NULL,
  owned_by UUID REFERENCES team_members(id) NOT NULL,
  call_participants UUID[] DEFAULT '{}',
  stage lead_stage DEFAULT 'replied',
  priority TEXT DEFAULT 'medium' CHECK (priority IN ('critical', 'high', 'medium', 'low')),
  first_reply_at TIMESTAMPTZ,
  our_first_response_at TIMESTAMPTZ,
  call_scheduled_for TIMESTAMPTZ,
  call_completed_at TIMESTAMPTZ,
  demo_sent_at TIMESTAMPTZ,
  product_access_granted_at TIMESTAMPTZ,
  last_contact_at TIMESTAMPTZ,
  next_followup_at TIMESTAMPTZ,
  time_to_our_response_hrs NUMERIC,
  time_to_schedule_hrs NUMERIC,
  time_to_call_hrs NUMERIC,
  time_to_send_demo_hrs NUMERIC,
  our_avg_reply_speed_hrs NUMERIC,
  call_summary TEXT,
  call_notes TEXT,
  next_steps TEXT,
  tags TEXT[] DEFAULT '{}',
  poc_status TEXT DEFAULT 'not_started'
    CHECK (poc_status IN ('not_started', 'preparing', 'sent', 'in_review', 'completed', 'failed')),
  poc_notes TEXT,
  heat_score INTEGER DEFAULT 50 CHECK (heat_score >= 0 AND heat_score <= 100),
  paused_until TIMESTAMPTZ,
  paused_previous_stage lead_stage,
  pinned_note TEXT,
  is_archived BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_leads_stage ON leads(stage);
CREATE INDEX idx_leads_owned_by ON leads(owned_by);
CREATE INDEX idx_leads_contact_email ON leads(contact_email);
CREATE INDEX idx_leads_company ON leads(company_name);
CREATE INDEX idx_leads_search ON leads USING gin(
  to_tsvector('english',
    coalesce(contact_name,'') || ' ' ||
    coalesce(company_name,'') || ' ' ||
    coalesce(call_notes,'') || ' ' ||
    coalesce(call_summary,'')
  )
);

-- Action Items
CREATE TABLE action_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id UUID REFERENCES leads(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  assigned_to UUID REFERENCES team_members(id),
  due_date DATE,
  completed BOOLEAN DEFAULT false,
  completed_at TIMESTAMPTZ,
  source TEXT DEFAULT 'manual' CHECK (source IN ('manual', 'ai_extracted', 'auto_generated')),
  sort_order INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_action_items_lead ON action_items(lead_id);
CREATE INDEX idx_action_items_assignee ON action_items(assigned_to, completed);

-- Interactions
CREATE TABLE interactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id UUID REFERENCES leads(id) ON DELETE CASCADE,
  team_member_id UUID REFERENCES team_members(id),
  type interaction_type NOT NULL,
  subject TEXT,
  body TEXT,
  summary TEXT,
  gmail_message_id TEXT,
  gmail_thread_id TEXT,
  occurred_at TIMESTAMPTZ DEFAULT now(),
  response_time_hrs NUMERIC,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE UNIQUE INDEX idx_interactions_gmail_msg ON interactions(gmail_message_id) WHERE gmail_message_id IS NOT NULL;
CREATE INDEX idx_interactions_lead ON interactions(lead_id, occurred_at DESC);
CREATE INDEX idx_interactions_thread ON interactions(gmail_thread_id);

-- Transcripts
CREATE TABLE transcripts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id UUID REFERENCES leads(id) ON DELETE CASCADE,
  source_type TEXT CHECK (source_type IN ('txt_upload', 'granola_link', 'paste')),
  granola_url TEXT,
  file_path TEXT,
  raw_text TEXT,
  ai_summary TEXT,
  ai_next_steps TEXT,
  ai_action_items JSONB,
  ai_sentiment TEXT,
  ai_interest_level TEXT,
  ai_key_quotes JSONB,
  ai_pain_points JSONB,
  ai_product_feedback JSONB,
  ai_follow_up_suggestions JSONB,
  processing_status TEXT DEFAULT 'pending'
    CHECK (processing_status IN ('pending', 'processing', 'completed', 'failed')),
  processed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Follow-up Queue
CREATE TABLE follow_up_queue (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id UUID REFERENCES leads(id) ON DELETE CASCADE,
  assigned_to UUID REFERENCES team_members(id),
  type TEXT NOT NULL,
  reason TEXT,
  suggested_message TEXT,
  due_at TIMESTAMPTZ NOT NULL,
  auto_send BOOLEAN DEFAULT false,
  sent_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  dismissed_at TIMESTAMPTZ,
  status TEXT DEFAULT 'pending'
    CHECK (status IN ('pending', 'sent', 'completed', 'dismissed', 'overdue', 'failed')),
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_followup_pending ON follow_up_queue(status, due_at) WHERE status = 'pending';

-- Activity Log (immutable audit trail)
CREATE TABLE activity_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id UUID REFERENCES leads(id) ON DELETE CASCADE,
  team_member_id UUID REFERENCES team_members(id),
  action TEXT NOT NULL,
  details JSONB,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_activity_log_lead ON activity_log(lead_id, created_at DESC);
CREATE INDEX idx_activity_log_global ON activity_log(created_at DESC);

-- Email Sync State
CREATE TABLE email_sync_state (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_member_id UUID REFERENCES team_members(id) UNIQUE,
  last_history_id TEXT,
  last_synced_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now()
);
