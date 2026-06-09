import { Client, PrivateKey } from '@hiveio/dhive';
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
    // Round-5 hold #1 (BE-HANDLE-BROADCAST-ERROR-HELPER): the canonical
    // input-validation site is now the wrapper entry below
    // (`assertFinitePositiveTimeoutMs`), NOT this constructor. Round 4
    // placed the guard here, but the only throw site is inside the
    // `setTimeout(() => reject(new BroadcastTimeoutError(timeoutMs)))`
    // closure: a synchronous throw from the constructor fires *before*
    // `reject()` is called, so the wrapping `Promise.race` never observes
    // the rejection. The throw escapes to `process.on('uncaughtException')`
    // and crashes the process. Strictly worse than the regression it was
    // meant to prevent (a `null` timeout_ms field). The wrapper-entry guard
    // throws as a normal async-function rejection that reaches the route
    // catch and emits a 502 `BROADCAST_FAILED` envelope via
    // `handleBroadcastError`'s non-timeout branch.
    //
    // The constructor guard is kept as belt-and-suspenders: it never fires
    // in practice once the wrapper-entry check is in place, and dropping it
    // would lose the "single source of truth" framing for any future caller
    // that constructs the error directly. If it ever did fire it would be
    // from a non-wrapper caller (e.g. a future test fixture or unit-level
    // throw) where synchronous throw semantics are fine.
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new RangeError(
        `BroadcastTimeoutError requires a finite positive timeoutMs; got ${String(timeoutMs)}`,
      );
    }
    super(`Hive broadcast timed out after ${timeoutMs}ms`);
    this.name = 'BroadcastTimeoutError';
    // V8-only; guard is hygiene. Points the stack trace at the caller of the
    // broadcast helper instead of the internal Promise.race timeout closure.
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, BroadcastTimeoutError);
    }
  }
}

/**
 * Wrapper-entry guard for `timeoutMs`. Validates the same invariant the
 * `BroadcastTimeoutError` constructor enforces, but at the entry of
 * `broadcastJsonWithTimeout` / `broadcastSendOperationsWithTimeout` so the
 * `RangeError` propagates as a normal async-function rejection (reaches the
 * route's catch → `handleBroadcastError` → 502 `BROADCAST_FAILED` envelope)
 * instead of firing inside the `setTimeout` callback as an
 * `uncaughtException` (which would crash the process before any envelope is
 * written). Round-5 hold #1 (BE-HANDLE-BROADCAST-ERROR-HELPER).
 */
function assertFinitePositiveTimeoutMs(timeoutMs: number, fnName: string): void {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError(
      `${fnName} requires a finite positive timeoutMs; got ${String(timeoutMs)}`,
    );
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
  // Validate at the wrapper entry, BEFORE scheduling the timer or invoking
  // dhive: a `RangeError` thrown here propagates as a normal async-function
  // rejection (reaches the route's catch → `handleBroadcastError`'s 502
  // `BROADCAST_FAILED` envelope). Validating inside the `setTimeout` callback
  // via the constructor guard would fire as an uncaughtException and crash
  // the process. Round-5 hold #1 (BE-HANDLE-BROADCAST-ERROR-HELPER).
  assertFinitePositiveTimeoutMs(timeoutMs, 'broadcastJsonWithTimeout');
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
  // Round-5 hold #1: same wrapper-entry validation as
  // `broadcastJsonWithTimeout`. See its comment for the full rationale.
  assertFinitePositiveTimeoutMs(timeoutMs, 'broadcastSendOperationsWithTimeout');
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

/**
 * Thrown by `broadcastAdminCustomJson` when the admin posting key
 * (`config.pevoAdminPostingKey`) is unset. This is a LIVE failure mode of the
 * helper: it checks the key on every call and throws before broadcasting, so
 * the throw is reachable from any adopter that does not pre-guard the key.
 * Adopters handle it two ways:
 *   - A WoT-style caller catches it inline and reports a `skipped` result.
 *   - A route caller pre-guards (or skip-guards) the key and returns its own
 *     response shape on the unset-key path (e.g. 500 "admin posting key not
 *     configured", or skipping the broadcast), OR lets the throw fall into
 *     `handleBroadcastError`, which maps it to a generic 502.
 * Pre-guard at the call site whenever the unset-key path needs a response shape
 * more specific than that generic 502.
 */
export class AdminKeyNotConfiguredError extends Error {
  constructor() {
    super('PEvO admin posting key is not configured; admin custom_json broadcast unavailable');
    this.name = 'AdminKeyNotConfiguredError';
  }
}

/**
 * The PEvO admin account (`config.hiveAdminAccount`) signs platform
 * attestations — WoT accreditation grants/revocations, authorship-claim
 * revocations, and ORCID binding attestations — as a single posting authority.
 * This helper is the one place the admin custom_json envelope (`id`,
 * `required_auths`, `required_posting_auths`) and the admin posting key are
 * assembled, so every admin-broadcast call site stays in lockstep.
 *
 * Throws `AdminKeyNotConfiguredError` when the admin posting key is unset.
 * Broadcast failures (timeout, node rejection) propagate unchanged from
 * `broadcastJsonWithTimeout` — `BroadcastTimeoutError` included — for the
 * caller's existing catch to discriminate.
 */
export async function broadcastAdminCustomJson(
  payload: Record<string, unknown>,
  timeoutMs: number = DEFAULT_BROADCAST_TIMEOUT_MS,
): Promise<BroadcastJsonResult> {
  if (!config.pevoAdminPostingKey) {
    throw new AdminKeyNotConfiguredError();
  }
  return broadcastJsonWithTimeout(
    {
      id: config.appTag,
      required_auths: [],
      required_posting_auths: [config.hiveAdminAccount],
      json: JSON.stringify(payload),
    },
    PrivateKey.fromString(config.pevoAdminPostingKey),
    timeoutMs,
  );
}
