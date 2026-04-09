-- Knowledge docs: 3 living documents that accumulate insights across all transcripts
-- Used by the /insights page for chat-over-knowledge and doc viewer

CREATE TABLE knowledge_docs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  doc_type TEXT NOT NULL CHECK (doc_type IN ('problems', 'product_feedback', 'solutions')),
  content TEXT NOT NULL DEFAULT '',
  updated_at TIMESTAMPTZ DEFAULT now(),
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE UNIQUE INDEX idx_knowledge_docs_type ON knowledge_docs(doc_type);

-- Seed the three docs
INSERT INTO knowledge_docs (doc_type, content) VALUES
  ('problems', '# Problems & Pain Points

Insights from prospect discovery calls.

'),
  ('product_feedback', '# Product Feedback

What prospects think about Proxi AI — likes, dislikes, suggestions.

'),
  ('solutions', '# Solutions & Ideas

Workflow ideas, feature requests, and how prospects would use Proxi.

');

-- Concurrent-safe append function: appends markdown content to a knowledge doc
CREATE OR REPLACE FUNCTION append_knowledge_doc(p_doc_type TEXT, p_content TEXT)
RETURNS void AS $$
  UPDATE knowledge_docs
  SET content = content || p_content, updated_at = now()
  WHERE doc_type = p_doc_type;
$$ LANGUAGE sql;
