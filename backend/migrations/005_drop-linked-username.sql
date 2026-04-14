-- Remove linked_username from pending_signups; replace with link_flow flag.
-- Hive username is now collected at the Keychain linking step, not at signup.

ALTER TABLE pending_signups ADD COLUMN IF NOT EXISTS link_flow BOOLEAN NOT NULL DEFAULT FALSE;

-- Migrate existing data: rows with linked_username set are link flows
UPDATE pending_signups SET link_flow = TRUE WHERE linked_username IS NOT NULL;

-- Make username nullable (only needed for new-account flows)
ALTER TABLE pending_signups ALTER COLUMN username DROP NOT NULL;

ALTER TABLE pending_signups DROP COLUMN IF EXISTS linked_username;
