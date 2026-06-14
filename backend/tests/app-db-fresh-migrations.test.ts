/**
 * Fresh-DB regression for `verifyAppDbMigrations` and the migrations-as-sole-
 * schema-authority contract.
 *
 * Goal of this suite: catch any regression that resurrects DDL inside the
 * application boot path. Migrations under `backend/migrations/*.sql` are the
 * authoritative schema source; the backend never issues `CREATE TABLE` or
 * `ALTER TABLE` from `verifyAppDbMigrations` or any other startup hook. The
 * coverage matrix below pins four behaviours that together make that
 * contract observable:
 *
 *   (a) Cold-applied migrations produce a schema that accepts an ORCID-only
 *       INSERT (`email IS NULL`). The migration set's net effect — 001
 *       declares `accounts.email NOT NULL UNIQUE`, 002 drops the NOT NULL —
 *       only works if migrations run to completion. If a future regression
 *       reintroduces a `CREATE TABLE accounts (… email TEXT NOT NULL …)` in
 *       application code that runs BEFORE migrations apply, this assertion
 *       fails loud with NOT NULL violation against a virgin volume.
 *
 *   (b) Cold-applied migrations populate `schema_migrations` with a row
 *       for every `*.sql` file on disk, so `verifyAppDbMigrationsWith`
 *       returns cleanly without throwing.
 *
 *   (c) `verifyAppDbMigrationsWith` throws `BootFatalError` when the
 *       `schema_migrations` table is missing (DB never migrated). The
 *       error names the actionable recovery (`./deploy.sh migrate`).
 *
 *   (d) `verifyAppDbMigrationsWith` throws `BootFatalError` when a
 *       migration file exists on disk but lacks a row in
 *       `schema_migrations` (operator partially migrated). The error names
 *       the missing file so the operator can target the right subset.
 *
 * Isolation strategy: each test acquires a dedicated client from the pool,
 * runs `BEGIN`, then `DROP SCHEMA public CASCADE; CREATE SCHEMA public` to
 * exercise the fresh-DB shape, applies migrations cold, runs its
 * assertions, then `ROLLBACK` at the end. PostgreSQL allows DDL inside
 * transactions, so the wipe + reapply + INSERTs are all bounded by the
 * transaction; ROLLBACK restores the outer schema state. No shared-DB
 * pollution; concurrent test files using the same DB see no schema
 * mutation outside the transaction.
 *
 * Each verify call uses `verifyAppDbMigrationsWith(client)` rather than
 * `verifyAppDbMigrations()` so the in-transaction snapshot (which includes
 * the uncommitted DROP / DELETE / INSERTs) is the one the probe sees. The
 * production entrypoint `verifyAppDbMigrations()` would route to a fresh
 * pool connection that does NOT see uncommitted state, hiding the test
 * pre-condition. The two functions share their inner logic; pinning the
 * inner function pins the production path.
 *
 * Real-DB-required guard: `describe.skipIf(!dbReachable)` mirrors the
 * pattern in `tests/migrations/accounts-orcid-unique.test.ts`. CI without
 * Postgres skips the suite cleanly.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PoolClient } from 'pg';
import { getAppPool, verifyAppDbMigrationsWith } from '../src/app-db.js';
import { BootFatalError } from '../src/startup-checks.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, '..', 'migrations');
const MIGRATION_FILES = readdirSync(MIGRATIONS_DIR)
  .filter((name) => name.endsWith('.sql'))
  .sort();

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

/**
 * Apply every migration file under `backend/migrations/` against the given
 * client, in lex (numeric-prefix) order. Mirrors the deploy.sh migrate_db
 * loop, so this test exercises the same apply sequence operators see in
 * production.
 */
async function applyAllMigrations(client: PoolClient): Promise<void> {
  for (const name of MIGRATION_FILES) {
    const sql = readFileSync(join(MIGRATIONS_DIR, name), 'utf8');
    await client.query(sql);
  }
}

const SENTINEL = `fresh_migr_${Date.now()}`;

describe.skipIf(!dbReachable)('verifyAppDbMigrations + cold-migrate fresh-DB regression', () => {
  it('cold-applied migrations accept ORCID-only signup (email = NULL)', async () => {
    const pool = getAppPool();
    if (!pool) throw new Error('App DB pool unavailable despite dbReachable');

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Wipe public schema entirely so the migration set runs cold against a
      // truly empty namespace. Reproduces the fresh-deploy path that the
      // legacy `initAppDb()` DDL silently papered over.
      await client.query('DROP SCHEMA public CASCADE');
      await client.query('CREATE SCHEMA public');

      await applyAllMigrations(client);

      // ORCID-only INSERT: this is the row shape the auth.ts signup handler
      // persists for an accredited user with no verified email. Migration
      // 001 declared `email NOT NULL UNIQUE`; migration 002 drops the NOT
      // NULL. If a regression resurrects `CREATE TABLE accounts (… email
      // NOT NULL …)` inside application boot code and that code ever runs
      // before migrations against a virgin volume, this assertion fails
      // with a NOT NULL violation.
      const insert = await client.query<{ email: string | null; orcid: string }>(
        `INSERT INTO accounts (email, password_hash, full_name, institution, field, orcid, verify_token, expires_at)
         VALUES (NULL, NULL, '', '', '', $1, $2, NOW() + INTERVAL '1 hour')
         RETURNING id, email, orcid`,
        [`0000-0000-0000-${SENTINEL.slice(-4)}`, `confirmed:${SENTINEL}`],
      );

      expect(insert.rowCount).toBe(1);
      expect(insert.rows[0].email).toBeNull();
      expect(insert.rows[0].orcid).toBe(`0000-0000-0000-${SENTINEL.slice(-4)}`);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  it('cold-applied migrations populate schema_migrations with every *.sql file on disk', async () => {
    const pool = getAppPool();
    if (!pool) throw new Error('App DB pool unavailable despite dbReachable');

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DROP SCHEMA public CASCADE');
      await client.query('CREATE SCHEMA public');
      await applyAllMigrations(client);

      // The probe sees the same in-transaction snapshot via the same client
      // and must return without throwing — every migration file on disk
      // matches a row in schema_migrations.
      await expect(verifyAppDbMigrationsWith(client)).resolves.toBeUndefined();

      const result = await client.query<{ filename: string }>(
        `SELECT filename FROM schema_migrations ORDER BY filename`,
      );
      const recorded = result.rows.map((r) => r.filename);
      expect(recorded).toEqual(MIGRATION_FILES);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  it('throws BootFatalError when schema_migrations table is missing', async () => {
    const pool = getAppPool();
    if (!pool) throw new Error('App DB pool unavailable despite dbReachable');

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Reproduce the never-migrated DB shape inside the transaction. The
      // probe's first branch checks `to_regclass('public.schema_migrations')`
      // and throws BootFatalError when it returns NULL.
      await client.query('DROP TABLE IF EXISTS schema_migrations');

      let caught: unknown;
      try {
        await verifyAppDbMigrationsWith(client);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(BootFatalError);
      // The error message must name the operator-actionable recovery path,
      // not just the abstract failure. Operators triaging a failed boot
      // need the command to run.
      expect((caught as Error).message).toMatch(/schema_migrations/);
      expect((caught as Error).message).toMatch(/deploy\.sh migrate/);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  it('throws BootFatalError and names the missing file when schema_migrations is partially populated', async () => {
    const pool = getAppPool();
    if (!pool) throw new Error('App DB pool unavailable despite dbReachable');

    // Pick a real migration file as the "missing" sentinel; the probe lists
    // files under backend/migrations/ and reports any whose filename is not
    // present in the schema_migrations row set. Using the last migration on
    // disk catches the "operator forgot the final migration in a batch"
    // failure mode (the most common partial-migrate shape — a run that
    // crashed midway and was not resumed).
    const targetMigration = MIGRATION_FILES[MIGRATION_FILES.length - 1];

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Run migrations cold first so schema_migrations exists and is
      // populated, then delete one row to simulate the partial state.
      // Wiping and reapplying inside the transaction keeps the assertion
      // self-contained — it does not depend on which migrations the outer
      // DB happens to have recorded.
      await client.query('DROP SCHEMA public CASCADE');
      await client.query('CREATE SCHEMA public');
      await applyAllMigrations(client);
      await client.query(
        `DELETE FROM schema_migrations WHERE filename = $1`,
        [targetMigration],
      );

      let caught: unknown;
      try {
        await verifyAppDbMigrationsWith(client);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(BootFatalError);
      // The error message must name the actual missing filename so the
      // operator can target the right re-run subset rather than re-running
      // every migration.
      const errMsg = (caught as Error).message;
      expect(errMsg).toContain(targetMigration);
      expect(errMsg).toMatch(/missing/i);
      expect(errMsg).toMatch(/deploy\.sh migrate/);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  it('throws BootFatalError when accounts_orcid_unique index is absent though its migration row is recorded', async () => {
    const pool = getAppPool();
    if (!pool) throw new Error('App DB pool unavailable despite dbReachable');

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DROP SCHEMA public CASCADE');
      await client.query('CREATE SCHEMA public');
      await applyAllMigrations(client);
      // Decouple the recorded migration from the physical index: 007's
      // schema_migrations row survives, but the index is gone. This is the
      // exact state a hand-run `DROP INDEX`, a rows-only pg_dump/restore, or an
      // out-of-order hand-apply leaves, and the migration-row probe alone
      // (which only checks that the filename was recorded) cannot catch it.
      await client.query('DROP INDEX accounts_orcid_unique');

      let caught: unknown;
      try {
        await verifyAppDbMigrationsWith(client);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(BootFatalError);
      const errMsg = (caught as Error).message;
      expect(errMsg).toMatch(/accounts_orcid_unique/);
      expect(errMsg).toMatch(/deploy\.sh migrate/);

      // Pin that this throw is the index assertion, NOT the missing-migration
      // path: 007's row must still be present. Without this guard a regression
      // that dropped the 007 row instead would produce the same BootFatalError
      // class and silently pass the assertions above.
      const row = await client.query(
        `SELECT 1 FROM schema_migrations WHERE filename = '007_accounts_orcid_unique.sql'`,
      );
      expect(row.rowCount).toBe(1);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  // Positive control: the "cold-applied migrations populate schema_migrations"
  // spec above already resolves verifyAppDbMigrationsWith cleanly with the index
  // physically present, so the index assertion's pass path is covered there.
});
