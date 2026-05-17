import pg from 'pg';
import { config } from './config.js';
import { logger, getRequestId } from './logger.js';

const { Pool } = pg;

let pool: pg.Pool | null = null;

/**
 * Tag class for HAF-pool query failures that route handlers want to
 * translate to `503 SERVICE_UNAVAILABLE` (transient-outage) rather than
 * `404 NOT_FOUND` (data missing). The two failure modes are otherwise
 * indistinguishable at the helper-return layer when the helper's catch
 * collapses both into `null`.
 *
 * Use at the fetcher boundary: in the helper's `catch (err)`, wrap as
 * `throw new HafQueryError('paper detail', { cause: err })` so the route
 * layer's `catch (err) { if (err instanceof HafQueryError) ... }` block
 * can emit the retriable-503 envelope. The `cause` (Error.cause) carries
 * the underlying pg / Postgres error for operator log correlation; the
 * tag itself is the signal route handlers act on.
 *
 * Why a class rather than a discriminated `FetchResult<T>` union: the
 * change is narrow and reuses the existing throw-path that
 * `getAllAccreditedAccounts` / `getAccreditedOrcidsByAccount` /
 * `getAllEverAccreditedOrcidsWithStatus` already established for HAF
 * outages. Helpers that today return `null` for "data not found" keep
 * that contract; the new throw distinguishes "HAF down" from "no row".
 */
export class HafQueryError extends Error {
  public readonly operation: string;
  constructor(operation: string, options?: { cause?: unknown }) {
    super(`HAF query failed: ${operation}`, options as ErrorOptions);
    this.name = 'HafQueryError';
    this.operation = operation;
  }
}

export function getPool(): pg.Pool | null {
  if (pool) return pool;
  if (config.hafDatabaseUrls.length === 0) return null;

  // Round-2 F4: `onConnect` Pool-constructor option (vs. the pre-fix
  // `pool.on('connect', ...)` listener) makes the first query on a brand-new
  // connection wait for `SET statement_timeout = 30000` to complete. Under
  // the pre-fix shape, the listener fired asynchronously and the first query
  // on a cold connection could execute BEFORE the timeout was applied,
  // leaving a window where a runaway HAF query could hold the connection
  // open past the intended 30s ceiling. Most-visible under the new HAF query
  // volume introduced by the idempotency layer (every /verify and
  // /broadcast carrying an idempotency_key opens a new pool slot under
  // load).
  pool = new Pool({
    connectionString: config.hafDatabaseUrls[0],
    max: 3,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    async onConnect(client) {
      await client.query('SET statement_timeout = 30000');
    },
  });

  pool.on('error', (err) => {
    logger.error({ err, reqId: getRequestId() }, 'Unexpected HAF pool error');
  });

  return pool;
}

/**
 * Returns true when a HAF database URL is configured. Tests config presence
 * only — NOT live reachability. A `true` return is necessary but not
 * sufficient for a HAF query to succeed; a transient HAF outage (pool
 * exhaustion, network blip, postgres restart) surfaces at query time as a
 * thrown error, NOT as a `false` return here. Callers that need to
 * discriminate "HAF not configured" from "HAF transiently unreachable"
 * key the discrimination on the error path, not on this return.
 *
 * Renamed (round-2 F10) from `isHafAvailable` to make the config-only
 * semantics explicit. The prior name suggested reachability and led to log
 * events tagged `idempotency_haf_unavailable` that operators mis-read as
 * outage signals.
 */
export function isHafConfigured(): boolean {
  return config.hafDatabaseUrls.length > 0;
}

export async function closeHafPool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
