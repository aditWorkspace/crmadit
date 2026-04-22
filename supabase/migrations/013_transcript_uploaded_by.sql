-- Track who uploaded each transcript
ALTER TABLE transcripts ADD COLUMN IF NOT EXISTS uploaded_by UUID REFERENCES team_members(id);
