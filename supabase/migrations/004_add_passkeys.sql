-- Add passkey/WebAuthn credential storage to team_members
ALTER TABLE team_members
ADD COLUMN IF NOT EXISTS passkey_credential_id TEXT,
ADD COLUMN IF NOT EXISTS passkey_public_key TEXT,
ADD COLUMN IF NOT EXISTS passkey_counter INTEGER DEFAULT 0;

-- Index for fast lookup during authentication
CREATE INDEX IF NOT EXISTS idx_team_members_passkey_credential
ON team_members(passkey_credential_id)
WHERE passkey_credential_id IS NOT NULL;
