-- Email templates for post-call, post-demo, check-in follow-ups
CREATE TABLE IF NOT EXISTS email_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  subject TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'custom'
    CHECK (category IN ('post_call', 'post_demo', 'check_in', 'booking', 'custom')),
  created_by UUID REFERENCES team_members(id),
  is_shared BOOLEAN NOT NULL DEFAULT true,
  usage_count INTEGER NOT NULL DEFAULT 0,
  last_used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Seed default templates
INSERT INTO email_templates (name, subject, body, category, is_shared) VALUES
(
  'Post-call thank you',
  'Re: {{original_subject}}',
  'Thanks for hopping on the call today, {{contact_first_name}}! Here''s our tool: {{product_url}} — would love to hear your thoughts.

Best,
{{sender_first_name}}',
  'post_call',
  true
),
(
  'Demo follow-up',
  'Re: {{original_subject}}',
  'Hey {{contact_first_name}}, just checking in — have you had a chance to try the tool? Happy to hop on a quick call if anything''s unclear.

Best,
{{sender_first_name}}',
  'post_demo',
  true
),
(
  'Reconnect',
  'Re: {{original_subject}}',
  'Hey {{contact_first_name}}, circling back — still interested in chatting about product prioritization?

Best,
{{sender_first_name}}',
  'check_in',
  true
);

CREATE INDEX idx_email_templates_category ON email_templates(category);
