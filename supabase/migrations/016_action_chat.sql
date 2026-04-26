-- Phase 14: Action Chat — natural-language CRM bulk operations.
-- Separate tables from the existing chat_sessions/chat_messages because the
-- shape is meaningfully different: messages carry tool calls and tool
-- results in their content payload, and we track pending mutations in their
-- own row so the user can Confirm/Cancel after seeing a preview.

CREATE TABLE IF NOT EXISTS action_chat_sessions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_member_id  UUID NOT NULL REFERENCES team_members(id) ON DELETE CASCADE,
  title           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_action_chat_sessions_member
  ON action_chat_sessions (team_member_id, updated_at DESC);

-- role: 'user' | 'assistant' | 'tool' | 'system'
-- content: JSONB. For 'user'/'assistant': { text, tool_calls? }. For 'tool':
-- { tool_call_id, tool_name, kind: 'read'|'mutation_preview'|'mutation_result', data }.
CREATE TABLE IF NOT EXISTS action_chat_messages (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id  UUID NOT NULL REFERENCES action_chat_sessions(id) ON DELETE CASCADE,
  role        TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'tool', 'system')),
  content     JSONB NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_action_chat_messages_session
  ON action_chat_messages (session_id, created_at);

-- Pending mutations awaiting user confirmation. TTL via expires_at; expired
-- rows can no longer be confirmed. The cron-job.org schedule eventually
-- garbage-collects them, but expiry check is enforced at confirm time too.
CREATE TABLE IF NOT EXISTS action_chat_pending (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id  UUID NOT NULL REFERENCES action_chat_sessions(id) ON DELETE CASCADE,
  message_id  UUID NOT NULL REFERENCES action_chat_messages(id) ON DELETE CASCADE,
  tool_name   TEXT NOT NULL,
  args        JSONB NOT NULL,        -- the validated tool arguments
  preview     JSONB NOT NULL,        -- what we showed the user (lead diffs, etc.)
  status      TEXT NOT NULL DEFAULT 'pending'
              CHECK (status IN ('pending', 'confirmed', 'cancelled', 'expired')),
  result      JSONB,                  -- populated after successful execution
  team_member_id UUID NOT NULL REFERENCES team_members(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  executed_at TIMESTAMPTZ,
  expires_at  TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '10 minutes')
);

CREATE INDEX IF NOT EXISTS idx_action_chat_pending_status
  ON action_chat_pending (status, expires_at);
