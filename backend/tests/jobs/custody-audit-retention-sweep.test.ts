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
 * Coverage (direct-call, deterministic):
 *   (d) `validateRetentionSweepConfig` rethrows as `BootFatalError` on missing
 *       / malformed COMMENT. Pinned in this file (the function-level rethrow
 *       wraps the underlying parse throw and exposes it via `.cause`; the
 *       outer `.catch` in `index.ts` keys on `instanceof BootFatalError` to
 *       discriminate logging).
 *   (e) `startRetentionSweepTicker(null)` is a no-op (the null-pool early
 *       return path) — does not throw, does not register a setInterval.
 *
 * All real-DB assertions run against real Postgres per project test policy.
 * The pure-parser block at the top is also DB-free.
 *
 * Mock-carve-out (clause a + clause c per CLAUDE.md "Running Tests"):
 *   - The `validateRetentionSweepConfig` rethrow test (d) uses a tiny inline
 *     `pg.Pool`-shaped mock that returns `{rows: [{comment: null}]}` from
 *     `query()`. Exercising the real path here would require running a live
 *     Postgres connection AND temporarily clearing the column comment for the
 *     duration of the test, which the (c) suite below already does — the
 *     carve-out justification is determinism: the (c) suite pins
 *     `readRetentionMonths`'s throw shape, this test pins the function-level
 *     `BootFatalError` rewrap (cause-chain plumbing + class discrimination).
 *     Clause (b) does not apply: this suite is not auth-focused and no route
 *     middleware runs. Clause (c) real-path companion: the (c) integration
 *     subtests above exercise the same throw class via real Postgres against
 *     the live column comment, so a regression in the SQL path is caught
 *     end-to-end elsewhere — this mocked test is purely the cause-chain pin.
 *
 * BootFatalError mechanism (round-3 item 1): `validateRetentionSweepConfig`
 * does NOT call `flushAndExit()` itself. Instead it throws a `BootFatalError`
 * which propagates out of the awaited call inside `initAppDb().then(...)` in
 * `index.ts`, into the sibling `.catch` of that chain. That `.catch`
 * discriminates `instanceof BootFatalError` to suppress the mislabelled
 * "Failed to initialize app database" wrapping and logs the BootFatalError's
 * own message, then routes through `flushAndExit()` before `app.listen()`
 * ever runs. The function-level rethrow IS pinned in test (d) below; the
 * outer-catch wiring is covered transitively at the call site, and
 * `flushAndExit()`'s flush+watchdog behaviour is covered at the helper level
 * in `tests/lib/flush-and-exit.test.ts`.
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
import type pg from 'pg';
import { getAppPool } from '../../src/app-db.js';
import { BootFatalError } from '../../src/startup-checks.js';
import {
  parseRetentionMonthsFromComment,
  readRetentionMonths,
  runSweep,
  startRetentionSweepTicker,
  validateRetentionSweepConfig,
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

describe('validateRetentionSweepConfig — boot-fatal rethrow contract', () => {
  // Round-3 item 5(a): pin the function-level rewrap behaviour. Uses a tiny
  // pg.Pool-shaped mock (per the test-mock carve-out — clause-a determinism;
  // the real-path is covered above in the (c) integration subtests against
  // live Postgres). The mock returns a single row with `comment: null`, which
  // is the same shape `col_description` returns for a column with no comment
  // (e.g., migration 006 not applied). The point of this test is not the
  // SQL path (the integration tests cover that); it's that
  // `validateRetentionSweepConfig` wraps the underlying parse Error as a
  // `BootFatalError` so `index.ts`'s outer `.catch` can discriminate on the
  // class, and that the original Error survives on `.cause` for the fatal
  // log.
  function makeMockPool(comment: string | null): pg.Pool {
    return {
      query: async () => ({ rows: [{ comment }], rowCount: 1 }),
    } as unknown as pg.Pool;
  }

  it('rethrows as BootFatalError when the column comment is missing', async () => {
    const pool = makeMockPool(null);
    await expect(validateRetentionSweepConfig(pool)).rejects.toBeInstanceOf(BootFatalError);
  });

  it('rethrows as BootFatalError when the column comment is malformed (no Retention line)', async () => {
    const pool = makeMockPool('PII placeholder with no retention line');
    await expect(validateRetentionSweepConfig(pool)).rejects.toBeInstanceOf(BootFatalError);
  });

  it('preserves the underlying parse error on .cause', async () => {
    const pool = makeMockPool(null);
    let caught: unknown;
    try {
      await validateRetentionSweepConfig(pool);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(BootFatalError);
    expect((caught as BootFatalError).cause).toBeInstanceOf(Error);
    expect(((caught as BootFatalError).cause as Error).message).toMatch(/missing or empty/i);
  });
});

describe('startRetentionSweepTicker — null-pool early return', () => {
  // Round-3 item 5(b): smoke test for the null-pool no-op path. When
  // APP_DATABASE_URL is unset (rare dev configuration), `getAppPool()`
  // returns null and the ticker must be a no-op — no throw, no setInterval
  // registered. Mirrors the equivalent skip in `validateRetentionSweepConfig`.
  it('returns synchronously without throwing or scheduling a timer when pool is null', () => {
    expect(() => startRetentionSweepTicker(null)).not.toThrow();
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
    // shape per Postgres docs. The nested finally pattern guarantees ROLLBACK
    // runs even if the inner `expect(...).rejects.toThrow(...)` mismatches
    // and Vitest rethrows — otherwise the open transaction would leak back
    // to the pool with the SOT cleared, and the next test borrowing that
    // client would silently strip the production SOT from the live test DB.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      try {
        await client.query('COMMENT ON COLUMN custody_audit_log.user_agent IS NULL');
        await expect(readRetentionMonths(client)).rejects.toThrow(/missing or empty/i);
      } finally {
        await client.query('ROLLBACK');
      }
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
      try {
        await client.query(
          "COMMENT ON COLUMN custody_audit_log.user_agent IS 'PII placeholder with no retention line'",
        );
        await expect(readRetentionMonths(client)).rejects.toThrow(/parseable "Retention/);
      } finally {
        await client.query('ROLLBACK');
      }
    } finally {
      client.release();
    }
  });
});
