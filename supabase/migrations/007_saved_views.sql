-- Saved views for the leads table
CREATE TABLE IF NOT EXISTS saved_views (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  created_by UUID REFERENCES team_members(id) NOT NULL,
  is_shared BOOLEAN NOT NULL DEFAULT true,
  filters JSONB NOT NULL DEFAULT '{}',
  sort_by TEXT DEFAULT 'updated_at',
  sort_dir TEXT DEFAULT 'desc',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_saved_views_creator ON saved_views(created_by);
