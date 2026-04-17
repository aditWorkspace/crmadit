-- Phase 2c: Internal thread comments + @mention notifications
-- Lane G

CREATE TABLE IF NOT EXISTS thread_comments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  gmail_thread_id TEXT NOT NULL,
  author_id UUID NOT NULL REFERENCES team_members(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  mentioned_ids UUID[] NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS thread_comments_thread_idx ON thread_comments (gmail_thread_id, created_at DESC);
CREATE INDEX IF NOT EXISTS thread_comments_author_idx ON thread_comments (author_id, created_at DESC);

CREATE TABLE IF NOT EXISTS mention_notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  recipient_id UUID NOT NULL REFERENCES team_members(id) ON DELETE CASCADE,
  comment_id UUID NOT NULL REFERENCES thread_comments(id) ON DELETE CASCADE,
  gmail_thread_id TEXT NOT NULL,
  read_at TIMESTAMPTZ,
  digested_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS mention_notifications_recipient_unread_idx
  ON mention_notifications (recipient_id, read_at)
  WHERE read_at IS NULL;
CREATE INDEX IF NOT EXISTS mention_notifications_thread_idx
  ON mention_notifications (gmail_thread_id, created_at DESC);

DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE thread_comments;
EXCEPTION WHEN others THEN NULL;
END $$;
DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE mention_notifications;
EXCEPTION WHEN others THEN NULL;
END $$;
