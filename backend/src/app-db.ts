import pg from 'pg';
import { config } from './config.js';
import { logger } from './logger.js';

const { Pool } = pg;

let pool: pg.Pool | null = null;

export function getAppPool(): pg.Pool | null {
  if (pool) return pool;
  if (!config.appDatabaseUrl) return null;

  pool = new Pool({
    connectionString: config.appDatabaseUrl,
    max: 5,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });

  pool.on('error', (err) => {
    logger.error({ err }, 'Unexpected app DB pool error');
  });

  return pool;
}

export async function initAppDb(): Promise<void> {
  const p = getAppPool();
  if (!p) {
    logger.warn('APP_DATABASE_URL not configured — email notification preferences will not persist');
    return;
  }

  // Auto-create tables for dev convenience. In production, use: npm run migrate:up
  await p.query(`
    CREATE TABLE IF NOT EXISTS notification_preferences (
      username          TEXT PRIMARY KEY,
      email_digest      BOOLEAN NOT NULL DEFAULT false,
      digest_frequency  TEXT NOT NULL DEFAULT 'weekly',
      email             TEXT,
      last_digest_block BIGINT NOT NULL DEFAULT 0,
      updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    -- Add column if table already exists from previous schema
    ALTER TABLE notification_preferences
      ADD COLUMN IF NOT EXISTS last_digest_block BIGINT NOT NULL DEFAULT 0;

    -- Light accounts tables
    CREATE TABLE IF NOT EXISTS pending_signups (
      id               SERIAL PRIMARY KEY,
      username         TEXT UNIQUE,
      email            TEXT NOT NULL UNIQUE,
      password_hash    TEXT NOT NULL,
      link_flow        BOOLEAN NOT NULL DEFAULT FALSE,
      full_name        TEXT NOT NULL DEFAULT '',
      institution      TEXT NOT NULL DEFAULT '',
      field            TEXT NOT NULL DEFAULT '',
      orcid            TEXT,
      verify_token     TEXT NOT NULL,
      expires_at       TIMESTAMPTZ NOT NULL,
      created_at       TIMESTAMPTZ DEFAULT NOW()
    );

    -- Add columns if table already exists from previous schema
    ALTER TABLE pending_signups ADD COLUMN IF NOT EXISTS full_name TEXT NOT NULL DEFAULT '';
    ALTER TABLE pending_signups ADD COLUMN IF NOT EXISTS institution TEXT NOT NULL DEFAULT '';
    ALTER TABLE pending_signups ADD COLUMN IF NOT EXISTS field TEXT NOT NULL DEFAULT '';
    ALTER TABLE pending_signups ADD COLUMN IF NOT EXISTS orcid TEXT;
    ALTER TABLE pending_signups ADD COLUMN IF NOT EXISTS link_flow BOOLEAN NOT NULL DEFAULT FALSE;

    -- Migration 005: drop linked_username, make username nullable
    ALTER TABLE pending_signups DROP COLUMN IF EXISTS linked_username;
    ALTER TABLE pending_signups ALTER COLUMN username DROP NOT NULL;

    CREATE TABLE IF NOT EXISTS light_accounts (
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

    CREATE INDEX IF NOT EXISTS idx_light_accounts_email ON light_accounts(email);

    CREATE TABLE IF NOT EXISTS custody_audit_log (
      id              SERIAL PRIMARY KEY,
      username        TEXT NOT NULL,
      operation_type  TEXT NOT NULL,
      tx_id           TEXT,
      block_num       BIGINT,
      created_at      TIMESTAMPTZ DEFAULT NOW()
    );

    -- Password reset columns (migration 004)
    ALTER TABLE light_accounts ADD COLUMN IF NOT EXISTS reset_token TEXT;
    ALTER TABLE light_accounts ADD COLUMN IF NOT EXISTS reset_token_expires_at TIMESTAMPTZ;
    ALTER TABLE light_accounts ADD COLUMN IF NOT EXISTS sessions_invalidated_at TIMESTAMPTZ;

    CREATE INDEX IF NOT EXISTS idx_custody_audit_username ON custody_audit_log(username);
    CREATE INDEX IF NOT EXISTS idx_custody_audit_created ON custody_audit_log(created_at);

    CREATE TABLE IF NOT EXISTS account_creation_tokens (
      id              SERIAL PRIMARY KEY,
      claimed_at      TIMESTAMPTZ DEFAULT NOW(),
      used_at         TIMESTAMPTZ,
      used_for        TEXT
    );
  `);

  logger.info('App database tables initialized');
}

export async function closeAppPool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
