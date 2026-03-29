-- Initial app database schema
-- Previously created inline in app-db.ts via CREATE TABLE IF NOT EXISTS

CREATE TABLE IF NOT EXISTS pending_accreditations (
  token         TEXT PRIMARY KEY,
  hive_username TEXT NOT NULL,
  full_name     TEXT NOT NULL,
  institution   TEXT NOT NULL,
  field         TEXT NOT NULL,
  email         TEXT NOT NULL,
  orcid         TEXT NOT NULL DEFAULT '',
  expires_at    TIMESTAMPTZ NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pending_accred_expires
  ON pending_accreditations (expires_at);

CREATE TABLE IF NOT EXISTS anon_review_mappings (
  anon_permlink   TEXT PRIMARY KEY,
  paper_author    TEXT NOT NULL,
  paper_permlink  TEXT NOT NULL,
  encrypted_data  TEXT NOT NULL,
  iv              TEXT NOT NULL,
  auth_tag        TEXT NOT NULL,
  key_version     INTEGER NOT NULL DEFAULT 1,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at      TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_anon_mappings_expires
  ON anon_review_mappings (expires_at);

CREATE TABLE IF NOT EXISTS notification_preferences (
  username          TEXT PRIMARY KEY,
  email_digest      BOOLEAN NOT NULL DEFAULT false,
  digest_frequency  TEXT NOT NULL DEFAULT 'weekly',
  email             TEXT,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
