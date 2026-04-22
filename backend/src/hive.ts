import { Client, type PrivateKey } from '@hiveio/dhive';
import { config } from './config.js';
import { logger, getRequestId } from './logger.js';

/**
 * Creates a dhive Client with multi-node failover.
 * dhive natively supports an array of nodes and cycles through them on failure.
 */
export const hiveClient = new Client(config.hiveApiNodes, {
  timeout: 10_000,
  failoverThreshold: 3,
});

/**
 * Non-blocking startup health check: verifies at least one Hive API node is reachable.
 * Logs a warning if all nodes fail but does not prevent startup (Hive may recover).
 */
export async function checkHiveNodes(): Promise<void> {
  try {
    const props = await hiveClient.database.getDynamicGlobalProperties();
    logger.info(
      { headBlock: props.head_block_number, node: config.hiveApiNodes[0] },
      'Hive API node reachable',
    );
  } catch (err) {
    logger.warn(
      { err, nodes: config.hiveApiNodes, reqId: getRequestId() },
      'Hive API nodes unreachable at startup — broadcasts will fail until nodes recover',
    );
  }
}

export class BroadcastTimeoutError extends Error {
  constructor(public readonly timeoutMs: number) {
    super(`Hive broadcast timed out after ${timeoutMs}ms`);
    this.name = 'BroadcastTimeoutError';
    // V8-only; guard is hygiene. Points the stack trace at the caller of the
    // broadcast helper instead of the internal Promise.race timeout closure.
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, BroadcastTimeoutError);
    }
  }
}

export const DEFAULT_BROADCAST_TIMEOUT_MS = 30_000;

type BroadcastJsonPayload = Parameters<typeof hiveClient.broadcast.json>[0];
type BroadcastJsonResult = Awaited<ReturnType<typeof hiveClient.broadcast.json>>;

/**
 * Wraps hiveClient.broadcast.json with a wall-clock timeout.
 *
 * dhive leaves broadcast fetch calls without a per-request timeout
 * (@hiveio/dhive/lib/client.js:166-170 — `fetchTimeout` is set only when
 * `!isBroadcast`). A slow-but-alive Hive node can hold the socket open
 * indefinitely. Without this wrapper the ORCID binding lock's 35s TTL has
 * no real safety margin: broadcast A can execute for >35s, the lock auto-
 * expires, broadcast B acquires a new lock and fires the same custom_json,
 * and both broadcasts land on chain.
 *
 * The timeout rejects the outer promise at `timeoutMs`; the underlying
 * dhive fetch may continue in the background until node-fetch's default
 * socket idle or until the Hive node closes the connection. That orphan
 * is wasteful but acceptable — the request handler and any caller lock
 * release on the BroadcastTimeoutError.
 *
 * Throws `BroadcastTimeoutError` on timeout; underlying dhive errors
 * propagate unchanged on the fast-path failure.
 */
export async function broadcastJsonWithTimeout(
  payload: BroadcastJsonPayload,
  key: PrivateKey,
  timeoutMs: number = DEFAULT_BROADCAST_TIMEOUT_MS,
): Promise<BroadcastJsonResult> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new BroadcastTimeoutError(timeoutMs)), timeoutMs);
  });
  try {
    return await Promise.race([hiveClient.broadcast.json(payload, key), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

type BroadcastSendOperationsArgs = Parameters<typeof hiveClient.broadcast.sendOperations>;
type BroadcastSendOperationsOps = BroadcastSendOperationsArgs[0];
type BroadcastSendOperationsResult = Awaited<
  ReturnType<typeof hiveClient.broadcast.sendOperations>
>;

/**
 * Wraps hiveClient.broadcast.sendOperations with a wall-clock timeout.
 *
 * Same reasoning as `broadcastJsonWithTimeout`: dhive's `Client.timeout`
 * only applies to read (non-broadcast) calls; broadcast fetches can hang
 * indefinitely against a slow-but-alive Hive node. Any caller lock or
 * request handler relying on this returning in bounded time needs this
 * wrapper. See the sibling helper above for the full rationale.
 *
 * Two-phase-timeout ambiguity caveat: dhive's `sendOperations` follows
 * the same preflight-read-then-broadcast pattern as `broadcast.json`
 * (fetch dynamic-global-properties, sign, then POST the tx). A timeout
 * can fire after the tx has already been accepted into a Hive node's
 * mempool, so a `BroadcastTimeoutError` does NOT imply the operation
 * did not land. Callers that track on-chain state (e.g. DB counters
 * mirroring `claim_account` successes, ORCID binding custom_json
 * attestations) must assume orphan-outcome on timeout and reconcile
 * against chain state, not retry blindly. The outer promise rejects at
 * `timeoutMs`; the underlying dhive fetch may continue in the
 * background until node-fetch's default socket idle or until the Hive
 * node closes the connection. That orphan is wasteful but acceptable
 * — the request handler and any caller lock release on the
 * BroadcastTimeoutError.
 *
 * Throws `BroadcastTimeoutError` on timeout; underlying dhive errors
 * propagate unchanged on the fast-path failure.
 */
export async function broadcastSendOperationsWithTimeout(
  operations: BroadcastSendOperationsOps,
  key: PrivateKey,
  timeoutMs: number = DEFAULT_BROADCAST_TIMEOUT_MS,
): Promise<BroadcastSendOperationsResult> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new BroadcastTimeoutError(timeoutMs)), timeoutMs);
  });
  try {
    return await Promise.race([
      hiveClient.broadcast.sendOperations(operations, key),
      timeout,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
