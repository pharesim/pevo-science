// Deterministic JS-level concurrency cap on argon2 operations.
//
// Rationale (from BE-ARGON2-JSLEVEL-CONCURRENCY-CAP):
//
// 1. argon2's `parallelism=4` option (see ARGON2_OPTIONS) means each hash/
//    verify holds 4 libuv threads for its duration. At UV_THREADPOOL_SIZE=16
//    that mathematically allows floor(16 / 4) = 4 concurrent argon2 ops,
//    NOT 16.
//
// 2. Under a burst of 5+ concurrent auth requests, the libuv pool saturates
//    and queued calls can throw at the thread level. burnSentinel swallows
//    those throws via its `.catch` (to avoid leaking error details), which
//    reopens the timing oracle it's designed to close: ~50ms "real verify"
//    paths alongside ~0ms "silently-threw" paths.
//
// 3. A JS-level semaphore capping concurrent ops at MAX_CONCURRENT_ARGON2_OPS
//    = floor(UV_THREADPOOL_SIZE / ARGON2_OPTIONS.parallelism) = 4 makes the
//    queueing deterministic: extras wait in JS, each op completes in bounded
//    time, no saturation throws, no oracle reopening. Queue depth is
//    observable via a counter (getArgon2QueueDepth) exposed through
//    /api/health so operators see saturation events without depending on
//    pino async-transport drainage under OOM.
//
// 4. Memory ceiling under the cap: 4 × 64 MiB (ARGON2_OPTIONS.memoryCost) =
//    256 MiB peak, well within the 512m docker container limit and
//    decoupled from UV_THREADPOOL_SIZE. Raising the pool for unrelated
//    libuv work (fs, dns) no longer raises argon2 memory pressure.
//
// 5. Queue-depth cap (MAX_QUEUE_DEPTH). An unbounded waiters array is a DoS
//    vector: N attacker IPs × per-IP rate-limit × multiple auth endpoints can
//    grow the queue to hundreds of waiters, each holding an open HTTP
//    connection. Legit users then wait 6+ seconds at cap=4, 50ms/op × 400
//    waiters. Capping the queue and throwing `ArgonQueueFullError` bounds
//    the waiting-time worst case. burnSentinel's catch MUST NOT swallow this
//    error — swallowing would return ~0ms under queue-full conditions and
//    reopen the timing oracle. Route handlers translate the error into
//    503 SERVICE_UNAVAILABLE.
//
// Implementation: a simple Promise-queue + counter. Chose an in-repo ~20 LoC
// primitive over adding a `p-limit` dep because (a) this sits on the
// authentication hot path and minimizing supply-chain surface matters, and
// (b) the required semantics fit in trivially-auditable code.

import { ARGON2_OPTIONS } from './argon2-options.js';
import { logger } from '../logger.js';

// Derive from known knobs. At UV_THREADPOOL_SIZE=16 and parallelism=4 this
// is 4. If either knob changes, the cap auto-adjusts; the load-bearing
// invariant is `cap ≤ floor(pool / parallelism)`, enforced by the
// startup assertion in routes/auth.ts.
function computeCap(): number {
  const pool = Number(process.env.UV_THREADPOOL_SIZE);
  const parallelism = ARGON2_OPTIONS.parallelism;
  if (Number.isFinite(pool) && pool > 0) {
    return Math.max(1, Math.floor(pool / parallelism));
  }
  // Fallback for Vitest / bare-metal dev where UV_THREADPOOL_SIZE is unset.
  // Match the default libuv pool (4) divided by parallelism (4) = 1. Slow
  // under unit-test concurrent bursts but correct for fail-loud determinism.
  return 1;
}

export const MAX_CONCURRENT_ARGON2_OPS = computeCap();

// Default queue-depth cap. 50 is sized so that at cap=4 × 50ms/op, the
// worst-case wait for a queued request is ~625ms — well under typical HTTP
// client timeouts, and far short of the minutes-long wait an unbounded
// queue could produce under adversarial load.
export const MAX_QUEUE_DEPTH = 50;

/**
 * Abstract base class for every error thrown by the argon2 semaphore. Lets
 * route handlers do a single `if (err instanceof ArgonSemaphoreError)`
 * dispatch (via `handleArgonError`) instead of repeating a 3-way instanceof
 * chain, and gives the type system one anchor to enforce coverage when a
 * future 4th error class is added.
 *
 * Marked abstract so a stray `throw new ArgonSemaphoreError()` won't compile
 * — the only instances on the wire are the three concrete subclasses below.
 */
export abstract class ArgonSemaphoreError extends Error {
  constructor(message: string) {
    super(message);
    // Subclasses overwrite `this.name`; default falls back to the JS class
    // name if a future subclass forgets.
    this.name = new.target.name;
  }
}

/**
 * Thrown by `runWithArgon2Slot` (and by the process-wide default semaphore)
 * when the waiter queue is at `MAX_QUEUE_DEPTH`. Callers MUST re-throw or
 * translate to 503; swallowing this error silently inside burnSentinel would
 * reopen the timing oracle under DoS conditions (~0ms response instead of
 * the argon2.verify floor).
 */
export class ArgonQueueFullError extends ArgonSemaphoreError {
  constructor(message = 'argon2 semaphore queue full') {
    super(message);
    this.name = 'ArgonQueueFullError';
  }
}

/**
 * Thrown by `runWithArgon2Slot` after `drainArgon2Queue()` has been called.
 * Signals that the process is shutting down: pending waiters are rejected
 * with this error, and any subsequent call throws immediately without
 * queueing. Route handlers MUST translate to 503 SERVICE_UNAVAILABLE so
 * Express can flush a clean response before `server.close()` + the 30s
 * force-timeout in `index.ts shutdown()` tears the socket down.
 *
 * Distinct from `ArgonQueueFullError`: that one is transient (queue
 * saturation), this one is terminal (process exiting). Both map to the
 * same HTTP code, but operators distinguish them by log message so they
 * can separate "increase capacity" from "benign during rolling restart".
 */
export class ShuttingDownError extends ArgonSemaphoreError {
  constructor(message = 'argon2 semaphore shutting down') {
    super(message);
    this.name = 'ShuttingDownError';
  }
}

/**
 * Options accepted by `runWithArgon2Slot`. `signal` lets the caller abort
 * a queued waiter before its slot is granted — on abort, the waiter is
 * rejected with `AbortError`, the slot is never acquired, and the next
 * queued waiter is drained. Does NOT cancel an in-flight argon2 operation
 * (argon2 is native and not AbortSignal-aware); once fn() has started it
 * runs to completion.
 */
export interface RunWithArgon2SlotOptions {
  signal?: AbortSignal;
}

/**
 * Thrown by `runWithArgon2Slot` when a queued waiter is aborted via the
 * `signal` option before its slot is granted. Route handlers SHOULD NOT
 * translate this into a visible HTTP response (the client has already
 * disconnected); log at debug and return silently so Express can close
 * the already-dead socket without writing a 500.
 */
export class ArgonAbortError extends ArgonSemaphoreError {
  constructor(message = 'argon2 slot aborted') {
    super(message);
    this.name = 'AbortError'; // Matches DOMException('…', 'AbortError') idiom.
  }
}

export interface Argon2Semaphore {
  runWithArgon2Slot<T>(fn: () => Promise<T>, options?: RunWithArgon2SlotOptions): Promise<T>;
  getArgon2QueueDepth(): number;
  getArgon2InFlight(): number;
  /**
   * Reject all currently-queued waiters with `ShuttingDownError` and flip
   * the instance into shutting-down mode: any subsequent
   * `runWithArgon2Slot` call throws `ShuttingDownError` without queueing.
   * In-flight operations are NOT interrupted — they run to completion and
   * release their slot normally. Idempotent.
   */
  drainArgon2Queue(): void;
  readonly cap: number;
  readonly maxQueueDepth: number;
}

/**
 * Construct an independent argon2 semaphore. The process-wide singleton
 * below (`defaultSemaphore`) is used by all production call sites; this
 * factory exists so unit tests can dependency-inject an explicit cap > 1
 * without depending on `UV_THREADPOOL_SIZE` being set in the test harness.
 * (Under Vitest the fallback produces cap=1, which makes the production
 * semaphore indistinguishable from an inlined `fn()` call for
 * concurrency-observation purposes.)
 */
export function createArgon2Semaphore(
  cap: number,
  maxQueueDepth: number = MAX_QUEUE_DEPTH,
): Argon2Semaphore {
  if (!Number.isFinite(cap) || cap < 1) {
    throw new Error(`createArgon2Semaphore: cap must be >=1, got ${cap}`);
  }
  if (!Number.isFinite(maxQueueDepth) || maxQueueDepth < 1) {
    throw new Error(`createArgon2Semaphore: maxQueueDepth must be >=1, got ${maxQueueDepth}`);
  }
  let inFlight = 0;
  let queueDepth = 0;
  // Each waiter carries both resolve and reject handlers so `drainArgon2Queue`
  // can synchronously unblock every pending caller with `ShuttingDownError`
  // during SIGTERM handling. Without the reject handle a queued waiter's
  // Promise would hang forever, the route handler would never return, and
  // Express would never write the 503 before server.close() / the 30s
  // force-timeout torched the socket.
  //
  // The optional `entry` back-reference lets an AbortSignal listener remove
  // the waiter from the queue on abort (so a dead client doesn't consume a
  // slot once the in-flight op completes and drains the next waiter).
  type Waiter = { resolve: () => void; reject: (err: Error) => void };
  // waiters[] holds Waiter object references by identity; the abort listener at
  // line ~255 uses indexOf reference-equality to splice. Any refactor to a
  // ring-buffer / value-copy queue MUST update the abort path — silent miss
  // otherwise (indexOf returns -1, splice(-1, 1) removes the wrong element).
  const waiters: Waiter[] = [];
  let shuttingDown = false;

  return {
    cap,
    maxQueueDepth,
    getArgon2QueueDepth(): number {
      return queueDepth;
    },
    getArgon2InFlight(): number {
      return inFlight;
    },
    drainArgon2Queue(): void {
      shuttingDown = true;
      // Swap the waiters array atomically before iterating so a concurrent
      // runWithArgon2Slot call (which is now gated by `shuttingDown` anyway)
      // can't observe a half-drained queue.
      const pending = waiters.splice(0, waiters.length);
      for (const w of pending) {
        w.reject(new ShuttingDownError());
      }
    },
    async runWithArgon2Slot<T>(fn: () => Promise<T>, options?: RunWithArgon2SlotOptions): Promise<T> {
      const signal = options?.signal;
      // Pre-queue abort fast-path: caller handed us an already-aborted
      // signal, so there is no point even considering a slot. Throw before
      // touching counters / queue state. This keeps the happy path branch-
      // equal to the pre-abort world (no `signal` touched when undefined).
      if (signal?.aborted) {
        throw new ArgonAbortError();
      }
      if (shuttingDown) {
        // Fail fast: no point queueing work the process is about to exit
        // without completing. Route handlers translate to 503.
        throw new ShuttingDownError();
      }
      if (inFlight >= cap) {
        // Queue-full guard: reject BEFORE pushing to `waiters` to bound the
        // unbounded-growth DoS path. Must throw rather than block so callers
        // can translate to 503 SERVICE_UNAVAILABLE.
        if (waiters.length >= maxQueueDepth) {
          throw new ArgonQueueFullError();
        }
        queueDepth += 1;
        // Declared outside the Promise executor so the abort listener (installed
        // after the push) can splice the exact waiter object out of the queue.
        let waiter: Waiter;
        let onAbort: (() => void) | undefined;
        try {
          await new Promise<void>((resolve, reject) => {
            waiter = { resolve, reject };
            waiters.push(waiter);
            if (signal) {
              onAbort = () => {
                // Remove from the queue so a later slot-grant doesn't
                // resolve() this dead waiter and consume a slot the client
                // will never see. Slot-release path below will shift() the
                // next live waiter instead.
                const i = waiters.indexOf(waiter);
                if (i >= 0) waiters.splice(i, 1);
                reject(new ArgonAbortError());
              };
              // No `{ once: true }` here: the explicit `removeEventListener`
              // in the finally below covers BOTH the abort-fires path AND
              // the resolved-normally path. Adding `{ once: true }` would
              // make the abort-path removal a no-op (already removed by the
              // dispatcher) but the resolved-path still needs the explicit
              // call to avoid leaking the listener for the lifetime of the
              // signal. One cleanup mechanism, not two.
              signal.addEventListener('abort', onAbort);
            }
          });
        } finally {
          queueDepth -= 1;
          if (signal && onAbort) signal.removeEventListener('abort', onAbort);
        }
      }
      // Second abort check at slot-grant time: the waiter may have been
      // resolved by a slot-release BEFORE its abort listener fired (race
      // between the in-flight op's finally and the abort event). If so,
      // skip fn() and release the slot back to the next waiter.
      if (signal?.aborted) {
        const next = waiters.shift();
        if (next) next.resolve();
        throw new ArgonAbortError();
      }
      inFlight += 1;
      try {
        return await fn();
      } finally {
        inFlight -= 1;
        const next = waiters.shift();
        if (next) next.resolve();
      }
    },
  };
}

// Process-wide singleton used by all production auth paths. Tests that
// want to observe cap>1 behavior without touching UV_THREADPOOL_SIZE
// should construct their own instance via `createArgon2Semaphore`.
const defaultSemaphore = createArgon2Semaphore(MAX_CONCURRENT_ARGON2_OPS, MAX_QUEUE_DEPTH);

/**
 * Current number of callers waiting in the semaphore queue (not yet running
 * argon2). Exposed via /api/health so operators can observe saturation
 * events synchronously, independent of pino async-transport drainage.
 */
export function getArgon2QueueDepth(): number {
  return defaultSemaphore.getArgon2QueueDepth();
}

/**
 * Current number of argon2 operations running concurrently. In normal
 * operation this stays at or below MAX_CONCURRENT_ARGON2_OPS.
 */
export function getArgon2InFlight(): number {
  return defaultSemaphore.getArgon2InFlight();
}

/**
 * Acquire one concurrency slot, run `fn`, release the slot. Callers MUST
 * use this wrapper for every argon2.hash / argon2.verify on auth paths so
 * the saturation oracle stays closed. Propagates fn's return value and
 * re-throws fn's errors (including argon2 native failures — the caller
 * still decides how to handle them).
 *
 * Pass `{ signal }` to abort a queued waiter before its slot is granted
 * (e.g., when the HTTP client disconnects). On abort the waiter is
 * rejected with `ArgonAbortError`, removed from the queue, and the slot
 * it would have consumed goes to the next live waiter. The argon2 fn is
 * NOT called. If the signal is already aborted when this is called, it
 * throws immediately without touching queue state.
 *
 * Throws `ArgonQueueFullError` when the waiter queue is at MAX_QUEUE_DEPTH.
 * Throws `ShuttingDownError` after `drainArgon2Queue()` has been called.
 * Throws `ArgonAbortError` (name="AbortError") when a queued waiter's
 * `signal` aborts before the slot is granted.
 * Route handlers MUST translate queue-full / shutting-down into 503
 * SERVICE_UNAVAILABLE; burnSentinel MUST re-throw both rather than
 * swallow (swallowing reopens the timing oracle under DoS conditions).
 * `ArgonAbortError` should be caught and silently dropped by handlers:
 * the client is gone, there is no response to write.
 */
export async function runWithArgon2Slot<T>(
  fn: () => Promise<T>,
  options?: RunWithArgon2SlotOptions,
): Promise<T> {
  return defaultSemaphore.runWithArgon2Slot(fn, options);
}

/**
 * Drain the process-wide semaphore's waiter queue: rejects every pending
 * waiter with `ShuttingDownError` and flips the semaphore into shutting-
 * down mode (subsequent `runWithArgon2Slot` calls throw immediately).
 * Called from `shutdown()` in `backend/src/index.ts` before
 * `server.close()` so Express can flush clean 503 responses within the
 * 30s force-timeout window instead of letting callers hang and have their
 * sockets torn down mid-handshake.
 *
 * Idempotent: safe to call more than once. In-flight argon2 operations
 * are NOT interrupted — they run to completion and release their slot
 * normally.
 *
 * IRREVERSIBLE on the singleton. The closure-private `shuttingDown` flag
 * has no reset path: once this is called, every subsequent
 * `runWithArgon2Slot` against the process-wide semaphore throws
 * `ShuttingDownError` for the lifetime of the process. Tests that need to
 * exercise drain semantics MUST construct their own instance via
 * `createArgon2Semaphore(...)` — calling the module-level wrapper from a
 * test would poison the singleton for every subsequent test in the same
 * Vitest worker.
 *
 * Runtime guard: under Vitest / NODE_ENV=test, this no-ops with a
 * `logger.warn` instead of draining. The docblock above is convention-only;
 * a test author who imports this without reading the comment can poison
 * the worker. The guard makes the misuse loud at the call site instead of
 * silent for the rest of the test run. Mirrors the `process.env.VITEST`
 * gate at routes/auth.ts:153-160 for the UV_THREADPOOL_SIZE assertion.
 */
export function drainArgon2Queue(): void {
  if (process.env.VITEST || process.env.NODE_ENV === 'test') {
    logger.warn(
      'drainArgon2Queue called from test context — ignored. Use createArgon2Semaphore() for DI.',
    );
    return;
  }
  defaultSemaphore.drainArgon2Queue();
}
