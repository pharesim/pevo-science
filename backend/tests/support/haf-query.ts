import { expect } from 'vitest';
import type { Pool, QueryResult, QueryResultRow } from 'pg';
// Aliased: this file's generic helpers use `T` as a type parameter.
import { T as HAF_VIEWS } from '../../src/hafsql.js';

// pg pools cache idle TCP connections. Under parallel test load the remote HAF
// endpoint drops idle sockets and briefly refuses new ones; queries throw
// ECONNRESET before the pool can swap in a fresh connection. Retry with
// exponential backoff so multiple failed sockets in a burst clear out before
// the test gives up.
const TRANSIENT_CODES = new Set(['ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ECONNREFUSED']);

/** Redirect HAF view literals in a composed statement at a file's synthetic
 *  temp tables, for running production SQL builders verbatim against a real
 *  Postgres planner. `mapping` keys are members of `T` from `hafsql.js`
 *  (imported here as `HAF_VIEWS`); each caller passes exactly the view
 *  subset its corpus synthesizes.
 *
 *  Per-literal drift guard: after each replacement the original literal must
 *  be gone from the SQL, so a builder alias change cannot silently leave the
 *  query pointed at live HAF. Deliberately per-literal rather than a bare
 *  schema-prefix scan, which would trip on SQL comments that mention view
 *  names; callers wanting the stricter whole-schema guard add their own
 *  assertion on the returned SQL. A view a mapping misses still fails loudly
 *  at execution because the app database has no HAF schema. */
export function redirectHafViews(
  stmt: { sql: string; params: unknown[] },
  mapping: Partial<Record<keyof typeof HAF_VIEWS, string>>,
): { sql: string; params: unknown[] } {
  let sql = stmt.sql;
  for (const [view, target] of Object.entries(mapping) as Array<[keyof typeof HAF_VIEWS, string]>) {
    sql = sql.split(HAF_VIEWS[view]).join(target);
    expect(sql).not.toContain(HAF_VIEWS[view]);
  }
  return { sql, params: stmt.params };
}

export async function queryWithRetry<T extends QueryResultRow = QueryResultRow>(
  pool: Pool,
  sql: string,
  params: unknown[],
  attempts = 8,
): Promise<QueryResult<T>> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await pool.query<T>(sql, params);
    } catch (err) {
      lastErr = err;
      const code = (err as NodeJS.ErrnoException)?.code;
      if (!code || !TRANSIENT_CODES.has(code)) throw err;
      if (i === attempts - 1) break;
      await new Promise((r) => setTimeout(r, 250 * Math.pow(2, i)));
    }
  }
  throw lastErr;
}
