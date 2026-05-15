import type pg from 'pg';
import { logger } from '../logger.js';
import { flushAndExit } from '../lib/flush-and-exit.js';

/**
 * BACKEND-CUSTODY-AUDIT-RETENTION-SWEEP — GDPR Art. 5(1)(e) storage-limitation
 * enforcement for `custody_audit_log`.
 *
 * Migration 006 (`backend/migrations/006_custody_audit_pii_annotation.sql`)
 * documents the retention period for `custody_audit_log.user_agent` in a
 * `COMMENT ON COLUMN` annotation. That comment is the single source of truth
 * (SOT) for the retention window. This sweep reads the comment at startup,
 * parses the "Retention period: <N> months" line, and runs a periodic
 * `DELETE FROM custody_audit_log WHERE created_at < now() - interval '<N> months'`.
 *
 * Trigger shape: startup sweep + daily `setInterval` tick. PEvO is
 * single-instance (no leader-election concerns), so a daily cadence is fine.
 * The startup sweep naturally backfills pre-existing rows older than the
 * retention period on the first boot after deploy — no separate backfill
 * code path is needed.
 *
 * Logging discipline (memory `feedback_pevo_logging_minimal`): NO info-level
 * logs on per-tick success. The only log lines are (a) a fatal boot-fatal on
 * SOT-parse failure (followed by `flushAndExit()`), and (b) an error log if
 * the DELETE itself throws on a periodic tick (we keep the process alive on
 * runtime failures so a transient DB blip doesn't take down the backend).
 */

const SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24h
const COMMENT_QUERY = `
  SELECT col_description('custody_audit_log'::regclass, attnum) AS comment
    FROM pg_attribute
   WHERE attrelid = 'custody_audit_log'::regclass
     AND attname  = 'user_agent'
`;

let sweepTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Parse the retention-period months from the `user_agent` column comment.
 *
 * Expected format: the comment text contains a substring like
 * `Retention: 24 months from row insert` (case-insensitive, "Retention period"
 * also accepted). Returns the integer month count.
 *
 * Throws on:
 *   - `null` input (column comment is missing — migration 006 not applied).
 *   - Empty / whitespace-only comment.
 *   - Comment present but missing the "Retention[: | period] <N> months" line.
 *   - Parsed value <= 0 or non-integer.
 *
 * This is exported separately from `runSweep` so the test suite can assert
 * the fail-loud parse contract without mocking `process.exit`/`logger.flush`.
 * The boot caller wraps the throw in a `flushAndExit()` path so a missing or
 * malformed comment refuses to start the backend.
 */
export function parseRetentionMonthsFromComment(comment: string | null): number {
  if (comment == null || comment.trim() === '') {
    throw new Error(
      'custody_audit_log.user_agent column comment is missing or empty. ' +
      'Migration 006_custody_audit_pii_annotation.sql must run before boot. ' +
      'The retention period SOT lives in the column comment per ' +
      'BACKEND-CUSTODY-AUDIT-RETENTION-SWEEP — refusing to start.',
    );
  }
  // Match `Retention: <N> months` or `Retention period: <N> months`,
  // case-insensitive. The migration 006 text uses "Retention: 24 months from
  // row insert"; the older "Retention period: 24 months" wording is also
  // accepted to absorb minor future copy edits without forcing a code change.
  const match = comment.match(/Retention(?:\s+period)?\s*:\s*(\d+)\s+months/i);
  if (!match) {
    throw new Error(
      'custody_audit_log.user_agent column comment is present but does not ' +
      'contain a parseable "Retention: <N> months" line. ' +
      `Comment text: ${JSON.stringify(comment)}`,
    );
  }
  const months = Number.parseInt(match[1], 10);
  if (!Number.isFinite(months) || months <= 0) {
    throw new Error(
      `custody_audit_log.user_agent retention months parsed to non-positive integer: ${match[1]}`,
    );
  }
  return months;
}

/**
 * Minimal queryable interface satisfied by both `pg.Pool` and `pg.PoolClient`.
 * Used so the (c) parse-fail integration test can run the read on a single
 * client inside a transaction (where the `COMMENT ON COLUMN ... IS NULL`
 * change is visible) without an unsafe cross-type cast.
 */
export interface QueryRunner {
  query<R extends import('pg').QueryResultRow = import('pg').QueryResultRow>(
    queryTextOrConfig: string,
    values?: readonly unknown[],
  ): Promise<import('pg').QueryResult<R>>;
}

/**
 * Read the column comment from Postgres and return the parsed months.
 *
 * Throws (via `parseRetentionMonthsFromComment`) on missing / unparseable
 * comment. Throws on Postgres query errors as well — the boot caller routes
 * either failure mode through `flushAndExit()`.
 */
export async function readRetentionMonths(runner: QueryRunner): Promise<number> {
  const { rows } = await runner.query<{ comment: string | null }>(COMMENT_QUERY);
  if (rows.length === 0) {
    throw new Error(
      'custody_audit_log.user_agent column is missing from the database. ' +
      'Migration 005_custody_audit_consent_ops.sql must run before boot.',
    );
  }
  return parseRetentionMonthsFromComment(rows[0].comment);
}

/**
 * Run a single sweep pass. Reads the SOT comment, parses retention months,
 * and deletes rows older than that window. Returns the parsed months and the
 * deleted row count for tests / callers that need it.
 *
 * The first call after deploy naturally drops all pre-existing rows older
 * than the retention period in a single DELETE — no separate backfill code
 * is needed (acceptance #3).
 */
export async function runSweep(
  pool: pg.Pool,
): Promise<{ deletedRows: number; retentionMonths: number }> {
  const retentionMonths = await readRetentionMonths(pool);
  // Parameterising `INTERVAL` as a string literal is the safest cross-driver
  // shape; pg supports `$1::interval` but the SOT is integer months and we've
  // already validated it's a positive finite integer above, so concatenation
  // is safe (no SQL-injection surface: the value came from a parsed digit run).
  const { rowCount } = await pool.query(
    `DELETE FROM custody_audit_log WHERE created_at < now() - ($1::int * INTERVAL '1 month')`,
    [retentionMonths],
  );
  return { deletedRows: rowCount ?? 0, retentionMonths };
}

/**
 * Wire the retention sweep at boot.
 *
 * Flow:
 *   1. Run a sweep pass immediately. Parse failure here is BOOT-FATAL —
 *      logs a `fatal` line and calls `flushAndExit()` so the bad-config
 *      doesn't silently become indefinite retention.
 *   2. Schedule a 24h `setInterval` tick. The timer is `.unref()`d so it
 *      doesn't keep the event loop alive past graceful shutdown.
 *
 * Per memory `feedback_pevo_logging_minimal`: no info-level log on success.
 * Operators infer health via existing healthchecks; per-tick logs would
 * add log volume without catching a concrete failure mode.
 */
export async function startRetentionSweep(pool: pg.Pool | null): Promise<void> {
  if (!pool) {
    // Mirrors `signup-cleanup.cleanupExpiredSignups`: when APP_DATABASE_URL
    // is unset (rare dev configuration), the sweep is a no-op. Production
    // always configures APP_DATABASE_URL and initAppDb() warns at that point.
    return;
  }
  try {
    await runSweep(pool);
  } catch (err) {
    logger.fatal(
      { err },
      'custody-audit retention sweep boot-fatal — refusing to start. ' +
      'GDPR Art. 5(1)(e) requires mechanical enforcement of the retention ' +
      'window documented in migration 006. See ' +
      'agents/docs/tasks/* BACKEND-CUSTODY-AUDIT-RETENTION-SWEEP.',
    );
    flushAndExit();
    // Defensive: flushAndExit triggers an async process.exit; bail out so
    // we don't schedule a setInterval on the way down.
    return;
  }
  sweepTimer = setInterval(() => {
    runSweep(pool).catch((err) => {
      // Runtime DELETE failures are NOT boot-fatal — a transient pool error
      // or statement-timeout shouldn't crash the backend. Surface as `error`
      // so operators see it; next tick retries.
      logger.error({ err }, 'custody-audit retention sweep tick failed');
    });
  }, SWEEP_INTERVAL_MS);
  sweepTimer.unref();
}

/**
 * Cancel the periodic sweep timer. Called from the SIGTERM/SIGINT shutdown
 * path so the timer doesn't keep the event loop alive during graceful drain.
 */
export function stopRetentionSweep(): void {
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
}
