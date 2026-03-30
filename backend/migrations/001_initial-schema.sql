-- Initial app database schema
-- Only notification_preferences uses the app database.
-- Pending accreditations and anon review mappings are stored in Redis + in-memory.

CREATE TABLE IF NOT EXISTS notification_preferences (
  username          TEXT PRIMARY KEY,
  email_digest      BOOLEAN NOT NULL DEFAULT false,
  digest_frequency  TEXT NOT NULL DEFAULT 'weekly',
  email             TEXT,
  last_digest_block BIGINT NOT NULL DEFAULT 0,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
