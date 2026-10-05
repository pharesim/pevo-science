import { getAppPool } from './app-db.js';
import { logger } from './logger.js';

const CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
let cleanupTimer: ReturnType<typeof setInterval> | null = null;

/**
 * The `accounts` rows the hourly job deletes as abandoned (ARCHITECTURE.md
 * § 6.1, § 6.3). Two kinds of row qualify, told apart by `username`.
 *
 * Signup rows (states E and F, `username` NULL):
 * - Unverified (verify_token is a hex token): deleted after expires_at (24h from signup).
 * - Verified but incomplete (verify_token starts with 'confirmed:'): kept for 30 days, then deleted.
 *
 * State G rows (`username` set: a self-custody account whose row exists only
 * because it registered an email through the settings add flow): deleted only
 * while the email is unverified (hex verify_token), its link has expired, and
 * the row carries no password and no ORCID. Such a row holds nothing but the
 * email claim, so deleting it returns the account to the no-row case and
 * releases the email. A G row carrying a factor is never deleted here, and
 * neither is a verified G row (verify_token NULL). The 30-day arm applies to
 * signup rows only.
 *
 * Exported as a WHERE fragment so its test can run the job's own predicate
 * narrowed to the rows the test seeded; the job itself deletes every matching
 * row in the table.
 */
export const ABANDONED_ACCOUNT_ROWS = `verify_token IS NOT NULL AND (
       (username IS NULL AND (
         (expires_at < NOW() AND verify_token NOT LIKE 'confirmed:%')
         OR created_at < NOW() - INTERVAL '30 days'))
       OR (username IS NOT NULL
         AND verify_token NOT LIKE 'confirmed:%'
         AND expires_at < NOW()
         AND password_hash IS NULL
         AND orcid IS NULL))`;

async function cleanupExpiredSignups(): Promise<void> {
  const pool = getAppPool();
  if (!pool) return;

  try {
    const { rowCount } = await pool.query(
      `DELETE FROM accounts WHERE ${ABANDONED_ACCOUNT_ROWS}`,
    );
    if (rowCount && rowCount > 0) {
      logger.info({ deleted: rowCount }, 'Cleaned up expired pending signups');
    }
  } catch (err) {
    logger.error({ err }, 'Failed to clean up expired pending signups');
  }
}

export function startSignupCleanup(): void {
  void cleanupExpiredSignups();
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
