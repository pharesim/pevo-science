import pg from 'pg';
import { readdir } from 'node:fs/promises';
import { resolve as resolvePath } from 'node:path';
import { config } from './config.js';
import { logger } from './logger.js';
import { BootFatalError } from './startup-checks.js';

const { Pool } = pg;

let pool: pg.Pool | null = null;

export function getAppPool(): pg.Pool | null {
  if (pool) return pool;
  if (!config.appDatabaseUrl) return null;

  pool = new Pool({
    connectionString: config.appDatabaseUrl,
    max: 5,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });

  pool.on('error', (err) => {
    logger.error({ err }, 'Unexpected app DB pool error');
  });

  return pool;
}

// Migrations live at `backend/migrations/` relative to the compiled module
// directory. The TS source ships from `backend/src/` and the compiled JS
// from `backend/dist/`; resolving one level up from `__dirname` reaches
// `backend/` in both layouts, where the `migrations/` sibling directory
// lives. `__dirname` is the CommonJS-globals form used elsewhere in this
// codebase (tsconfig sets `module: Node16` without `"type": "module"` in
// package.json, so .ts files compile to CJS and `__dirname` is the
// standard module-relative anchor — `import.meta.url` is unavailable
// under this output target).
const MIGRATIONS_DIR = resolvePath(__dirname, '..', 'migrations');

/**
 * Enumerate the migration filenames on disk that the running code expects
 * the database to have applied. The probe matches every `*.sql` file under
 * `backend/migrations/` and sorts lexicographically; the numeric prefix on
 * each file (`001_`, `002_`, ...) makes lex order the apply order.
 */
async function listExpectedMigrations(): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(MIGRATIONS_DIR);
  } catch (err) {
    // A missing migrations directory means the running image shipped without
    // the SQL files this probe verifies against. Surface it as a BootFatalError
    // naming the resolved path rather than letting a raw ENOENT bubble up as a
    // generic "Failed to verify app database schema". The Dockerfile COPYs
    // backend/migrations into the image, so this only fires on a packaging
    // regression or a hand-run against a stripped tree.
    throw new BootFatalError(
      `Migrations directory not found at ${MIGRATIONS_DIR}. The backend image must ship ` +
        'backend/migrations/*.sql so the schema_migrations boot probe can verify the applied set.',
      { cause: err },
    );
  }
  return entries.filter((name) => name.endsWith('.sql')).sort();
}

/**
 * Minimal queryable surface satisfied by both `pg.Pool` and `pg.Client`. The
 * verify function accepts either so test code can hand it a single-client
 * connection (BEGIN ... ROLLBACK bracketed) to exercise the missing-table
 * and missing-row branches without polluting the shared DB or needing a
 * separate dedicated test database.
 */
interface Queryable {
  query<R extends pg.QueryResultRow = pg.QueryResultRow>(
    queryText: string,
  ): Promise<pg.QueryResult<R>>;
}

/**
 * Inner schema-verify routine. Exported for tests; production callers go
 * through `verifyAppDbMigrations()` which resolves the pool from
 * `getAppPool()`.
 *
 * Throws `BootFatalError` when:
 *   - `schema_migrations` itself is missing (DB has never been migrated).
 *   - Any expected `*.sql` file lacks a row in `schema_migrations`.
 */
export async function verifyAppDbMigrationsWith(p: Queryable): Promise<void> {
  // Existence check on the tracking table itself. `to_regclass` returns NULL
  // when the relation does not exist, which is cheaper and lock-free vs.
  // catching the 42P01 (undefined_table) error from a SELECT against the
  // missing table.
  const trackingTable = await p.query<{ exists: boolean }>(
    `SELECT (to_regclass('public.schema_migrations') IS NOT NULL) AS exists`,
  );
  if (!trackingTable.rows[0]?.exists) {
    throw new BootFatalError(
      'App database has no schema_migrations table. Run `./deploy.sh migrate` before starting the backend, ' +
        'or apply backend/migrations/*.sql against the configured APP_DATABASE_URL manually. ' +
        'See agents/docs/ARCHITECTURE.md (Migrations) for the contract: migrations are authoritative, ' +
        'application code never issues DDL on startup.',
    );
  }

  const expected = await listExpectedMigrations();
  const result = await p.query<{ filename: string }>(
    `SELECT filename FROM schema_migrations`,
  );
  const applied = new Set(result.rows.map((r) => r.filename));
  const missing = expected.filter((name) => !applied.has(name));

  if (missing.length > 0) {
    throw new BootFatalError(
      `App database is missing ${missing.length} expected migration(s): ${missing.join(', ')}. ` +
        'Run `./deploy.sh migrate` before starting the backend. ' +
        'See agents/docs/ARCHITECTURE.md (Migrations) for the contract: migrations are authoritative, ' +
        'application code never issues DDL on startup.',
    );
  }

  // Sole-guard assertion: the accounts_orcid_unique partial index
  // (007_accounts_orcid_unique.sql) is the ONLY backstop against duplicate-ORCID
  // account rows — /signup (auth.ts) and the ORCID-write handlers in routes/orcid.ts
  // carry no application-level uniqueness check. Its schema_migrations row can outlive the
  // index itself (a hand-run DROP INDEX, a pg_dump/restore that ships table rows
  // but omits or fails the post-data index section, or out-of-order hand-applied
  // migrations), and migration 008 backfills the 007 row unconditionally — so
  // "row recorded" does NOT prove "index exists". Verify the index is physically
  // present, not merely recorded, so a missing backstop fails fast at boot rather
  // than at the first silent duplicate write. Gated on 007 being expected so a
  // fork that drops the migration is not force-failed. Scoped to this one
  // sole-guard index by design; NOT a general verify-every-index sweep.
  if (expected.includes('007_accounts_orcid_unique.sql')) {
    const orcidIndex = await p.query<{ exists: boolean }>(
      `SELECT (to_regclass('public.accounts_orcid_unique') IS NOT NULL) AS exists`,
    );
    if (!orcidIndex.rows[0]?.exists) {
      throw new BootFatalError(
        'App database is missing the accounts_orcid_unique index, the sole backstop ' +
          'against duplicate-ORCID account rows, even though its migration row is recorded. ' +
          'Re-apply backend/migrations/007_accounts_orcid_unique.sql (or run `./deploy.sh migrate`) ' +
          'so the index is physically present. See agents/docs/ARCHITECTURE.md (Migrations) for the ' +
          'contract: migrations are authoritative, application code never issues DDL on startup.',
      );
    }
  }

  logger.info(
    { migrations: expected.length },
    'App database schema verified against migrations on disk',
  );
}

/**
 * Verify the app database has every migration the running code expects.
 *
 * Migrations are the sole source of truth for the application schema. This
 * function runs at boot and confirms `schema_migrations` carries a row for
 * each `backend/migrations/*.sql` file present on disk. A missing row means
 * the operator skipped a migration run (or rolled back across a deploy);
 * either way the running code's SQL will reference shapes the DB does not
 * have yet, and silent INSERT failures downstream are far worse than a loud
 * boot abort.
 *
 * Throws `BootFatalError` on schema gaps (see `verifyAppDbMigrationsWith`).
 *
 * Returns silently when `APP_DATABASE_URL` is unset — the backend can run
 * without a notification/accounts DB; routes that need it 500 with a clear
 * error rather than crashing the whole process at boot.
 */
export async function verifyAppDbMigrations(): Promise<void> {
  const p = getAppPool();
  if (!p) {
    logger.warn('APP_DATABASE_URL not configured — email notification preferences will not persist');
    return;
  }
  await verifyAppDbMigrationsWith(p);
}

export async function closeAppPool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
