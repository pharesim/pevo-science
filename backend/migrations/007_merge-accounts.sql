-- Migration 007: Merge pending_signups and light_accounts into a single accounts table
--
-- State is encoded in verify_token:
--   random hex    = unverified (email not yet confirmed)
--   'confirmed:…' = verified (email confirmed, account not yet created/linked)
--   NULL          = active (fully set up)

-- 1. Create the unified accounts table
CREATE TABLE IF NOT EXISTS accounts (
  id                      SERIAL PRIMARY KEY,
  email                   TEXT NOT NULL UNIQUE,
  password_hash           TEXT NOT NULL,
  full_name               TEXT NOT NULL DEFAULT '',
  institution             TEXT NOT NULL DEFAULT '',
  field                   TEXT NOT NULL DEFAULT '',
  orcid                   TEXT,
  username                TEXT UNIQUE,
  verify_token            TEXT,
  custody                 TEXT,
  posting_key_enc         BYTEA,
  memo_key_enc            BYTEA,
  iv_posting              BYTEA,
  iv_memo                 BYTEA,
  upgraded_at             TIMESTAMPTZ,
  reset_token             TEXT,
  reset_token_expires_at  TIMESTAMPTZ,
  sessions_invalidated_at TIMESTAMPTZ,
  expires_at              TIMESTAMPTZ,
  created_at              TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_accounts_email ON accounts(email);
CREATE INDEX IF NOT EXISTS idx_accounts_username ON accounts(username);
CREATE INDEX IF NOT EXISTS idx_accounts_verify_token ON accounts(verify_token);

-- 2. Migrate existing light_accounts (active accounts) into accounts
INSERT INTO accounts (email, password_hash, username, custody,
                      posting_key_enc, memo_key_enc, iv_posting, iv_memo,
                      upgraded_at, reset_token, reset_token_expires_at,
                      sessions_invalidated_at, created_at)
SELECT email, password_hash, username,
       CASE WHEN upgraded_at IS NOT NULL THEN 'self' ELSE 'light' END,
       posting_key_enc, memo_key_enc, iv_posting, iv_memo,
       upgraded_at, reset_token, reset_token_expires_at,
       sessions_invalidated_at, created_at
FROM light_accounts
ON CONFLICT (email) DO NOTHING;

-- 3. Migrate pending_signups into accounts
INSERT INTO accounts (email, password_hash, full_name, institution, field, orcid,
                      verify_token, expires_at, created_at)
SELECT email, password_hash, full_name, institution, field, orcid,
       verify_token, expires_at, created_at
FROM pending_signups
ON CONFLICT (email) DO NOTHING;

-- 4. Drop old tables
DROP TABLE IF EXISTS pending_signups;
DROP TABLE IF EXISTS light_accounts;
