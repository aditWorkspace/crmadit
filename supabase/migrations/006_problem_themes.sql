-- Add 'problem_themes' doc_type to knowledge_docs

-- Drop existing CHECK constraint and re-add with new value
ALTER TABLE knowledge_docs DROP CONSTRAINT knowledge_docs_doc_type_check;
ALTER TABLE knowledge_docs ADD CONSTRAINT knowledge_docs_doc_type_check
  CHECK (doc_type IN ('problems', 'product_feedback', 'solutions', 'problem_themes'));

-- Seed the new doc row (no-op if already exists due to unique index)
INSERT INTO knowledge_docs (doc_type, content)
VALUES ('problem_themes', '{"themes":[],"generated_at":null}')
ON CONFLICT (doc_type) DO NOTHING;
