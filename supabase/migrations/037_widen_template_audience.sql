-- Widen email_template_variants.audience CHECK constraint to allow 'dripify'.
-- The existing constraint allowed only 'yc' or 'general'. Adding 'dripify'
-- is purely additive — every prior row stays valid. Drop+re-add is the
-- canonical way to widen a CHECK; the original constraint is replaced by
-- a strictly more permissive one in the same statement block.

ALTER TABLE email_template_variants
  DROP CONSTRAINT IF EXISTS email_template_variants_audience_check;

ALTER TABLE email_template_variants
  ADD CONSTRAINT email_template_variants_audience_check
  CHECK (audience IN ('yc', 'general', 'dripify'));
