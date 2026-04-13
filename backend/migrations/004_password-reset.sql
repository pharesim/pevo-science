-- Password reset support: token storage and session invalidation

ALTER TABLE light_accounts ADD COLUMN reset_token TEXT;
ALTER TABLE light_accounts ADD COLUMN reset_token_expires_at TIMESTAMPTZ;
ALTER TABLE light_accounts ADD COLUMN sessions_invalidated_at TIMESTAMPTZ;
