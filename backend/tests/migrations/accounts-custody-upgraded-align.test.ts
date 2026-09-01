/**
 * Migration 017 (accounts_custody_upgraded_align) — real-Postgres integration
 * tests.
 *
 * Coverage:
 *   (a) The CHECK constraint exists on the live test DB with the expected
 *       one-directional predicate (`upgraded_at IS NULL OR custody = 'self'`).
 *   (b) The row shape `(custody = 'light', upgraded_at NOT NULL)` is refused
 *       at the DB layer with SQLSTATE 23514 (check_violation), both as an
 *       INSERT and as an UPDATE that stamps the epoch on a light row without
 *       flipping the column. This is the shape the pre-fix upgrade route used
 *       to produce and the one ARCHITECTURE.md § 6.1 does not enumerate.
 *   (c) Every enumerated shape is still accepted: A/B/C (`light`, no epoch),
 *       D (`self`, epoch), E/F (NULL column, no epoch).
 *   (d) The back-fill repairs pre-existing divergent rows. Run against a
 *       schema state reproduced inside a transaction (constraint dropped,
 *       divergent rows seeded), the migration body flips every epoch-bearing
 *       row to `custody = 'self'`, leaves rows without an epoch alone, leaves
 *       `updated_at` untouched (it is the `/link` stuck-recovery recency
 *       marker; bumping it would re-open that window), and re-creates the
 *       constraint. The migration body is applied through the same SQL file
 *       `deploy.sh migrate` runs, so the test exercises the shipped artifact.
 *
 * Mock carve-out: none. All assertions run against real Postgres via the
 * shared `getAppPool()` test connection. The migration body is loaded from
 * `backend/migrations/017_accounts_custody_upgraded_align.sql` and applied
 * inside a transaction that is rolled back, so the back-fill leg can be
 * exercised without permanently changing the test DB schema.
 *
 * Real-DB-required guard: `describe.skipIf(!dbReachable)` mirrors the pattern
 * in `tests/migrations/accounts-orcid-unique.test.ts`. CI without Postgres
 * skips the suite cleanly rather than failing for the wrong reason.
 *
 * Schema prerequisite: migration 017 must already be applied to the live test
 * DB for sub-tests (a)/(b)/(c). Sub-test (d) reproduces the pre-application
 * state inside its transaction and rolls back, restoring the constraint for
 * every other test in the suite.
 */

import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAppPool } from '../../src/app-db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATION_PATH = join(__dirname, '../../migrations/017_accounts_custody_upgraded_align.sql');
const MIGRATION_SQL = readFileSync(MIGRATION_PATH, 'utf8');

const CONSTRAINT = 'accounts_upgraded_implies_self_custody';

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
// cannot interfere with this suite's assertions.
const RUN_ID = Date.now();
const EMAIL_PREFIX = `custody_align_${RUN_ID}_`;
const USER_PREFIX = `custalign${RUN_ID}`;

async function cleanup() {
  if (!dbReachable) return;
  const pool = getAppPool()!;
  await pool.query('DELETE FROM accounts WHERE email LIKE $1', [`${EMAIL_PREFIX}%`]);
}

async function constraintDef(): Promise<string | null> {
  const pool = getAppPool()!;
  const result = await pool.query<{ def: string }>(
    `SELECT pg_get_constraintdef(oid) AS def
     FROM pg_constraint
     WHERE conname = $1 AND conrelid = 'public.accounts'::regclass`,
    [CONSTRAINT],
  );
  return result.rows[0]?.def ?? null;
}

describe.skipIf(!dbReachable)('migration 017 — accounts_custody_upgraded_align', () => {
  beforeAll(async () => {
    await cleanup();
  });

  afterEach(async () => {
    await cleanup();
  });

  it('the CHECK constraint exists with the one-directional predicate', async () => {
    const def = await constraintDef();
    expect(def).not.toBeNull();
    // Direction matters: an epoch must imply self-custody, but the constraint
    // must NOT require an epoch for `custody = 'self'` (that direction is not
    // load-bearing for any reader and would fail the migration on a
    // pre-existing row of that shape for no safety gain).
    expect(def).toMatch(/CHECK/);
    expect(def).toMatch(/upgraded_at IS NULL/);
    expect(def).toMatch(/custody\s*=\s*'self'/);
    expect(def).toMatch(/\bOR\b/);
  });

  it('refuses INSERT of (custody = light, upgraded_at set) with SQLSTATE 23514', async () => {
    const pool = getAppPool()!;
    let caught: unknown;
    try {
      await pool.query(
        `INSERT INTO accounts (email, username, custody, upgraded_at)
         VALUES ($1, $2, 'light', NOW())`,
        [`${EMAIL_PREFIX}ins@example.com`, `${USER_PREFIX}ins`],
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    expect((caught as Error & { code?: string }).code).toBe('23514');
    expect((caught as Error).message).toMatch(new RegExp(CONSTRAINT));
  });

  it('refuses an UPDATE that stamps upgraded_at on a light row without flipping custody', async () => {
    // The exact statement shape the pre-fix upgrade route issued: keys nulled,
    // epoch stamped, column untouched. A future edit that drops the column
    // write from that SET list now fails here instead of leaving a divergent
    // row for the session mints to read.
    const pool = getAppPool()!;
    await pool.query(
      `INSERT INTO accounts (email, username, custody, upgraded_at)
       VALUES ($1, $2, 'light', NULL)`,
      [`${EMAIL_PREFIX}upd@example.com`, `${USER_PREFIX}upd`],
    );
    let caught: unknown;
    try {
      await pool.query(
        `UPDATE accounts
         SET posting_key_enc = NULL, iv_posting = NULL,
             memo_key_enc = NULL, iv_memo = NULL,
             upgraded_at = NOW()
         WHERE username = $1`,
        [`${USER_PREFIX}upd`],
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    expect((caught as Error & { code?: string }).code).toBe('23514');
    // The refused statement must not have moved the row.
    const after = await pool.query<{ custody: string | null; upgraded_at: Date | null }>(
      'SELECT custody, upgraded_at FROM accounts WHERE username = $1',
      [`${USER_PREFIX}upd`],
    );
    expect(after.rows[0]).toEqual({ custody: 'light', upgraded_at: null });
  });

  it('accepts every enumerated shape: A/B/C, D, and the pre-finalize NULL column', async () => {
    const pool = getAppPool()!;
    // A/B/C: light, no epoch.
    await expect(
      pool.query(
        `INSERT INTO accounts (email, username, custody, upgraded_at) VALUES ($1, $2, 'light', NULL)`,
        [`${EMAIL_PREFIX}abc@example.com`, `${USER_PREFIX}abc`],
      ),
    ).resolves.toBeDefined();
    // D: self, epoch. Both the upgrade route and the /link finalize write
    // this shape in one statement.
    await expect(
      pool.query(
        `INSERT INTO accounts (email, username, custody, upgraded_at) VALUES ($1, $2, 'self', NOW())`,
        [`${EMAIL_PREFIX}d@example.com`, `${USER_PREFIX}d`],
      ),
    ).resolves.toBeDefined();
    // E/F: column NULL before finalize, no epoch.
    await expect(
      pool.query(
        `INSERT INTO accounts (email, custody, upgraded_at) VALUES ($1, NULL, NULL)`,
        [`${EMAIL_PREFIX}ef@example.com`],
      ),
    ).resolves.toBeDefined();
    // The atomic light-to-self transition the upgrade route performs.
    await expect(
      pool.query(
        `UPDATE accounts SET custody = 'self', upgraded_at = NOW() WHERE username = $1`,
        [`${USER_PREFIX}abc`],
      ),
    ).resolves.toBeDefined();
  });

  it('the back-fill flips every epoch-bearing row to self, leaves the rest alone, and re-creates the constraint', async () => {
    const pool = getAppPool()!;
    // Use a single connection so the DROP, the seeds, the migration body, and
    // the ROLLBACK all bracket one transaction; separate pool.query calls may
    // land on different connections and the uncommitted state would be
    // invisible to the migration.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      try {
        // Reproduce the pre-application schema: no constraint, so the
        // divergent rows the old upgrade route produced can be seeded.
        await client.query(`ALTER TABLE accounts DROP CONSTRAINT ${CONSTRAINT}`);
        // The shape the old route left behind: light + epoch, keys nulled,
        // updated_at well outside the /link stuck-recovery window.
        await client.query(
          `INSERT INTO accounts (email, username, custody, upgraded_at, updated_at)
           VALUES ($1, $2, 'light', NOW() - INTERVAL '30 days', NOW() - INTERVAL '2 days')`,
          [`${EMAIL_PREFIX}bf_light@example.com`, `${USER_PREFIX}bflight`],
        );
        // Not enumerated either, but repaired rather than aborted on: a NULL
        // column carrying an epoch.
        await client.query(
          `INSERT INTO accounts (email, username, custody, upgraded_at, updated_at)
           VALUES ($1, $2, NULL, NOW() - INTERVAL '30 days', NOW() - INTERVAL '2 days')`,
          [`${EMAIL_PREFIX}bf_null@example.com`, `${USER_PREFIX}bfnull`],
        );
        // Controls the back-fill must not touch: a light row with no epoch,
        // and an already-correct state-D row.
        await client.query(
          `INSERT INTO accounts (email, username, custody, upgraded_at, updated_at)
           VALUES ($1, $2, 'light', NULL, NOW() - INTERVAL '2 days')`,
          [`${EMAIL_PREFIX}bf_ctrl@example.com`, `${USER_PREFIX}bfctrl`],
        );
        await client.query(
          `INSERT INTO accounts (email, username, custody, upgraded_at, updated_at)
           VALUES ($1, $2, 'self', NOW() - INTERVAL '30 days', NOW() - INTERVAL '2 days')`,
          [`${EMAIL_PREFIX}bf_d@example.com`, `${USER_PREFIX}bfd`],
        );

        await client.query(MIGRATION_SQL);

        const rows = await client.query<{
          username: string;
          custody: string | null;
          has_epoch: boolean;
          updated_age_days: number;
        }>(
          `SELECT username, custody,
                  (upgraded_at IS NOT NULL) AS has_epoch,
                  EXTRACT(EPOCH FROM (NOW() - updated_at))::int / 86400 AS updated_age_days
           FROM accounts
           WHERE email LIKE $1
           ORDER BY username`,
          [`${EMAIL_PREFIX}bf_%`],
        );
        const byUser = Object.fromEntries(rows.rows.map((r) => [r.username, r]));

        expect(byUser[`${USER_PREFIX}bflight`].custody).toBe('self');
        expect(byUser[`${USER_PREFIX}bflight`].has_epoch).toBe(true);
        expect(byUser[`${USER_PREFIX}bfnull`].custody).toBe('self');
        expect(byUser[`${USER_PREFIX}bfnull`].has_epoch).toBe(true);
        expect(byUser[`${USER_PREFIX}bfctrl`].custody).toBe('light');
        expect(byUser[`${USER_PREFIX}bfctrl`].has_epoch).toBe(false);
        expect(byUser[`${USER_PREFIX}bfd`].custody).toBe('self');
        // updated_at untouched on every row: the repaired accounts must not
        // land inside the /link stuck-recovery window (an hour) after deploy.
        for (const r of rows.rows) {
          expect(r.updated_age_days, `${r.username} updated_at was bumped`).toBeGreaterThanOrEqual(1);
        }

        // The constraint is back, and it now holds against the repaired rows.
        const def = await client.query<{ def: string }>(
          `SELECT pg_get_constraintdef(oid) AS def
           FROM pg_constraint
           WHERE conname = $1 AND conrelid = 'public.accounts'::regclass`,
          [CONSTRAINT],
        );
        expect(def.rows.length).toBe(1);
        expect(def.rows[0].def).toMatch(/upgraded_at IS NULL/);

        // Second apply is a no-op: the DO block sees the constraint and the
        // UPDATE matches nothing. `deploy.sh migrate` re-runs every file.
        await expect(client.query(MIGRATION_SQL)).resolves.toBeDefined();
      } finally {
        // ROLLBACK reverts the DROP CONSTRAINT, the seeds, the back-fill, and
        // the schema_migrations upsert, so every other suite sees the
        // constraint intact.
        await client.query('ROLLBACK');
      }
    } finally {
      client.release();
    }
    // Post-rollback sanity check: the constraint must still exist on the live
    // schema. A failure here means the test corrupted the test DB and would
    // cascade into every suite that relies on the shape being unreachable.
    expect(await constraintDef()).not.toBeNull();
  });
});
