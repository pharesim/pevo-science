-- PEvO app database schema

CREATE TABLE IF NOT EXISTS notification_preferences (
  username          TEXT PRIMARY KEY,
  email_digest      BOOLEAN NOT NULL DEFAULT false,
  digest_frequency  TEXT NOT NULL DEFAULT 'weekly',
  email             TEXT,
  last_digest_block BIGINT NOT NULL DEFAULT 0,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT last_digest_block_non_negative CHECK (last_digest_block >= 0)
);

-- Unified accounts table
-- State encoded in verify_token:
--   random hex     = unverified (email not yet confirmed)
--   'confirmed:…'  = verified (email confirmed, account not yet created/linked)
--   NULL           = active (fully set up)

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

CREATE TABLE IF NOT EXISTS custody_audit_log (
  id              SERIAL PRIMARY KEY,
  username        TEXT NOT NULL,
  operation_type  TEXT NOT NULL,
  tx_id           TEXT,
  block_num       BIGINT,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_custody_audit_username ON custody_audit_log(username);
CREATE INDEX IF NOT EXISTS idx_custody_audit_created ON custody_audit_log(created_at);

CREATE TABLE IF NOT EXISTS account_creation_tokens (
  id              SERIAL PRIMARY KEY,
  claimed_at      TIMESTAMPTZ DEFAULT NOW(),
  used_at         TIMESTAMPTZ,
  used_for        TEXT
);
