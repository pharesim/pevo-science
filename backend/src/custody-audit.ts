import { getAppPool } from './app-db.js';
import { logger } from './logger.js';

/**
 * Optional consent-op metadata captured for `author_accept` / `author_resign`
 * broadcasts. ARCH.md "Light-account signing of consent ops" requires the
 * audit log to capture timestamp (`created_at`, default), session ID,
 * user-agent, and auth-mechanism. Non-consent ops omit these fields and the
 * columns store NULL.
 *
 * Round-4 hold #9: typed as a discriminated union per
 * `agents/docs/solutions/conventions/correlated-options-discriminated-union-2026-04-28.md`.
 * The four fields are semantically correlated (only meaningful when a
 * consent op fired) — typing them as independent optionals admitted callers
 * supplying `fresh_auth_outcome` without `auth_mechanism` with no TS error.
 * The discriminator is the implicit "consent op fired" signal: `auth_mechanism`
 * + `fresh_auth_outcome` are co-required in the consent variant; the
 * non-consent variant is the empty `{}` (omitted).
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
  | 'malformed';

export type CustodyAuditExtras =
  | {
      auth_mechanism: 'password' | 'orcid';
      fresh_auth_outcome: FreshAuthOutcome;
      session_id?: string;
      user_agent?: string;
    }
  | Record<string, never>;

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
    // Discriminate on `auth_mechanism` presence: only the consent-op variant
    // carries the extra fields. The Record<string, never> variant collapses
    // to all NULLs. Direct property access via `'auth_mechanism' in extras`
    // narrows the union without triggering the optional-chaining-on-never
    // lint friction that motivated round-4 hold #9 in the first place.
    const consentExtras =
      extras && 'auth_mechanism' in extras ? extras : undefined;
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
        consentExtras?.auth_mechanism ?? null,
        consentExtras?.fresh_auth_outcome ?? null,
        consentExtras?.session_id ?? null,
        consentExtras?.user_agent ?? null,
      ],
    );
  } catch (err) {
    logger.error({ err, username, operationType }, 'Failed to write custody audit log');
  }
}
