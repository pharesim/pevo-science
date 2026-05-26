/**
 * Durable FIFO queue for bridge paper imports.
 *
 * Backing store: Postgres table `bridge_import_queue` (see migration
 * `010_bridge_import_queue.sql`). The chain enforces a 1-root-post-per-
 * 5-minute cadence on the single bridge account; this queue absorbs the
 * concurrency mismatch between incoming `/api/bridge/register` calls and
 * the cadence, and the worker (`bridge-worker.ts`) dispatches one entry
 * at a time at chain pace.
 *
 * Redis is NOT the source of truth for queue state. Redis remains the
 * per-permlink SETNX dedup-lock layer used by the route's race-protection
 * code; that lock is unrelated to this queue's durability.
 *
 * Per-user concurrent-pending cap: enforced at enqueue (see
 * `tryEnqueueBridgeImport`). Cap is evaluated against `state IN ('pending',
 * 'in_progress')` only — terminal entries (completed / failed) do not
 * count.
 *
 * Restart safety: the leasing pattern below (CTE updates `state` from
 * `pending` -> `in_progress` and sets `lease_expires_at`) lets a crashed
 * worker's lease expire and the entry re-lease on the next worker tick.
 * Re-leasing cannot double-broadcast: the worker re-runs an on-chain
 * duplicate check (`checkExistingOnChain`) before every broadcast and
 * short-circuits to the existing record if the post already landed; and
 * even a racing re-broadcast is harmless because the permlink is
 * deterministic from the identifier, so a same-author/same-permlink
 * `comment` is an idempotent edit of the same content on Hive, not a
 * duplicate post.
 */

import type pg from 'pg';
import { getAppPool } from './app-db.js';
import { logger } from './logger.js';

/** Per-user maximum concurrent pending or in-progress entries. */
export const BRIDGE_QUEUE_USER_CAP = 5;

/**
 * Chain cooldown between consecutive root posts on the bridge account.
 * Used by the worker to bound dispatch cadence; the actual rate-limit
 * surface is on-chain, this value is what we plan against client-side.
 */
export const BRIDGE_CHAIN_COOLDOWN_MS = 5 * 60 * 1000;

/**
 * Worker lease duration. Set comfortably wider than a typical broadcast
 * round-trip + chain confirmation so a slow but healthy broadcast does
 * not lose its lease mid-flight. Crashed workers' leases expire and the
 * entry returns to pending for re-lease.
 */
export const BRIDGE_QUEUE_LEASE_MS = 2 * 60 * 1000;

/**
 * Maximum retry attempts on transient broadcast failure before the entry
 * transitions to terminal failed state. Permlink-uniqueness collisions and
 * metadata-missing failures short-circuit retry — only transient broadcast
 * failures consume attempt budget.
 */
export const BRIDGE_QUEUE_MAX_ATTEMPTS = 5;

/**
 * Retention window for terminal queue rows. Completed/failed entries older
 * than this are retired by the worker's low-frequency purge tick. The queue
 * is operational short-term state, not an audit log; this window only keeps
 * enough recent history for the "My imports" surface to render a user's
 * recent imports. Assumption: 30 days is generous for "recent imports" at
 * beta volume (hundreds/day, terminal in minutes-to-hours); tune here if the
 * surface needs a longer or shorter horizon.
 */
export const BRIDGE_QUEUE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export type BridgeImportState = 'pending' | 'in_progress' | 'completed' | 'failed';

/**
 * Public-facing row shape (the status endpoint and the worker both use
 * this; rows from `pool.query` are cast through this type).
 */
export interface BridgeImportRow {
  id: number;
  operation_kind: string;
  username: string;
  identifier: string;
  permlink: string;
  discipline: string;
  keywords: string[];
  language: string;
  state: BridgeImportState;
  attempts: number;
  scheduled_at: Date;
  lease_expires_at: Date | null;
  tx_id: string | null;
  error_code: string | null;
  error_message: string | null;
  existing_author: string | null;
  existing_permlink: string | null;
  created_at: Date;
  updated_at: Date;
  completed_at: Date | null;
}

/**
 * Outcome of `tryEnqueueBridgeImport`. The discriminated union forces the
 * caller to handle the cap-exceeded and active-duplicate branches
 * explicitly rather than swallowing them as ok-with-null. Pre-existing
 * on-chain duplicates are NOT detected here (HAF lookup stays in the
 * route layer where it can return the existing record synchronously).
 */
export type EnqueueResult =
  | { status: 'enqueued'; row: BridgeImportRow; queuePosition: number }
  | { status: 'cap_exceeded'; inflight: number; cap: number }
  | { status: 'duplicate_active'; existing: BridgeImportRow };

export interface EnqueueInput {
  username: string;
  identifier: string;
  permlink: string;
  discipline: string;
  keywords: string[];
  language: string;
  operationKind?: string;
}

/**
 * Convert a DB row (raw pg shape) into the typed `BridgeImportRow`. pg
 * returns JSONB as parsed JS objects, but Date columns come back as `Date`
 * already; this helper is mostly a typed cast plus keyword normalization.
 */
function rowToBridgeImport(row: Record<string, unknown>): BridgeImportRow {
  const kw = row.keywords;
  // jsonb -> any[]; defensive coerce for the worker's typed consumers.
  const keywords = Array.isArray(kw) ? (kw as string[]) : [];
  return {
    id: Number(row.id),
    operation_kind: String(row.operation_kind),
    username: String(row.username),
    identifier: String(row.identifier),
    permlink: String(row.permlink),
    discipline: String(row.discipline),
    keywords,
    language: String(row.language),
    state: row.state as BridgeImportState,
    attempts: Number(row.attempts),
    scheduled_at: row.scheduled_at as Date,
    lease_expires_at: (row.lease_expires_at as Date | null) ?? null,
    tx_id: (row.tx_id as string | null) ?? null,
    error_code: (row.error_code as string | null) ?? null,
    error_message: (row.error_message as string | null) ?? null,
    existing_author: (row.existing_author as string | null) ?? null,
    existing_permlink: (row.existing_permlink as string | null) ?? null,
    created_at: row.created_at as Date,
    updated_at: row.updated_at as Date,
    completed_at: (row.completed_at as Date | null) ?? null,
  };
}

/**
 * Count the rows ahead of `entryId` that are still pending (i.e. would
 * dispatch before this one). Used to compute the queue-position field
 * returned to the submitter at enqueue.
 */
async function computeQueuePosition(
  pool: pg.Pool | pg.PoolClient,
  entryId: number,
): Promise<number> {
  const { rows } = await pool.query<{ position: string }>(
    `SELECT COUNT(*)::text AS position
       FROM bridge_import_queue
      WHERE state IN ('pending', 'in_progress')
        AND id <= $1`,
    [entryId],
  );
  // COUNT() includes the entry itself; "position" is 1-based.
  return Number(rows[0]?.position ?? '1');
}

/**
 * Atomically insert a queue entry, enforcing the per-user cap. Returns a
 * discriminated union signalling success, cap-exceeded, or active-duplicate
 * (a sibling submission for the same permlink is already pending or
 * in-progress).
 *
 * The cap check + insert run in a single transaction guarded by a
 * transaction-scoped per-user advisory lock so two concurrent 5th-slot
 * submissions from the same user cannot both squeeze through. The bare
 * `BEGIN` runs at READ COMMITTED, under which a count-then-insert phantom
 * is possible: two same-user submissions for distinct permlinks both
 * observe `COUNT < cap` and both insert, exceeding the cap by one.
 * REPEATABLE READ would not close this (the phantom is on rows neither
 * transaction has read yet); the advisory lock — or SERIALIZABLE with a
 * 40001 retry loop — is the real fix. We take the lock because it
 * serializes only same-user enqueues (cross-user throughput is unaffected)
 * and needs no retry plumbing. The partial-unique index on `permlink`
 * remains an independent cross-user collision backstop.
 */
export async function tryEnqueueBridgeImport(input: EnqueueInput): Promise<EnqueueResult> {
  const pool = getAppPool();
  if (!pool) {
    throw new Error('bridge queue requires APP_DATABASE_URL');
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Serialize concurrent enqueues from the same user so the per-user cap
    // COUNT below and the subsequent INSERT are atomic against each other.
    // Transaction-scoped: released automatically on COMMIT/ROLLBACK. Keyed
    // per-user so cross-user enqueues never contend.
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtext('bridge_enqueue:' || $1))`,
      [input.username],
    );
    // Active-permlink check (partial-unique index also enforces this at
    // write time, but the typed pre-check lets us return the active row
    // for caller-visible feedback rather than a raw 23505 error).
    const dup = await client.query<Record<string, unknown>>(
      `SELECT * FROM bridge_import_queue
        WHERE permlink = $1 AND state IN ('pending', 'in_progress')
        LIMIT 1`,
      [input.permlink],
    );
    if (dup.rows.length > 0) {
      await client.query('ROLLBACK');
      return { status: 'duplicate_active', existing: rowToBridgeImport(dup.rows[0]) };
    }

    const cap = await client.query<{ inflight: string }>(
      `SELECT COUNT(*)::text AS inflight
         FROM bridge_import_queue
        WHERE username = $1 AND state IN ('pending', 'in_progress')`,
      [input.username],
    );
    const inflight = Number(cap.rows[0]?.inflight ?? '0');
    if (inflight >= BRIDGE_QUEUE_USER_CAP) {
      await client.query('ROLLBACK');
      return { status: 'cap_exceeded', inflight, cap: BRIDGE_QUEUE_USER_CAP };
    }

    const inserted = await client.query<Record<string, unknown>>(
      `INSERT INTO bridge_import_queue
         (operation_kind, username, identifier, permlink, discipline,
          keywords, language)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
       RETURNING *`,
      [
        input.operationKind ?? 'bridge_register',
        input.username,
        input.identifier,
        input.permlink,
        input.discipline,
        JSON.stringify(input.keywords),
        input.language,
      ],
    );
    const row = rowToBridgeImport(inserted.rows[0]);
    const queuePosition = await computeQueuePosition(client, row.id);
    await client.query('COMMIT');
    return { status: 'enqueued', row, queuePosition };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Lease the oldest pending entry whose `scheduled_at` has been reached.
 * Atomically transitions the row to `in_progress` and sets
 * `lease_expires_at` so a crashed worker's lease is recoverable.
 *
 * Also re-leases stale `in_progress` rows whose lease has expired (their
 * worker crashed mid-flight); the worker's pre-broadcast on-chain
 * duplicate check plus deterministic-permlink edit-idempotency are the
 * defense-in-depth against the rare double-broadcast race.
 *
 * Returns null when nothing is due.
 */
export async function leaseNextEntry(): Promise<BridgeImportRow | null> {
  const pool = getAppPool();
  if (!pool) return null;
  // SKIP LOCKED guards against two worker ticks on the same process from
  // double-leasing; even with the in-process single-worker design, this
  // makes the SQL safe for future multi-process readers and matches the
  // canonical `pg` queue-with-lease pattern.
  const { rows } = await pool.query<Record<string, unknown>>(
    `WITH due AS (
       SELECT id FROM bridge_import_queue
        WHERE (state = 'pending' AND scheduled_at <= NOW())
           OR (state = 'in_progress' AND lease_expires_at IS NOT NULL
               AND lease_expires_at < NOW())
        ORDER BY scheduled_at ASC, id ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
     )
     UPDATE bridge_import_queue q
        SET state = 'in_progress',
            lease_expires_at = NOW() + ($1::int * INTERVAL '1 millisecond'),
            updated_at = NOW()
       FROM due
      WHERE q.id = due.id
      RETURNING q.*`,
    [BRIDGE_QUEUE_LEASE_MS],
  );
  if (rows.length === 0) return null;
  return rowToBridgeImport(rows[0]);
}

/**
 * Mark a leased entry as successfully broadcast.
 */
export async function markCompleted(
  id: number,
  result: { txId: string },
): Promise<void> {
  const pool = getAppPool();
  if (!pool) return;
  await pool.query(
    `UPDATE bridge_import_queue
        SET state = 'completed',
            tx_id = $2,
            completed_at = NOW(),
            updated_at = NOW(),
            lease_expires_at = NULL
      WHERE id = $1`,
    [id, result.txId],
  );
}

/**
 * Mark a leased entry as completed via permlink-collision short-circuit:
 * the bridge paper already exists on-chain (HAF lookup found a row), so
 * we return the existing record to the caller rather than re-broadcasting.
 */
export async function markCompletedExisting(
  id: number,
  existing: { author: string; permlink: string },
): Promise<void> {
  const pool = getAppPool();
  if (!pool) return;
  await pool.query(
    `UPDATE bridge_import_queue
        SET state = 'completed',
            existing_author = $2,
            existing_permlink = $3,
            completed_at = NOW(),
            updated_at = NOW(),
            lease_expires_at = NULL
      WHERE id = $1`,
    [id, existing.author, existing.permlink],
  );
}

/**
 * Mark a leased entry as terminal-failed. Does not increment attempts;
 * the caller is signalling "do not retry."
 */
export async function markFailed(
  id: number,
  failure: { code: string; message: string },
): Promise<void> {
  const pool = getAppPool();
  if (!pool) return;
  await pool.query(
    `UPDATE bridge_import_queue
        SET state = 'failed',
            error_code = $2,
            error_message = $3,
            completed_at = NOW(),
            updated_at = NOW(),
            lease_expires_at = NULL
      WHERE id = $1`,
    [id, failure.code, failure.message],
  );
}

/**
 * Push a leased entry back to pending with an exponential backoff on
 * `scheduled_at`. Returns the new attempt count; when the attempt count
 * exceeds {@link BRIDGE_QUEUE_MAX_ATTEMPTS}, the entry is instead
 * transitioned to terminal failed.
 *
 * `opts.incrementAttempts` (default `true`) gates the attempt budget. Real
 * broadcast failures (RC exhaustion, node unreachable, timeout) increment
 * it and can drive the entry to terminal failed. Pre-broadcast transient
 * outages — HAF duplicate-check unavailable, metadata source down at
 * dispatch — pass `false`: a global infra outage should reschedule a valid
 * submission indefinitely until infra recovers, never terminal-fail it on
 * a budget the broadcast never got to consume.
 *
 * Backoff: 30s, 60s, 120s, 240s, 480s indexed off the post-increment
 * attempt count; a non-incrementing reschedule reuses the current level
 * (≈15s when attempts is still 0). Bounded; on the final attempt the
 * 5-minute chain cooldown dominates anyway.
 */
export async function rescheduleForRetry(
  id: number,
  failure: { code: string; message: string },
  opts: { incrementAttempts?: boolean } = {},
): Promise<{ state: BridgeImportState; attempts: number; scheduledAt: Date | null }> {
  const incrementAttempts = opts.incrementAttempts ?? true;
  const pool = getAppPool();
  if (!pool) {
    return { state: 'failed', attempts: 0, scheduledAt: null };
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const current = await client.query<{ attempts: number }>(
      `SELECT attempts FROM bridge_import_queue WHERE id = $1 FOR UPDATE`,
      [id],
    );
    if (current.rows.length === 0) {
      await client.query('ROLLBACK');
      return { state: 'failed', attempts: 0, scheduledAt: null };
    }
    const attempts = incrementAttempts ? current.rows[0].attempts + 1 : current.rows[0].attempts;
    if (incrementAttempts && attempts > BRIDGE_QUEUE_MAX_ATTEMPTS) {
      await client.query(
        `UPDATE bridge_import_queue
            SET state = 'failed',
                attempts = $2,
                error_code = $3,
                error_message = $4,
                completed_at = NOW(),
                updated_at = NOW(),
                lease_expires_at = NULL
          WHERE id = $1`,
        [id, attempts, failure.code, failure.message],
      );
      await client.query('COMMIT');
      return { state: 'failed', attempts, scheduledAt: null };
    }
    // Backoff schedule indexed off attempts (1-based after increment):
    //   1 -> 30s, 2 -> 60s, 3 -> 120s, 4 -> 240s, 5 -> 480s.
    const backoffSeconds = 30 * Math.pow(2, attempts - 1);
    const { rows } = await client.query<{ scheduled_at: Date }>(
      `UPDATE bridge_import_queue
          SET state = 'pending',
              attempts = $2,
              scheduled_at = NOW() + ($3::int * INTERVAL '1 second'),
              error_code = $4,
              error_message = $5,
              updated_at = NOW(),
              lease_expires_at = NULL
        WHERE id = $1
        RETURNING scheduled_at`,
      [id, attempts, backoffSeconds, failure.code, failure.message],
    );
    await client.query('COMMIT');
    return { state: 'pending', attempts, scheduledAt: rows[0]?.scheduled_at ?? null };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/**
 * List a user's queue entries, newest first. Used by the "My imports"
 * read endpoint. The `state` filter is optional; when absent, all states
 * are returned.
 */
export async function listUserImports(
  username: string,
  opts: { state?: BridgeImportState; limit?: number } = {},
): Promise<BridgeImportRow[]> {
  const pool = getAppPool();
  if (!pool) return [];
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const params: unknown[] = [username];
  let stateClause = '';
  if (opts.state) {
    params.push(opts.state);
    stateClause = `AND state = $${params.length}`;
  }
  params.push(limit);
  const { rows } = await pool.query<Record<string, unknown>>(
    `SELECT * FROM bridge_import_queue
       WHERE username = $1 ${stateClause}
       ORDER BY id DESC
       LIMIT $${params.length}`,
    params,
  );
  return rows.map(rowToBridgeImport);
}

/**
 * Look up the timestamp of the most recent successful bridge broadcast on
 * the queue. Used by the worker's cadence gate so the next dispatch
 * respects the chain's per-account cooldown across worker restarts.
 *
 * Returns null when no entry has completed yet (first run or table was
 * pruned).
 */
export async function getLastSuccessfulBroadcastAt(): Promise<Date | null> {
  const pool = getAppPool();
  if (!pool) return null;
  const { rows } = await pool.query<{ completed_at: Date | null }>(
    `SELECT completed_at FROM bridge_import_queue
       WHERE state = 'completed' AND tx_id IS NOT NULL
       ORDER BY completed_at DESC NULLS LAST
       LIMIT 1`,
  );
  return rows[0]?.completed_at ?? null;
}

/**
 * Retire terminal (completed/failed) entries whose terminal timestamp is
 * older than {@link BRIDGE_QUEUE_RETENTION_MS}. Pending/in_progress rows are
 * never touched, so the per-user cap accounting (which counts only those) is
 * unaffected. Returns the number of rows deleted.
 *
 * Honors migration 010's "ageing purges retire rows" assertion. Invoked on a
 * low-frequency worker tick, not per-request; at beta volume a seq scan over
 * terminal rows is acceptable, so no dedicated index backs the predicate.
 * The threshold is computed in JS (not via SQL interval math) so the
 * millisecond retention does not overflow an int4 interval multiplier.
 */
export async function purgeAgedTerminalEntries(
  retentionMs: number = BRIDGE_QUEUE_RETENTION_MS,
): Promise<number> {
  const pool = getAppPool();
  if (!pool) return 0;
  const threshold = new Date(Date.now() - retentionMs);
  const result = await pool.query(
    `DELETE FROM bridge_import_queue
      WHERE state IN ('completed', 'failed')
        AND completed_at IS NOT NULL
        AND completed_at < $1`,
    [threshold],
  );
  return result.rowCount ?? 0;
}

/**
 * Count a user's currently-inflight entries (pending + in_progress). Not
 * used by the production route or worker — the route's cap-feedback message
 * comes from `tryEnqueueBridgeImport`'s atomic `cap_exceeded` branch, which
 * already returns the inflight count. Exposed for tests so they can assert
 * per-user cap accounting without re-deriving the WHERE.
 */
export async function countInflightForUser(username: string): Promise<number> {
  const pool = getAppPool();
  if (!pool) return 0;
  const { rows } = await pool.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count
       FROM bridge_import_queue
      WHERE username = $1 AND state IN ('pending', 'in_progress')`,
    [username],
  );
  return Number(rows[0]?.count ?? '0');
}

/**
 * Helper for tests: re-fetch a specific entry by id. Not used by the
 * production route or worker; the worker pulls via `leaseNextEntry` and
 * the route reads via `listUserImports`. Exposed so tests can assert on
 * exact post-transition shape without re-deriving the WHERE.
 */
export async function findEntryById(id: number): Promise<BridgeImportRow | null> {
  const pool = getAppPool();
  if (!pool) return null;
  const { rows } = await pool.query<Record<string, unknown>>(
    `SELECT * FROM bridge_import_queue WHERE id = $1`,
    [id],
  );
  if (rows.length === 0) return null;
  return rowToBridgeImport(rows[0]);
}

/**
 * Log a structured warning when an entry is rescheduled. Centralized so
 * the worker call sites stay terse. The `event:` literal is the
 * dashboard-keyable anchor.
 */
export function logRetry(row: BridgeImportRow, attempts: number, scheduledAt: Date | null): void {
  logger.warn(
    {
      event: 'bridge.queue.retry',
      route: 'bridge.queue',
      entry_id: row.id,
      username: row.username,
      permlink: row.permlink,
      attempts,
      scheduled_at: scheduledAt?.toISOString() ?? null,
    },
    'bridge queue entry rescheduled for retry',
  );
}
