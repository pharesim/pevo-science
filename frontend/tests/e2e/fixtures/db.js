/**
 * Shared Postgres helpers for E2E specs.
 *
 * Why this exists:
 *   Multiple specs used to hand-roll `new pg.Pool({ connectionString: APP_DATABASE_URL })
 *   → query → pool.end()`. The duplication hid two latent bugs:
 *     1. No spec-local `_test` DB-suffix guard. `global-setup.js` enforces
 *        the suffix via the backend's test-db:reset hook, but a spec run in
 *        isolation (`npx playwright test some.spec.js` with global-setup
 *        skipped, or `VSCode "run file"` invocations) never hits that gate
 *        and can write to a non-test DB.
 *     2. Silent connection leaks if a test throws before `pool.end()`.
 *
 *   Centralising the two helpers behind a shared `_test`-suffix guard closes
 *   both leaks: every DB access goes through `assertTestDatabase`, so the
 *   suffix check runs even when global-setup is skipped, and the `finally`
 *   blocks below guarantee the pool ends on any exit path.
 *
 * API surface: one helper per concern, both enforce the same guard:
 *   - `withAppPool(fn)`  — supply a callback that receives a live `pg.Pool`.
 *                         Helper handles end() in a finally block.
 *   - `queryAppDb(sql, params)` — one-shot query. Spins up a short-lived pool,
 *                                 runs the query, ends the pool. Returns the
 *                                 pg `QueryResult`.
 *
 * Both enforce that APP_DATABASE_URL points at a database whose name ends in
 * `_test`. They throw before opening any connection if the suffix is missing.
 */

import pg from 'pg';

/**
 * Strictly check that the connection string targets a database whose name
 * ends in `_test`. Accepts URL strings (`postgresql://…/pevo_app_test`) and
 * the shorter `postgres://` scheme. Exported for unit coverage.
 */
export function assertTestDatabase(connectionString) {
  if (!connectionString || typeof connectionString !== 'string') {
    throw new Error(
      '[e2e db] APP_DATABASE_URL is not set. Configure frontend/.env.test.',
    );
  }
  let dbName;
  try {
    const url = new URL(connectionString);
    // pg URLs: pathname is `/<db>`; strip the leading slash. Edge cases
    // (query params like ?database=foo) aren't used by the specs, so we
    // keep the parser simple.
    dbName = decodeURIComponent(url.pathname.replace(/^\//, ''));
  } catch (err) {
    throw new Error(
      `[e2e db] APP_DATABASE_URL is not a valid URL: ${err.message}`,
    );
  }
  if (!dbName) {
    throw new Error(
      '[e2e db] APP_DATABASE_URL has no database name in its path. Expected …/pevo_app_test.',
    );
  }
  // Reject any path with additional `/` segments. `postgresql://.../pevo_app/test`
  // parses pathname as `/pevo_app/test`, so dbName becomes `pevo_app/test` and
  // `endsWith('_test')` is false — but an attacker-crafted `.../pevo_app/x_test`
  // would sneak past the suffix check while libpq opens `pevo_app` (the chars
  // after the first `/` are discarded). Enforce that dbName is a single token.
  if (!/^[^/]+_test$/.test(dbName)) {
    throw new Error(
      `[e2e db] Refusing to connect: database "${dbName}" does not match /^[^/]+_test$/. ` +
        'E2E specs write to the DB; point APP_DATABASE_URL at a single pevo_app_test-style ' +
        'database name (no extra path segments) before running.',
    );
  }
}

/**
 * Open a pool against APP_DATABASE_URL after validating the `_test` suffix.
 * Caller owns the `pool.end()` lifecycle — use this when the pool lives
 * across multiple tests (e.g. a `test.beforeAll` / `test.afterAll` pair).
 * For a single scope, prefer `withAppPool` so you don't have to remember
 * to close it.
 */
export function openAppPool() {
  const connectionString = process.env.APP_DATABASE_URL;
  assertTestDatabase(connectionString);
  return new pg.Pool({ connectionString });
}

/**
 * Open a short-lived pool against APP_DATABASE_URL, pass it to the caller,
 * and end it in a `finally` — no matter how the callback exits.
 */
export async function withAppPool(fn) {
  const pool = openAppPool();
  try {
    return await fn(pool);
  } finally {
    await pool.end();
  }
}

/**
 * Run a single parameterised query against APP_DATABASE_URL and end the
 * pool before returning. Use `withAppPool` for multi-statement sequences.
 */
export async function queryAppDb(sql, params = []) {
  return withAppPool((pool) => pool.query(sql, params));
}
