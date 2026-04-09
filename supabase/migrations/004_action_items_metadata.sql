-- Add metadata JSONB column to action_items for urgency/type hints
ALTER TABLE action_items ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}';
