import pg from 'pg';
import { config } from './config.js';
import { logger, getRequestId } from './logger.js';

const { Pool } = pg;

let pool: pg.Pool | null = null;

export function getPool(): pg.Pool | null {
  if (pool) return pool;
  if (config.hafDatabaseUrls.length === 0) return null;

  pool = new Pool({
    connectionString: config.hafDatabaseUrls[0],
    max: 3,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });

  // Set statement_timeout per-connection after connect (some hosts reject it as a startup param)
  pool.on('connect', (client) => {
    client.query('SET statement_timeout = 30000').catch((err) => {
      logger.warn({ err }, 'Could not set statement_timeout on HAF connection');
    });
  });

  pool.on('error', (err) => {
    logger.error({ err, reqId: getRequestId() }, 'Unexpected HAF pool error');
  });

  return pool;
}

export function isHafAvailable(): boolean {
  return config.hafDatabaseUrls.length > 0;
}

export async function closeHafPool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
