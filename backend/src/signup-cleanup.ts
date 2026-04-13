import { getAppPool } from './app-db.js';
import { logger } from './logger.js';

const CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
let cleanupTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Delete expired rows from pending_signups (24h expiry).
 */
async function cleanupExpiredSignups(): Promise<void> {
  const pool = getAppPool();
  if (!pool) return;

  try {
    const { rowCount } = await pool.query(
      'DELETE FROM pending_signups WHERE expires_at < NOW()',
    );
    if (rowCount && rowCount > 0) {
      logger.info({ deleted: rowCount }, 'Cleaned up expired pending signups');
    }
  } catch (err) {
    logger.error({ err }, 'Failed to clean up expired pending signups');
  }
}

export function startSignupCleanup(): void {
  cleanupExpiredSignups();
  cleanupTimer = setInterval(cleanupExpiredSignups, CLEANUP_INTERVAL_MS);
  cleanupTimer.unref();
  logger.info('Pending signup cleanup started (every 1h)');
}

export function stopSignupCleanup(): void {
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
  }
}
