import { getAppPool } from './app-db.js';
import { logger } from './logger.js';

/**
 * Optional consent-op metadata captured for `author_accept` / `author_resign`
 * broadcasts. ARCH.md "Light-account signing of consent ops" requires the
 * audit log to capture timestamp (`created_at`, default), session ID,
 * user-agent, and auth-mechanism. Non-consent ops omit `extras` entirely
 * (every field stores NULL) — the parameter is `undefined`, not an empty
 * object.
 *
 * This type collapsed from a `T | Record<string, never>` discriminated
 * union to a single optional shape. The empty `Record<string, never>` arm was
 * phantom: every call site either passed the consent shape or omitted `extras`
 * entirely; no caller ever constructed `{}`. The convention's load-bearing
 * detail (preventing half-population — `auth_mechanism`
 * without `fresh_auth_outcome` or vice versa) is preserved by the consent
 * arm's required-fields shape: TS still rejects an `extras` value that
 * carries one of the two co-required fields without the other.
 *
 * Per
 * `agents/docs/solutions/conventions/correlated-options-discriminated-union-2026-04-28.md`.
 * The four fields are semantically correlated (only meaningful when a
 * consent op fired); making both fields co-required prevents callers supplying
 * `fresh_auth_outcome` without `auth_mechanism` with no TS error.
 *
 * `fresh_auth_outcome` is constrained to the values `consumeFreshAuthToken`
 * actually emits. Only `'verified'` is written today; the other variants are
 * forward-compatible for the future failure-row write path.
 *
 * Migration: `backend/migrations/005_custody_audit_consent_ops.sql`.
 */
export type FreshAuthOutcome =
  | 'verified'
  | 'missing'
  | 'expired'
  | 'username_mismatch'
  | 'target_mismatch'
  | 'malformed';

export type CustodyAuditExtras = {
  auth_mechanism: 'password' | 'orcid';
  fresh_auth_outcome: FreshAuthOutcome;
  session_id?: string;
  /** SHA-256 hash of the request's User-Agent header. Hashed at the route
   *  boundary via `hashUserAgentForAudit` for GDPR data minimization; raw
   *  header values never reach this writer. Absent / empty / non-string
   *  headers arrive as `undefined` and persist as NULL. */
  user_agent?: string;
};

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
    // With the union collapsed to a single optional shape,
    // narrowing degenerates to a bare `extras !== undefined` check. The
    // empty Record<string, never> arm is gone; callers either pass the
    // full consent shape or omit `extras` entirely.
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
