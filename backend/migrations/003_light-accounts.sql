-- Light accounts: custodial onboarding for accredited scientists

CREATE TABLE pending_signups (
  id               SERIAL PRIMARY KEY,
  username         TEXT NOT NULL UNIQUE,
  email            TEXT NOT NULL UNIQUE,
  password_hash    TEXT NOT NULL,
  linked_username  TEXT,
  full_name        TEXT NOT NULL,
  institution      TEXT NOT NULL,
  field            TEXT NOT NULL,
  orcid            TEXT,
  verify_token     TEXT NOT NULL,
  expires_at       TIMESTAMPTZ NOT NULL,
  created_at       TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE light_accounts (
  username         TEXT PRIMARY KEY,
  password_hash    TEXT NOT NULL,
  email            TEXT NOT NULL UNIQUE,
  posting_key_enc  BYTEA,
  memo_key_enc     BYTEA,
  iv_posting       BYTEA,
  iv_memo          BYTEA,
  upgraded_at      TIMESTAMPTZ,
  created_at       TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_light_accounts_email ON light_accounts(email);

CREATE TABLE custody_audit_log (
  id              SERIAL PRIMARY KEY,
  username        TEXT NOT NULL,
  operation_type  TEXT NOT NULL,
  tx_id           TEXT,
  block_num       BIGINT,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_custody_audit_username ON custody_audit_log(username);
CREATE INDEX idx_custody_audit_created ON custody_audit_log(created_at);

CREATE TABLE account_creation_tokens (
  id              SERIAL PRIMARY KEY,
  claimed_at      TIMESTAMPTZ DEFAULT NOW(),
  used_at         TIMESTAMPTZ,
  used_for        TEXT
);
