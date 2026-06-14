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
 *
 * **Why not auto-translate in the central `errorHandler` middleware:**
 * translation is intentionally per-route so each handler supplies a
 * resource-specific user-facing message ("Profile reviews temporarily
 * unavailable", "Review temporarily unavailable", "Comments temporarily
 * unavailable", etc.). A central `if (err instanceof HafQueryError)`
 * branch in `errorHandler.ts` would have to either (a) emit a generic
 * "Service temporarily unavailable" string losing per-route specificity,
 * or (b) read a message field off the error losing the type-safety the
 * class provides. The route-level `instanceof` check keeps the message
 * string a literal at the handler so future "consolidate to middleware"
 * refactors don't silently collapse the per-route message strings.
 */
export class HafQueryError extends Error {
  // `operation` is a constructor argument that composes the message
  // (`HAF query failed: ${operation}`) but is NOT stored as a field —
  // the message string carries it, and Error.cause carries the
  // underlying pg error. Operation labels (e.g. 'fetchPaperDetailFromHaf',
  // 'paperExistsInHaf') are pure log-correlation hints; route handlers
  // never branch on operation, only on `instanceof HafQueryError` and
  // `isRetriableHafError`.
  constructor(operation: string, options?: ErrorOptions) {
    super(`HAF query failed: ${operation}`, options);
    this.name = 'HafQueryError';
  }
}

/**
 * Classify a `HafQueryError`'s underlying pg cause as retriable.
 *
 * Parameter is typed `HafQueryError` (not `unknown`) because every call
 * site gates with `err instanceof HafQueryError && isRetriableHafError(err)`;
 * the outer guard narrows `err` before the call, and the literal-union
 * type forces every new caller to perform the same narrowing.
 *
 * `HafQueryError` is symptom-based ("the HAF query failed"), not cause-
 * based. The pg `code` on the underlying cause discriminates transient
 * outages (worth retrying) from deterministic failures (a retry storms a
 * dead query). Without this discrimination a deploy-time SQL syntax
 * error (`42601`) or permission error (`42501`) would emit `503` with
 * `retriable: true` and the SPA retry loop would hammer the route until
 * the cap. The downside of over-classifying as 500 is small (a transient
 * outage logged as INTERNAL_ERROR is still an outage); the downside of
 * over-classifying as 503-retriable is amplification on a dead query.
 *
 * Retriable codes:
 *   - PostgreSQL class `08*` — connection exceptions (HAF restart,
 *     network blip, pool reset).
 *   - `57014` — `query_canceled` / statement_timeout. Transient under
 *     load even when the query itself is correct.
 *   - `57P01` — `admin_shutdown`. Postgres graceful shutdown windows;
 *     realistic during HAF maintenance. Pairs with `57P03` as the two
 *     halves of the Postgres restart cycle: shutdown (`57P01`) and
 *     startup (`57P03`) windows during HAF maintenance.
 *   - `57P03` — `cannot_connect_now` (Postgres startup, point-in-time
 *     recovery, standby promotion windows; realistic during HAF
 *     maintenance).
 *   - `53300` — `too_many_connections` (pg-level admission reject when
 *     the server's own `max_connections` is hit, distinct from PEvO's
 *     pool cap).
 *   - No code at all — generic JS `Error` thrown from a non-pg layer
 *     (pool exhaustion before connection, network unreachable). Default
 *     to retriable: the helper's catch wrapped a transient failure that
 *     never reached a deterministic-error site.
 *
 * Non-retriable codes (everything else): deploy-time bugs like syntax
 * errors (`42601`), permission errors (`42501`), data-type mismatches
 * (`22P02`), etc. These are not outages and don't recover on retry.
 */
export function isRetriableHafError(err: HafQueryError): boolean {
  const code = (err.cause as { code?: unknown } | null | undefined)?.code;
  if (typeof code !== 'string') {
    // No pg code: a generic JS Error from the pool / network layer.
    // Treat as retriable (transient outage signal), matching the helper's
    // intent in wrapping the throw as HafQueryError in the first place.
    return true;
  }
  return code.startsWith('08') || code === '57014' || code === '57P01' || code === '57P03' || code === '53300';
}

export function getPool(): pg.Pool | null {
  if (pool) return pool;
  if (config.hafDatabaseUrls.length === 0) return null;

  // The `onConnect` Pool-constructor option (vs. the older
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
 * Renamed from `isHafAvailable` to make the config-only
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
