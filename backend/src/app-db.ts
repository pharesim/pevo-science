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
  `);

  logger.info('App database tables initialized');
}

export async function closeAppPool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
