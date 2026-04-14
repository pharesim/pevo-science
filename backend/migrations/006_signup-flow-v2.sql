-- Signup Flow v2: Username and link_flow are no longer needed at signup time.
-- Username is chosen post-verification; create-vs-link is determined post-verification.
ALTER TABLE pending_signups DROP COLUMN IF EXISTS username;
ALTER TABLE pending_signups DROP COLUMN IF EXISTS link_flow;
DROP INDEX IF EXISTS pending_signups_username_key;
