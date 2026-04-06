ALTER TABLE team_members
  ADD COLUMN IF NOT EXISTS gmail_token_expiry TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS gmail_history_id TEXT,
  ADD COLUMN IF NOT EXISTS last_gmail_sync TIMESTAMPTZ;

ALTER TABLE follow_up_queue
  ADD COLUMN IF NOT EXISTS scheduled_for TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS message_template TEXT,
  ADD COLUMN IF NOT EXISTS gmail_thread_id TEXT;
