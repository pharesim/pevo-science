/**
 * BACKEND-CUSTODY-AUDIT-RETENTION-SWEEP — real-Postgres integration tests for
 * `src/jobs/custody-audit-retention-sweep.ts`.
 *
 * Coverage (real-DB):
 *   (a) Rows newer than the retention window survive a sweep pass.
 *   (b) Rows older than the retention window are deleted.
 *   (c) The SOT-from-COMMENT parse fails loud on missing / malformed comment.
 *       The hold sub-test temporarily clears the column comment inside a
 *       transaction, asserts `readRetentionMonths` throws, then rolls back.
 *
 * All assertions run against real Postgres per project test policy. The
 * boot-fatal `flushAndExit()` path is NOT exercised here — we factor the
 * parse into pure functions (`parseRetentionMonthsFromComment`,
 * `readRetentionMonths`) so the test asserts the throw directly without
 * mocking `process.exit` / `logger.flush`. The boot caller wraps the throw
 * in `flushAndExit()` (see `startRetentionSweep` in
 * `src/jobs/custody-audit-retention-sweep.ts`), and that watchdog/flush
 * shape is exhaustively covered at the helper level in
 * `tests/lib/flush-and-exit.test.ts`. The integration here pins the
 * input-side contract: parse-fail throws cleanly so the boot caller's
 * outer try/catch can route to `flushAndExit()`.
 *
 * Real-DB-required guard: `describe.skipIf(!dbReachable)` mirrors the
 * pattern in `tests/routes/custody-consent-ops.test.ts`. CI without
 * Postgres skips the suite rather than failing.
 *
 * Schema prerequisite: migration 006 must be applied — it writes the
 * `COMMENT ON COLUMN custody_audit_log.user_agent` annotation that
 * carries the retention SOT. `deploy.sh test-db-up` runs every migration
 * against `pevo_app_test`, so this is a no-op in the standard test path.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { getAppPool } from '../../src/app-db.js';
import {
  parseRetentionMonthsFromComment,
  readRetentionMonths,
  runSweep,
} from '../../src/jobs/custody-audit-retention-sweep.js';

let dbReachable = false;
{
  const pool = getAppPool();
  if (pool) {
    try {
      await pool.query('SELECT 1');
      dbReachable = true;
    } catch {
      dbReachable = false;
    }
  }
}

// Sentinel value scoped to this test run; cleanup deletes rows by this prefix
// so concurrent test files using the same custody_audit_log table do not
// interfere with this suite's assertions.
const RUN_ID = Date.now();
const USERNAME_PREFIX = `retsweep_${RUN_ID}_`;
const USER_OLD = `${USERNAME_PREFIX}old`;
const USER_FRESH = `${USERNAME_PREFIX}fresh`;

describe('parseRetentionMonthsFromComment — pure parse contract (no DB)', () => {
  it('parses "Retention: 24 months from row insert"', () => {
    expect(parseRetentionMonthsFromComment('Foo. Retention: 24 months from row insert. Bar.')).toBe(24);
  });

  it('parses "Retention period: 36 months" wording variant', () => {
    expect(parseRetentionMonthsFromComment('Retention period: 36 months')).toBe(36);
  });

  it('is case-insensitive on the "Retention" key', () => {
    expect(parseRetentionMonthsFromComment('retention: 12 months')).toBe(12);
  });

  it('throws on null', () => {
    expect(() => parseRetentionMonthsFromComment(null)).toThrow(/missing or empty/i);
  });

  it('throws on empty / whitespace-only', () => {
    expect(() => parseRetentionMonthsFromComment('')).toThrow(/missing or empty/i);
    expect(() => parseRetentionMonthsFromComment('   \n  ')).toThrow(/missing or empty/i);
  });

  it('throws on comment present but missing the retention line', () => {
    expect(() =>
      parseRetentionMonthsFromComment('PII (GDPR). Legal basis: Art. 6(1)(f). No retention info here.'),
    ).toThrow(/parseable "Retention/);
  });

  it('throws on zero / negative retention', () => {
    expect(() => parseRetentionMonthsFromComment('Retention: 0 months')).toThrow(/non-positive/);
  });
});

describe.skipIf(!dbReachable)('custody-audit retention sweep — real Postgres integration', () => {
  beforeAll(async () => {
    if (!dbReachable) return;
    const pool = getAppPool()!;
    // Defensive cleanup in case a prior aborted run left rows behind.
    await pool.query('DELETE FROM custody_audit_log WHERE username LIKE $1', [`${USERNAME_PREFIX}%`]);
  });

  afterAll(async () => {
    if (!dbReachable) return;
    const pool = getAppPool()!;
    await pool.query('DELETE FROM custody_audit_log WHERE username LIKE $1', [`${USERNAME_PREFIX}%`]);
  });

  beforeEach(async () => {
    if (!dbReachable) return;
    const pool = getAppPool()!;
    await pool.query('DELETE FROM custody_audit_log WHERE username LIKE $1', [`${USERNAME_PREFIX}%`]);
  });

  it('reads the retention months from the live column comment (matches migration 006 SOT)', async () => {
    const pool = getAppPool()!;
    const months = await readRetentionMonths(pool);
    // Migration 006 currently documents 24 months. The assertion is range-
    // bounded rather than equality-pinned to absorb a future policy change
    // (e.g., migration 007 dropping to 12 months) without forcing a test
    // edit — the test's job is to verify the read+parse contract, not to
    // re-assert the policy value. The migration comment is the SOT.
    expect(months).toBeGreaterThanOrEqual(1);
    expect(months).toBeLessThanOrEqual(120);
    expect(Number.isInteger(months)).toBe(true);
  });

  it('(a) rows newer than the retention window survive (b) rows older are deleted', async () => {
    const pool = getAppPool()!;
    const retentionMonths = await readRetentionMonths(pool);

    // Seed two audit rows: one with a created_at well INSIDE the window
    // (1 day old → survives), one with a created_at well OUTSIDE the window
    // (retention + 1 month old → deleted). Insert with explicit created_at
    // since the default NOW() doesn't let us synthesise old rows.
    await pool.query(
      `INSERT INTO custody_audit_log (username, operation_type, created_at)
       VALUES ($1, 'email_deleted', NOW() - INTERVAL '1 day')`,
      [USER_FRESH],
    );
    await pool.query(
      `INSERT INTO custody_audit_log (username, operation_type, created_at)
       VALUES ($1, 'email_deleted', NOW() - ($2::int * INTERVAL '1 month') - INTERVAL '1 day')`,
      [USER_OLD, retentionMonths],
    );

    // Sanity: both rows are present pre-sweep.
    const before = await pool.query<{ username: string }>(
      'SELECT username FROM custody_audit_log WHERE username LIKE $1 ORDER BY username',
      [`${USERNAME_PREFIX}%`],
    );
    expect(before.rows.map((r) => r.username).sort()).toEqual([USER_FRESH, USER_OLD]);

    const result = await runSweep(pool);
    expect(result.retentionMonths).toBe(retentionMonths);
    expect(result.deletedRows).toBeGreaterThanOrEqual(1);

    const after = await pool.query<{ username: string }>(
      'SELECT username FROM custody_audit_log WHERE username LIKE $1 ORDER BY username',
      [`${USERNAME_PREFIX}%`],
    );
    const remaining = after.rows.map((r) => r.username);
    expect(remaining).toContain(USER_FRESH);
    expect(remaining).not.toContain(USER_OLD);
  });

  it('(c) SOT-from-COMMENT parse fails loud when the column comment is missing', async () => {
    const pool = getAppPool()!;
    // Temporarily clear the column comment inside a transaction, then roll
    // back so the production SOT is preserved for other tests / the live DB.
    // `COMMENT ON COLUMN ... IS NULL` is the canonical "remove comment"
    // shape per Postgres docs.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('COMMENT ON COLUMN custody_audit_log.user_agent IS NULL');
      await expect(readRetentionMonths(client)).rejects.toThrow(/missing or empty/i);
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }

    // Post-rollback: the live comment is restored, so a follow-up read
    // succeeds. This pins that the transactional clear didn't leak into the
    // live DB (a regression here would silently strip the SOT in production).
    const months = await readRetentionMonths(pool);
    expect(months).toBeGreaterThanOrEqual(1);
  });

  it('(c) SOT-from-COMMENT parse fails loud when the column comment is present but malformed', async () => {
    const pool = getAppPool()!;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        "COMMENT ON COLUMN custody_audit_log.user_agent IS 'PII placeholder with no retention line'",
      );
      await expect(readRetentionMonths(client)).rejects.toThrow(/parseable "Retention/);
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });
});
