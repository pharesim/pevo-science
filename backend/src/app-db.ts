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

    -- Unified accounts table (migration 007 merged pending_signups + light_accounts)
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

    -- Drop old tables if they exist (migration 007)
    DROP TABLE IF EXISTS pending_signups;
    DROP TABLE IF EXISTS light_accounts;

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
  `);

  logger.info('App database tables initialized');
}

export async function closeAppPool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
