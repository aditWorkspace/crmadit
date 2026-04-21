-- Availability cache for instant booking page loads
-- Stores FreeBusy results per member per date range

CREATE TABLE IF NOT EXISTS availability_cache (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id UUID NOT NULL REFERENCES team_members(id) ON DELETE CASCADE,
  range_key TEXT NOT NULL, -- "{rangeStart}_{rangeEnd}" for easy lookup
  busy_blocks JSONB NOT NULL DEFAULT '[]', -- array of {start, end} ISO strings
  cached_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE(member_id, range_key)
);

-- Index for cleanup queries
CREATE INDEX IF NOT EXISTS availability_cache_cached_at_idx ON availability_cache(cached_at);

-- Index for lookup
CREATE INDEX IF NOT EXISTS availability_cache_range_key_idx ON availability_cache(range_key);

-- Booking idempotency table to prevent double-clicks creating duplicate events
CREATE TABLE IF NOT EXISTS booking_idempotency (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key TEXT NOT NULL UNIQUE,
  booking_email TEXT NOT NULL,
  start_time TIMESTAMPTZ NOT NULL,
  event_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Auto-cleanup old idempotency keys (older than 1 hour)
CREATE INDEX IF NOT EXISTS booking_idempotency_created_at_idx ON booking_idempotency(created_at);
