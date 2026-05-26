/**
 * In-process worker for the bridge import queue.
 *
 * Runs inside the existing backend Express server (no separate worker
 * service for v1). Polls the queue at a fixed interval. On each tick:
 *
 *   1. Check the cadence gate: have we waited at least
 *      `BRIDGE_CHAIN_COOLDOWN_MS` since the last successful broadcast?
 *      If not, skip (the chain will reject anyway).
 *   2. Lease the oldest due entry.
 *   3. Re-fetch metadata from the upstream source, re-check for an
 *      on-chain duplicate (HAF lookup), broadcast.
 *   4. On success: mark completed.
 *      On permlink-collision: mark completed with the existing record.
 *      On transient failure: reschedule with backoff (or terminal-fail
 *      after `BRIDGE_QUEUE_MAX_ATTEMPTS`).
 *      On metadata gone / permanent failure: mark failed.
 *
 * The worker is intentionally single-instance (one in-process timer). The
 * `SELECT ... FOR UPDATE SKIP LOCKED` shape in `leaseNextEntry` is
 * defense-in-depth in case a future deploy adds horizontal scaling; today
 * the single instance is the design (memory `project_single_instance_only`).
 */

import { getRequiredBridgePostingKey, BridgeKeyCacheUnpopulated } from './startup-checks.js';
import { broadcastSendOperationsWithTimeout, BroadcastTimeoutError } from './hive.js';
import { config } from './config.js';
import { logger } from './logger.js';
import { findBridgeDuplicate } from './bridge-haf.js';
import {
  lookupPreprint,
  resolveToCanonical,
  buildBridgeBody,
  buildBridgeMetadata,
  type ParsedIdentifier,
} from './bridge.js';
import {
  leaseNextEntry,
  markCompleted,
  markCompletedExisting,
  markFailed,
  rescheduleForRetry,
  getLastSuccessfulBroadcastAt,
  logRetry,
  BRIDGE_CHAIN_COOLDOWN_MS,
  type BridgeImportRow,
} from './bridge-queue.js';

/** Worker tick cadence. Short relative to the chain cooldown so a freshly
 *  enqueued entry begins dispatch promptly when no broadcast has fired
 *  recently; the cooldown gate stops back-to-back broadcasts. */
const WORKER_TICK_MS = 5_000;

let workerTimer: ReturnType<typeof setInterval> | null = null;
/** Re-entrancy guard so a slow tick (long broadcast, slow upstream fetch)
 *  does not stack a second invocation. */
let tickInFlight = false;
/** Last successful broadcast wall-clock (ms). Tracked in-process so the
 *  cadence gate does not hit the DB every tick; refreshed from DB at
 *  startup so a restart cannot bypass the gate by losing in-memory state. */
let lastBroadcastMs = 0;

/**
 * On-chain duplicate check for an already-resolved parsed identifier +
 * permlink. Delegates the two-query HAF lookup to the shared
 * `findBridgeDuplicate` (the same source of truth the route's
 * `checkExistingBridge` uses) and maps the result into the worker's
 * fail-closed vocabulary.
 *
 * Returns:
 *   - { kind: 'exists', author, permlink } — duplicate found on chain
 *   - { kind: 'none' } — no duplicate found OR HAF skipped (unconfigured)
 *   - { kind: 'haf_unavailable' } — HAF query threw; caller should NOT
 *     broadcast (the cooldown window is precious; consuming it on a
 *     potentially-duplicate broadcast is worse than waiting one tick).
 */
type WorkerDuplicateCheck =
  | { kind: 'exists'; author: string; permlink: string }
  | { kind: 'none' }
  | { kind: 'haf_unavailable' };

async function checkExistingOnChain(
  parsed: ParsedIdentifier,
  permlink: string,
): Promise<WorkerDuplicateCheck> {
  if (parsed.type !== 'arxiv' && parsed.type !== 'doi') {
    return { kind: 'none' };
  }
  // Narrow the identifier to the canonical {arxiv|doi} shape the shared
  // helper expects (control-flow narrows the `.type` read, not the whole
  // ParsedIdentifier object).
  const canonical = { type: parsed.type, id: parsed.id };
  try {
    const dup = await findBridgeDuplicate(canonical, permlink);
    return dup ? { kind: 'exists', author: dup.author, permlink: dup.permlink } : { kind: 'none' };
  } catch (err) {
    logger.warn(
      { err, permlink, event: 'bridge.queue.haf_check_failed', route: 'bridge.queue' },
      'Bridge queue HAF duplicate check failed',
    );
    return { kind: 'haf_unavailable' };
  }
}

/**
 * Dispatch a single entry. Exported for direct invocation in tests so the
 * worker's behaviour is verifiable without spinning a ticker.
 */
export async function dispatchEntry(entry: BridgeImportRow): Promise<void> {
  // Re-resolve the canonical identifier shape. Identifier is the
  // user-supplied input; the canonical (arxiv|doi, id) tuple is
  // recomputable, and resolving it here keeps the dispatch path
  // self-contained.
  let parsed;
  try {
    parsed = await resolveToCanonical(entry.identifier);
  } catch (err) {
    logger.error(
      { err, entry_id: entry.id, identifier: entry.identifier, event: 'bridge.queue.identifier_resolution_failed', route: 'bridge.queue' },
      'Bridge queue identifier resolution failed',
    );
    await markFailed(entry.id, {
      code: 'BAD_REQUEST',
      message: 'Failed to re-resolve identifier at dispatch',
    });
    return;
  }
  if (!parsed) {
    await markFailed(entry.id, {
      code: 'BAD_REQUEST',
      message: 'Identifier no longer resolvable at dispatch',
    });
    return;
  }

  // Re-fetch metadata. The metadata source may have changed (or gone away)
  // between enqueue and dispatch. A failure discovered here resolves the
  // entry — terminal-fail when the source is permanently gone, reschedule
  // when the outage is transient — without consuming the chain cooldown
  // window reserved for the next entry's broadcast.
  let meta;
  try {
    meta = await lookupPreprint(entry.identifier);
  } catch (err) {
    logger.warn(
      { err, entry_id: entry.id, identifier: entry.identifier, event: 'bridge.queue.metadata_fetch_failed', route: 'bridge.queue' },
      'Bridge queue metadata fetch failed at dispatch',
    );
    // Metadata fetch is a transient external-API call; reschedule with
    // backoff rather than fail terminally on the first attempt. This is a
    // pre-broadcast outage — it must NOT consume the broadcast retry budget,
    // or a sustained metadata-source outage would terminal-fail a valid
    // submission that never reached a broadcast.
    const result = await rescheduleForRetry(
      entry.id,
      { code: 'BAD_REQUEST', message: 'Metadata source unavailable at dispatch' },
      { incrementAttempts: false },
    );
    if (result.state === 'pending') logRetry(entry, result.attempts, result.scheduledAt);
    return;
  }
  if (!meta) {
    await markFailed(entry.id, {
      code: 'BAD_REQUEST',
      message: 'Source preprint no longer available',
    });
    return;
  }

  // Permlink-collision short-circuit: when the paper is already on chain,
  // the queue does not re-broadcast. It completes the entry with the
  // existing record so the submitter sees a terminal success pointing at
  // the existing post. This sits in front of the per-permlink
  // bridge_register_lock semantics rather than replacing them.
  const onChain = await checkExistingOnChain(parsed, entry.permlink);
  if (onChain.kind === 'exists') {
    await markCompletedExisting(entry.id, {
      author: onChain.author,
      permlink: onChain.permlink,
    });
    return;
  }
  if (onChain.kind === 'haf_unavailable') {
    // Do NOT broadcast on HAF outage; reschedule with backoff. The chain
    // cooldown is precious — using it on a duplicate would lose the
    // ~5-minute slot. Pre-broadcast outage: does NOT consume the broadcast
    // retry budget, so a sustained HAF outage reschedules until HAF recovers
    // rather than terminal-failing a valid submission.
    const result = await rescheduleForRetry(
      entry.id,
      { code: 'SERVICE_UNAVAILABLE', message: 'HAF duplicate-check unavailable; will retry' },
      { incrementAttempts: false },
    );
    if (result.state === 'pending') logRetry(entry, result.attempts, result.scheduledAt);
    return;
  }

  // Build the post and broadcast.
  let key;
  try {
    key = getRequiredBridgePostingKey();
  } catch (err) {
    if (err instanceof BridgeKeyCacheUnpopulated) {
      logger.error(
        { err, entry_id: entry.id, event: 'bridge.queue.key_cache_unpopulated', route: 'bridge.queue' },
        'Bridge queue dispatch reached broadcast with unpopulated key cache',
      );
    }
    // Operator-misconfig class — terminal failure. The next deploy with a
    // correct key restores service for future enqueues; the entry stays
    // failed so the user can be told to retry.
    await markFailed(entry.id, {
      code: 'SERVICE_UNAVAILABLE',
      message: 'Bridge posting key not configured',
    });
    return;
  }

  const body = buildBridgeBody(meta, entry.username);
  const jsonMetadata = buildBridgeMetadata(
    meta,
    entry.username,
    entry.discipline,
    entry.keywords,
    entry.language,
    1,
    meta.title,
    body,
    config.hiveBridgeAccount,
    entry.permlink,
  );

  let broadcastResult;
  try {
    broadcastResult = await broadcastSendOperationsWithTimeout(
      [
        ['comment', {
          parent_author: '',
          parent_permlink: config.appTag,
          author: config.hiveBridgeAccount,
          permlink: entry.permlink,
          title: meta.title.length > 256 ? meta.title.slice(0, 253) + '...' : meta.title,
          body,
          json_metadata: JSON.stringify(jsonMetadata),
        }],
        ['comment_options', {
          author: config.hiveBridgeAccount,
          permlink: entry.permlink,
          max_accepted_payout: '1000000.000 HBD',
          percent_hbd: 0,
          allow_votes: true,
          allow_curation_rewards: true,
          extensions: [],
        }],
      ],
      key,
    );
  } catch (err) {
    const isTimeout = err instanceof BroadcastTimeoutError;
    const code = isTimeout ? 'BROADCAST_TIMEOUT' : 'BROADCAST_FAILED';
    const message = isTimeout
      ? 'Broadcasting bridge paper registration timed out'
      : 'Failed to broadcast bridge paper registration to Hive';
    logger.warn(
      {
        err,
        event: 'bridge.queue.dispatch.failure',
        route: 'bridge.queue',
        entry_id: entry.id,
        username: entry.username,
        permlink: entry.permlink,
        outcome: isTimeout ? 'timeout' : 'failure',
      },
      'bridge queue dispatch failure',
    );
    // A timed-out broadcast may still have landed on chain: treat the
    // cooldown window as consumed so we do not back-to-back another
    // broadcast. Record it before the reschedule write for the same reason
    // the success path records it before markCompleted (below).
    if (isTimeout) lastBroadcastMs = Date.now();
    const result = await rescheduleForRetry(entry.id, { code, message });
    if (result.state === 'pending') logRetry(entry, result.attempts, result.scheduledAt);
    return;
  }

  // Broadcast landed. Record the cooldown BEFORE the completion write: if
  // markCompleted throws, the cooldown must still be honored, or the next
  // tick would broadcast again inside the chain's ~5-minute window.
  lastBroadcastMs = Date.now();
  try {
    await markCompleted(entry.id, { txId: broadcastResult.id });
  } catch (err) {
    // The broadcast succeeded but persisting completion failed. This is NOT
    // a broadcast failure — labelling it BROADCAST_FAILED would misreport a
    // post that is already on chain. Reschedule without consuming the
    // broadcast budget; the next tick's pre-broadcast checkExistingOnChain
    // reconciliation finds the now-on-chain post and short-circuits to
    // markCompletedExisting (terminal), so this does not loop.
    logger.error(
      {
        err,
        event: 'bridge.queue.dispatch.post_broadcast_write_failed',
        route: 'bridge.queue',
        entry_id: entry.id,
        username: entry.username,
        permlink: entry.permlink,
        tx_id: broadcastResult.id,
      },
      'bridge queue broadcast landed but completion write failed; will reconcile',
    );
    const result = await rescheduleForRetry(
      entry.id,
      { code: 'COMPLETION_WRITE_FAILED', message: 'Broadcast landed; completion write failed, will reconcile' },
      { incrementAttempts: false },
    );
    if (result.state === 'pending') logRetry(entry, result.attempts, result.scheduledAt);
    return;
  }
  logger.info(
    {
      event: 'bridge.queue.dispatch.success',
      route: 'bridge.queue',
      entry_id: entry.id,
      username: entry.username,
      permlink: entry.permlink,
      tx_id: broadcastResult.id,
    },
    'bridge queue dispatch success',
  );
}

/**
 * Single worker tick. Honors the cadence gate, leases one entry, and
 * dispatches it. Exported for tests.
 */
export async function runWorkerTick(): Promise<void> {
  if (tickInFlight) return;
  tickInFlight = true;
  try {
    const now = Date.now();
    if (now - lastBroadcastMs < BRIDGE_CHAIN_COOLDOWN_MS) return;
    const entry = await leaseNextEntry();
    if (!entry) return;
    await dispatchEntry(entry);
  } catch (err) {
    logger.error({ err, event: 'bridge.queue.tick_failed', route: 'bridge.queue' }, 'Bridge queue worker tick failed');
  } finally {
    tickInFlight = false;
  }
}

/**
 * Start the worker. Should be called once after `app.listen` resolves so
 * the ticker is not contending with boot-time HAF warmup.
 *
 * Initial seed of `lastBroadcastMs` from the DB closes the restart-bypass
 * window: a restart that lost in-memory state would otherwise pass the
 * cadence gate immediately and broadcast in violation of the cooldown.
 */
export async function startBridgeWorker(): Promise<void> {
  if (workerTimer) return;
  try {
    const lastSuccess = await getLastSuccessfulBroadcastAt();
    if (lastSuccess) lastBroadcastMs = lastSuccess.getTime();
  } catch (err) {
    logger.warn(
      { err, event: 'bridge.queue.last_success_seed_failed', route: 'bridge.queue' },
      'Bridge queue last-success seed failed; cooldown will gate on in-process state only',
    );
  }
  workerTimer = setInterval(() => {
    void runWorkerTick();
  }, WORKER_TICK_MS);
  workerTimer.unref();
  logger.info(
    { event: 'bridge.queue.worker_started', route: 'bridge.queue', tickMs: WORKER_TICK_MS },
    'Bridge import queue worker started',
  );
}

export function stopBridgeWorker(): void {
  if (workerTimer) {
    clearInterval(workerTimer);
    workerTimer = null;
  }
}

/**
 * Test-only: reset in-process worker state (cadence timestamp, in-flight
 * flag). Production code does not call this. Exported so tests do not
 * have to reach into the module's private state.
 */
export function _resetBridgeWorkerForTests(): void {
  lastBroadcastMs = 0;
  tickInFlight = false;
}
