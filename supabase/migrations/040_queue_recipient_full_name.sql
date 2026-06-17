-- 040: carry the recipient's full name on the send queue so the name-email
-- match guard (last line of defense) can validate last-name-based addresses
-- like trowley@peoplecaddie.com (= "Tim Rowley").
--
-- Before this, queue rows only snapshotted recipient_name (the first name),
-- so tick.ts called looksLikeMatch(firstName, null, email) and the
-- first-initial+last-name branch could never fire — silently SKIPPING every
-- legitimate last-name-based email as a "name_email_mismatch".
--
-- Additive only. The column is nullable; the guard already treats a null
-- full name as "insufficient data, skip last-name checks" (accept by default
-- only when the first name itself can't be checked).

ALTER TABLE email_send_queue ADD COLUMN IF NOT EXISTS recipient_full_name TEXT;
