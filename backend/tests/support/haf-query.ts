import type { Pool, QueryResult, QueryResultRow } from 'pg';

// pg pools cache idle TCP connections. Under parallel test load the remote HAF
// endpoint drops idle sockets and briefly refuses new ones; queries throw
// ECONNRESET before the pool can swap in a fresh connection. Retry with
// exponential backoff so multiple failed sockets in a burst clear out before
// the test gives up.
const TRANSIENT_CODES = new Set(['ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ECONNREFUSED']);

export async function queryWithRetry<T extends QueryResultRow = QueryResultRow>(
  pool: Pool,
  sql: string,
  params: unknown[],
  attempts = 4,
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
