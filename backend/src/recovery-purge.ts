/**
 * Ageing purge for the `pending_recovery` staging table (migration 012).
 *
 * Each row stages a two-phase memo-key recovery: a third-party plaintext
 * `new_email` plus an offline-crackable argon2id `new_password_hash`, alongside
 * verify/dispute token digests. A row is consumed by phase 2, voided by a
 * dispute, superseded by a re-stage for the same username, and removed for a
 * user by the account-delete GDPR sweep. Absent any of those, an expired-unused,
 * consumed, or disputed row otherwise persists until the account is deleted.
 *
 * Under CNPD/GDPR data minimization, staged PII must not outlive its purpose.
 * After `dispute_expires_at` (~48h) a row can no longer be verified (phase 2)
 * nor disputed, so its plaintext fields have no remaining function. The durable
 * forensic record is `custody_audit_log` — it survives independently and is the
 * dispute signal per migration 012 — so nothing of value is left in the staging
 * row once its windows close. We therefore DELETE rather than scrub: every row
 * whose dispute window closed more than RETENTION_GRACE_MS ago is removed,
 * regardless of consumed/disputed/expired state.
 *
 * Mirrors the bridge-queue ageing-purge (`purgeAgedTerminalEntries`): a
 * low-frequency tick, threshold computed in JS so a millisecond retention
 * cannot overflow an int4 interval multiplier, errors swallowed as non-fatal
 * maintenance.
 */

import { getAppPool } from './app-db.js';
import { logger } from './logger.js';

const PURGE_TICK_MS = 60 * 60_000; // hourly

/**
 * Grace past a row's dispute window (`dispute_expires_at`) before it is
 * purged. Buffers clock skew and an in-flight dispute click landing right at
 * the window edge.
 */
const RETENTION_GRACE_MS = 24 * 60 * 60_000; // 24h

let purgeTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Delete `pending_recovery` rows whose dispute window closed more than
 * `graceMs` ago. The threshold is computed in JS (not via SQL interval math)
 * so the millisecond grace cannot overflow an int4 interval multiplier,
 * mirroring `purgeAgedTerminalEntries`. Returns the number of rows deleted.
 */
export async function purgeAgedPendingRecovery(graceMs: number = RETENTION_GRACE_MS): Promise<number> {
  const pool = getAppPool();
  if (!pool) return 0;
  const threshold = new Date(Date.now() - graceMs);
  const result = await pool.query(
    `DELETE FROM pending_recovery WHERE dispute_expires_at < $1`,
    [threshold],
  );
  return result.rowCount ?? 0;
}

/**
 * One purge tick. Swallows its own errors — a failed purge is non-fatal
 * operational maintenance, never a reason to disturb request handling.
 */
async function runPurgeTick(): Promise<void> {
  try {
    const deleted = await purgeAgedPendingRecovery();
    if (deleted > 0) {
      logger.info(
        { event: 'recovery.purge', deleted },
        'pending_recovery retired aged staging rows',
      );
    }
  } catch (err) {
    logger.warn(
      { err, event: 'recovery.purge_failed' },
      'pending_recovery purge tick failed',
    );
  }
}

export function startRecoveryPurge(): void {
  if (purgeTimer) return;
  // Run an immediate first pass at boot so rows already past their grace are
  // cleared on restart, rather than lingering up to a full tick. The start
  // call runs after the app DB pool is initialized, and the tick swallows its
  // own errors, so a boot-time DB hiccup cannot disturb startup.
  void runPurgeTick();
  purgeTimer = setInterval(() => {
    void runPurgeTick();
  }, PURGE_TICK_MS);
  // Do not keep the event loop alive for a maintenance ticker.
  purgeTimer.unref();
}

export function stopRecoveryPurge(): void {
  if (purgeTimer) {
    clearInterval(purgeTimer);
    purgeTimer = null;
  }
}
