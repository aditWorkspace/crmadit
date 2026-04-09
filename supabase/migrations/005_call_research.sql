-- Add pre-call research fields to leads
ALTER TABLE leads ADD COLUMN IF NOT EXISTS call_prep_notes TEXT;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS call_prep_status TEXT
  DEFAULT 'not_started' CHECK (call_prep_status IN ('not_started', 'generating', 'completed', 'failed'));
ALTER TABLE leads ADD COLUMN IF NOT EXISTS call_prep_generated_at TIMESTAMPTZ;
