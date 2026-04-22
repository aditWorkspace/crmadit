-- Auto-reply queue for delayed sending with human-reply cancellation
-- Part of the bulletproof auto-reply system

CREATE TABLE IF NOT EXISTS auto_reply_queue (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  interaction_id UUID REFERENCES interactions(id) ON DELETE SET NULL,

  -- Scheduling
  process_at TIMESTAMPTZ NOT NULL,  -- When to actually process (30-60 min after queue)

  -- Status tracking
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'sent', 'skipped', 'founder', 'failed')),
  skip_reason TEXT,  -- Why it was skipped (human_replied_in_window, etc.)

  -- AI decisions stored for debugging
  classifier_result JSONB,  -- { primary_category, secondary_categories, confidence, etc. }
  edge_detector_result JSONB,  -- { safe_to_auto_reply, concerns, score, etc. }
  writer_result JSONB,  -- { message, etc. }

  -- Final message (after writer)
  final_message TEXT,

  -- Timestamps
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at TIMESTAMPTZ,

  -- Thread info for sending
  gmail_thread_id TEXT,
  owner_id UUID REFERENCES team_members(id)
);

-- Index for efficient draining: find pending entries due for processing
CREATE INDEX IF NOT EXISTS idx_auto_reply_queue_pending
  ON auto_reply_queue(process_at)
  WHERE status = 'pending';

-- Index for finding entries by lead (for human-reply check)
CREATE INDEX IF NOT EXISTS idx_auto_reply_queue_lead
  ON auto_reply_queue(lead_id, created_at DESC);

COMMENT ON TABLE auto_reply_queue IS 'Queued auto-replies waiting for 30-60 min delay before sending. Allows human founders to respond first.';
