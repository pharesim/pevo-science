import { getAppPool } from './app-db.js';
import { logger } from './logger.js';

/**
 * Log a custodial broadcast to the audit trail.
 * Non-blocking — logs errors but does not throw.
 */
export async function logCustodyBroadcast(
  username: string,
  operationType: string,
  txId?: string,
  blockNum?: number,
): Promise<void> {
  const pool = getAppPool();
  if (!pool) {
    logger.warn({ username, operationType }, 'Custody audit log skipped — no app database');
    return;
  }

  try {
    await pool.query(
      `INSERT INTO custody_audit_log (username, operation_type, tx_id, block_num)
       VALUES ($1, $2, $3, $4)`,
      [username, operationType, txId || null, blockNum || null],
    );
  } catch (err) {
    logger.error({ err, username, operationType }, 'Failed to write custody audit log');
  }
}
