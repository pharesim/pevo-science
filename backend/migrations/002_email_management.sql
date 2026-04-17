-- EMAIL-B1: Email management for settings page
-- Allows Keychain users to add email (no password), and supports pending email change flow.

ALTER TABLE accounts ALTER COLUMN password_hash DROP NOT NULL;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS pending_email TEXT;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS pending_email_token TEXT;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS pending_email_expires_at TIMESTAMPTZ;
