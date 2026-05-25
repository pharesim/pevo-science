/**
 * Migration 007 (accounts_orcid_unique) — real-Postgres integration tests.
 *
 * Coverage:
 *   (a) The partial unique index exists on the live test DB with the expected
 *       predicate (WHERE orcid IS NOT NULL).
 *   (b) A second row with the same non-null ORCID is rejected at the DB layer
 *       with SQLSTATE 23505 (unique_violation), regardless of the route-layer
 *       HAF cross-check. This is the defense-in-depth contract the migration
 *       exists to enforce.
 *   (c) Multiple rows with NULL ORCID are allowed (the partial WHERE clause
 *       excludes them from the uniqueness check).
 *   (d) The migration's pre-CREATE-INDEX backfill scan fails loud (raises an
 *       exception, transaction rolls back, index not created) when run against
 *       a schema state that already contains duplicate non-null ORCIDs. This
 *       is the surface-or-fail behaviour acceptance criterion 4 of the task
 *       requires. This sub-test also pins that the RAISE EXCEPTION reports the
 *       TRUE (uncapped) duplicate-group count, not the LIMIT-50 sample cap:
 *       it seeds 51+ distinct duplicate ORCIDs and asserts the count phrasing
 *       carries the real magnitude (>= 51). Reverting the migration to the
 *       single capped-COUNT query makes that assertion report 50 and flip RED.
 *
 * Mock-carve-out: none. All assertions run against real Postgres via the
 * shared `getAppPool()` test connection. The migration body is loaded from
 * `backend/migrations/007_accounts_orcid_unique.sql` and applied inside a
 * SAVEPOINT-bracketed transaction so the duplicate-detection branch can be
 * exercised without permanently corrupting the test DB schema.
 *
 * Real-DB-required guard: `describe.skipIf(!dbReachable)` mirrors the
 * pattern in `tests/jobs/custody-audit-retention-sweep.test.ts` and
 * `tests/routes/recover.test.ts`. CI without Postgres skips the suite
 * cleanly rather than failing for the wrong reason.
 *
 * Schema prerequisite: migration 007 must already be applied to the live
 * test DB for sub-tests (a)/(b)/(c). The (d) sub-test reproduces the
 * pre-application state inside a transaction (drops the index, seeds a
 * duplicate, runs the migration body, asserts failure, rolls back). The
 * rollback restores the original schema state so subsequent tests in the
 * file or other files in the suite see the index intact.
 */

import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAppPool } from '../../src/app-db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATION_PATH = join(__dirname, '../../migrations/007_accounts_orcid_unique.sql');
const MIGRATION_SQL = readFileSync(MIGRATION_PATH, 'utf8');

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

// Sentinel value scoped to this test run; row inserts and cleanup query
// against this prefix so concurrent test files using the same accounts table
// (signup-verify, custody-upgrade, recover) cannot interfere with this
// suite's assertions.
const RUN_ID = Date.now();
const EMAIL_PREFIX = `orcid_unique_${RUN_ID}_`;

async function cleanup() {
  if (!dbReachable) return;
  const pool = getAppPool()!;
  await pool.query('DELETE FROM accounts WHERE email LIKE $1', [`${EMAIL_PREFIX}%`]);
}

describe.skipIf(!dbReachable)('migration 007 — accounts_orcid_unique', () => {
  beforeAll(async () => {
    await cleanup();
  });

  afterEach(async () => {
    await cleanup();
  });

  it('the partial unique index exists with WHERE orcid IS NOT NULL predicate', async () => {
    const pool = getAppPool()!;
    const result = await pool.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes
       WHERE schemaname = 'public'
         AND tablename = 'accounts'
         AND indexname = 'accounts_orcid_unique'`,
    );
    expect(result.rows.length).toBe(1);
    // Predicate must match the partial WHERE clause. Without the WHERE,
    // the constraint would forbid more than one NULL-ORCID row, which
    // would break light-account signup (every signup creates a row with
    // orcid=NULL until /accredit or /link runs).
    expect(result.rows[0].indexdef).toMatch(/UNIQUE INDEX accounts_orcid_unique/);
    expect(result.rows[0].indexdef).toMatch(/WHERE \(orcid IS NOT NULL\)/);
  });

  it('rejects a second row carrying the same non-null ORCID with SQLSTATE 23505', async () => {
    const pool = getAppPool()!;
    const sharedOrcid = `0000-0000-0000-${(RUN_ID % 10000).toString().padStart(4, '0')}`;
    await pool.query(
      `INSERT INTO accounts (email, orcid) VALUES ($1, $2)`,
      [`${EMAIL_PREFIX}first@example.com`, sharedOrcid],
    );
    let caught: unknown;
    try {
      await pool.query(
        `INSERT INTO accounts (email, orcid) VALUES ($1, $2)`,
        [`${EMAIL_PREFIX}second@example.com`, sharedOrcid],
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    expect((caught as Error & { code?: string }).code).toBe('23505');
    // The constraint name appears in the error message so route-layer
    // discrimination on the constraint anchor stays load-bearing.
    expect((caught as Error).message).toMatch(/accounts_orcid_unique/);
  });

  it('allows multiple rows with NULL orcid (partial predicate excludes them)', async () => {
    const pool = getAppPool()!;
    // Two light-account signups before either runs /accredit or /link.
    // The partial-index WHERE clause is what makes this safe; without it
    // the second insert would fail SQLSTATE 23505 and block the entire
    // light-account onboarding flow.
    await pool.query(
      `INSERT INTO accounts (email, orcid) VALUES ($1, NULL)`,
      [`${EMAIL_PREFIX}nullA@example.com`],
    );
    await pool.query(
      `INSERT INTO accounts (email, orcid) VALUES ($1, NULL)`,
      [`${EMAIL_PREFIX}nullB@example.com`],
    );
    const result = await pool.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM accounts WHERE email LIKE $1 AND orcid IS NULL`,
      [`${EMAIL_PREFIX}null%`],
    );
    expect(result.rows[0].n).toBe(2);
  });

  it('allows the same account to be UPDATEd to the same ORCID it already holds (self-bind reflexive)', async () => {
    const pool = getAppPool()!;
    const orcid = `0001-0001-0001-${(RUN_ID % 10000).toString().padStart(4, '0')}`;
    await pool.query(
      `INSERT INTO accounts (email, orcid, username) VALUES ($1, $2, $3)`,
      [`${EMAIL_PREFIX}selfbind@example.com`, orcid, `selfbind_${RUN_ID}`],
    );
    // Re-binding the same ORCID to the same row must not trip the unique
    // constraint. PostgreSQL excludes the row being updated from the
    // uniqueness check on no-op updates, so this is a true smoke test of
    // the contract (rather than a tautology). Models the /link re-call
    // path where a user re-runs the same ORCID OAuth flow against an
    // already-linked account.
    await expect(
      pool.query(
        `UPDATE accounts SET orcid = $1 WHERE email = $2`,
        [orcid, `${EMAIL_PREFIX}selfbind@example.com`],
      ),
    ).resolves.toBeDefined();
  });

  it('migration body fails loud with RAISE EXCEPTION reporting the TRUE (uncapped) duplicate count', async () => {
    const pool = getAppPool()!;
    // Seed more than the LIMIT-50 sample cap of distinct duplicate-ORCID
    // groups so this test pins that the RAISE reports the true magnitude
    // rather than the capped sample size. The migration computes dup_count
    // from an uncapped COUNT(*) over the GROUP BY ... HAVING COUNT(*) > 1 set
    // and only the sample string is LIMIT-50 capped.
    // Reverting to the single capped query (LIMIT 50 feeding the outer
    // COUNT(*)) makes this report 50 and flip RED.
    const DUP_GROUP_COUNT = 51;
    // The first group's ORCID is asserted to appear in the sample message;
    // since the sample is ORDER BY orcid and capped at 50, use a low-sorting
    // ORCID so it lands inside the first-50 window deterministically. The
    // third segment is `0000` so it cannot collide with the loop-generated
    // groups below (which use the 1-based index `0001`..`00NN` there); a
    // collision would merge two groups and under-count the seeded total.
    const sampledOrcid = `0002-0002-0000-${(RUN_ID % 10000).toString().padStart(4, '0')}`;
    // Use a single connection for the entire reproduction so SAVEPOINT and
    // ROLLBACK TO SAVEPOINT bracket the same session. Without `pool.connect`
    // each pool.query may pick a different connection and the savepoint is
    // unobservable to subsequent statements.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      try {
        // Reproduce the pre-application schema state (no unique index)
        // inside the transaction so the migration body's CREATE UNIQUE
        // INDEX has work to do AND the DO block's duplicate scan finds
        // something to RAISE on.
        await client.query('DROP INDEX IF EXISTS accounts_orcid_unique');
        // Seed DUP_GROUP_COUNT distinct duplicate ORCIDs, each as a pair of
        // rows, so the true duplicate-group count is DUP_GROUP_COUNT (> 50).
        for (let i = 0; i < DUP_GROUP_COUNT; i++) {
          // Zero-pad the group index into the trailing block so all ORCIDs are
          // distinct and well-ordered. The first group reuses sampledOrcid.
          const groupOrcid =
            i === 0
              ? sampledOrcid
              : `0002-0002-${i.toString().padStart(4, '0')}-${(RUN_ID % 10000).toString().padStart(4, '0')}`;
          await client.query(
            `INSERT INTO accounts (email, orcid) VALUES ($1, $2)`,
            [`${EMAIL_PREFIX}dup${i}a@example.com`, groupOrcid],
          );
          await client.query(
            `INSERT INTO accounts (email, orcid) VALUES ($1, $2)`,
            [`${EMAIL_PREFIX}dup${i}b@example.com`, groupOrcid],
          );
        }
        let caught: unknown;
        try {
          await client.query(MIGRATION_SQL);
        } catch (err) {
          caught = err;
        }
        expect(caught).toBeDefined();
        // The DO block's RAISE EXCEPTION message includes the duplicate
        // count and a sample line. Operators rely on the count to know how
        // many ORCIDs to resolve and the sample to know which ones, so the
        // test pins the true (uncapped) count, the count phrasing, and the
        // first ORCID's presence in the (capped) sample.
        const errMsg = (caught as Error).message;
        expect(errMsg).toMatch(/duplicate ORCID/i);
        // True magnitude: the migration must report DUP_GROUP_COUNT, NOT the
        // LIMIT-50 sample cap. Parse the leading integer the RAISE emits
        // ("... <N> duplicate ORCID(s) found ...") and assert it equals the
        // seeded group count. Mutation-kill: capped-COUNT form reports 50.
        const reportedCount = Number(/(\d+) duplicate ORCID/i.exec(errMsg)?.[1]);
        expect(reportedCount).toBe(DUP_GROUP_COUNT);
        expect(reportedCount).toBeGreaterThan(50);
        expect(errMsg).toContain(sampledOrcid);
      } finally {
        // ROLLBACK restores the original schema state (DROP INDEX is
        // reverted, the duplicate rows disappear) so subsequent tests in
        // this file and other files in the suite see the index intact.
        await client.query('ROLLBACK');
      }
    } finally {
      client.release();
    }
    // Post-rollback sanity check: the index must still exist (the
    // ROLLBACK reverted the DROP INDEX issued at the top of the
    // transaction). A failure here means the test corrupted the test DB
    // schema and would cascade-fail every other suite that depends on
    // the unique constraint.
    const idxAfter = await pool.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM pg_indexes
       WHERE schemaname = 'public'
         AND tablename = 'accounts'
         AND indexname = 'accounts_orcid_unique'`,
    );
    expect(idxAfter.rows[0].n).toBe(1);
  });
});
