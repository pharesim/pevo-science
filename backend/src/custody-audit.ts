import { getAppPool } from './app-db.js';
import { logger } from './logger.js';

/**
 * Optional consent-op metadata captured for `author_accept` / `author_resign`
 * broadcasts. ARCH.md "Light-account signing of consent ops" requires the
 * audit log to capture timestamp (`created_at`, default), session ID,
 * user-agent, and auth-mechanism. Non-consent ops omit these fields and the
 * columns store NULL.
 *
 * Migration: `backend/migrations/005_custody_audit_consent_ops.sql`.
 */
export interface CustodyAuditExtras {
  auth_mechanism?: 'password' | 'orcid';
  /** 'verified' on the success path; `'missing' | 'expired' | 'invalid' | …`
   *  on the rejection path. The handler only writes a row on success today,
   *  so 'verified' is the typical value; the field is forward-compatible
   *  with future failure-row writes. */
  fresh_auth_outcome?: string;
  session_id?: string;
  user_agent?: string;
}

/**
 * Log a custodial broadcast to the audit trail.
 * Non-blocking — logs errors but does not throw.
 */
export async function logCustodyBroadcast(
  username: string,
  operationType: string,
  txId?: string,
  blockNum?: number,
  extras?: CustodyAuditExtras,
): Promise<void> {
  const pool = getAppPool();
  if (!pool) {
    logger.warn({ username, operationType }, 'Custody audit log skipped — no app database');
    return;
  }

  try {
    await pool.query(
      `INSERT INTO custody_audit_log
         (username, operation_type, tx_id, block_num,
          auth_mechanism, fresh_auth_outcome, session_id, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        username,
        operationType,
        txId || null,
        blockNum || null,
        extras?.auth_mechanism ?? null,
        extras?.fresh_auth_outcome ?? null,
        extras?.session_id ?? null,
        extras?.user_agent ?? null,
      ],
    );
  } catch (err) {
    logger.error({ err, username, operationType }, 'Failed to write custody audit log');
  }
}
