import { getAppPool } from './app-db.js';
import { logger } from './logger.js';

const CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
let cleanupTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Delete expired unfinished signups from accounts table.
 * - Unverified rows (verify_token is a hex token): deleted after expires_at (24h from signup).
 * - Verified but incomplete rows (verify_token starts with 'confirmed:'): kept for 30 days, then deleted.
 */
async function cleanupExpiredSignups(): Promise<void> {
  const pool = getAppPool();
  if (!pool) return;

  try {
    const { rowCount } = await pool.query(
      `DELETE FROM accounts WHERE verify_token IS NOT NULL AND (
       (expires_at < NOW() AND verify_token NOT LIKE 'confirmed:%')
       OR created_at < NOW() - INTERVAL '30 days')`,
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
