// Deterministic JS-level concurrency cap on argon2 operations.
//
// Rationale:
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
 *
 * Two consumers depend on this base class for the "503-able-or-silent"
 * propagation invariant:
 *  - `burnSentinel` in `backend/src/routes/auth.ts` uses
 *    `if (isArgonSemaphoreError(err)) throw err;` to re-throw all
 *    semaphore errors past its warn-and-swallow path, preserving the
 *    timing-oracle floor under saturation / drain / abort.
 *  - `handleArgonError` in `backend/src/lib/argon2-error-handler.ts`
 *    dispatches per-subclass to either a 503 + `Retry-After` response
 *    (queue-full / shutting-down) or a silent return (abort).
 *
 * A future 4th subclass MUST honor the same invariant (translatable to 503
 * or silently swallowable when the socket is gone). Anything else needs a
 * different base class — a 4xx / 422 / etc. semaphore error does not
 * belong here.
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
 * Type guard for {@link ArgonSemaphoreError}. Colocated with the class so
 * `instanceof` narrowing lives next to the type definition rather than at
 * call sites that import the base class separately. Equivalent to
 * `err instanceof ArgonSemaphoreError`; prefer this in new code so a
 * future refactor (e.g., wrapping the error in a discriminated tagged
 * union for cross-realm safety) is one-place editable.
 */
export function isArgonSemaphoreError(err: unknown): err is ArgonSemaphoreError {
  return err instanceof ArgonSemaphoreError;
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
   * Monotonic count of `ArgonAbortError`s thrown since process start across
   * all three abort paths (pre-queue, parked-waiter, slot-grant). Used by
   * the periodic summary reporter to compute deltas — operators see one
   * `argon2_abort_summary` log line per non-zero interval, no per-event
   * flood. Safe to call concurrently; reads do not mutate state.
   */
  getArgon2AbortCount(): number;
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
  // Monotonic abort counter. Incremented exactly ONCE per logical abort
  // event via the per-request `incrementAbortOnce` closure inside
  // `runWithArgon2Slot` (the parked-waiter `onAbort` path and the
  // slot-grant race-guard path can both fire for the same abort; the
  // closure-local flag dedupes them). Consumed by the periodic summary
  // reporter (delta-based), not reset by readers — see
  // `startArgon2AbortReporter` for the reason.
  let abortCount = 0;
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
  // waiters[] holds Waiter object references by identity; the `onAbort` abort
  // listener inside runWithArgon2Slot uses indexOf reference-equality to splice.
  // Any refactor to a ring-buffer / value-copy queue MUST update the abort path —
  // silent miss otherwise (indexOf returns -1, splice(-1, 1) removes the wrong
  // element).
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
    getArgon2AbortCount(): number {
      return abortCount;
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
      // Per-request guard against double-counting on the slot-grant race
      // window: A's finally shifts B out of waiters and resolves B's
      // parked promise; abort then fires synchronously, runs `onAbort`
      // (which increments), and B's await resumes onto the slot-grant
      // `if (signal?.aborted)` branch (which would also increment). The
      // contract is "one abort = one counter increment"; this flag makes
      // it idempotent. Closure-local to each `runWithArgon2Slot` call.
      let abortAlreadyCounted = false;
      const incrementAbortOnce = (): void => {
        if (abortAlreadyCounted) return;
        abortAlreadyCounted = true;
        abortCount += 1;
      };
      // Shutdown guard runs FIRST, before the pre-queue abort fast-path.
      // After `drainArgon2Queue()` has flipped `shuttingDown = true`, the
      // drain docblock at function `drainArgon2Queue` promises every
      // subsequent `runWithArgon2Slot` call throws `ShuttingDownError` —
      // a pre-aborted caller arriving during shutdown must honor that
      // contract, not throw `ArgonAbortError`. This also keeps the abort
      // counter clean during rolling restarts: clients that disconnect
      // because the server is shutting down get classified as shutdown-
      // related, not as client-disconnect aborts. Operators reading
      // `argon2_abort_summary` deltas during a graceful restart see
      // "no abort traffic" rather than inflated counts driven by a
      // disconnect cascade that the shutdown itself caused.
      if (shuttingDown) {
        throw new ShuttingDownError();
      }
      // Pre-queue abort fast-path: caller handed us an already-aborted
      // signal, so there is no point even considering a slot. Throw before
      // touching queue state. The counter increments here because this is
      // the only abort path that fires before the slot-grant flow, and the
      // contract is "ArgonAbortErrors actually thrown" — and we're about
      // to throw one.
      if (signal?.aborted) {
        incrementAbortOnce();
        throw new ArgonAbortError();
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
                if (i >= 0) {
                  waiters.splice(i, 1);
                  // Counter increments only when this listener actually
                  // owns the abort propagation. Two race cases produce
                  // i<0 and MUST NOT count here:
                  //  - drain race: drainArgon2Queue() already spliced
                  //    and rejected with ShuttingDownError; the caller
                  //    sees ShuttingDownError, not ArgonAbortError. The
                  //    counter is "ArgonAbortErrors actually thrown"
                  //    (see getArgon2AbortCount docblock) — counting
                  //    here would inflate `argon2_abort_summary` during
                  //    rolling restarts, conflating shutdown-rejected
                  //    callers with client-disconnect aborts at exactly
                  //    the time operators most need to distinguish them.
                  //  - slot-release race: A's finally already shifted
                  //    us out and resolved the parked promise; the
                  //    slot-grant race-guard at the post-await
                  //    `if (signal?.aborted)` check owns the increment
                  //    via its own `incrementAbortOnce()` call. The
                  //    per-request `abortAlreadyCounted` flag would
                  //    dedupe a redundant increment here, but skipping
                  //    it keeps the contract local: this listener
                  //    increments iff it caused the propagation.
                  incrementAbortOnce();
                }
                // `reject` is harmless when the parked promise is already
                // settled by drain (ShuttingDownError) or slot-release
                // (resolve); leave it to keep the abort listener's effect
                // on the promise predictable across all three races.
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
      // `incrementAbortOnce` dedupes against the parked-waiter `onAbort`
      // path, which can fire for the SAME logical abort event when the
      // in-flight op's finally already shifted this waiter out of the
      // queue before the abort listener ran.
      if (signal?.aborted) {
        const next = waiters.shift();
        if (next) next.resolve();
        incrementAbortOnce();
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
 * Monotonic count of `ArgonAbortError`s thrown since process start across
 * all three abort paths (pre-queue, parked-waiter, slot-grant). The
 * periodic reporter (`startArgon2AbortReporter`) consumes deltas from this
 * counter and emits a single `argon2_abort_summary` log line per non-zero
 * interval.
 */
export function getArgon2AbortCount(): number {
  return defaultSemaphore.getArgon2AbortCount();
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
 * silent for the rest of the test run. Mirrors the defense-in-depth
 * UV_THREADPOOL_SIZE startup assertion at routes/auth.ts (the bare-block
 * check immediately before SENTINEL_ARGON2_HASH_PROMISE).
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

// ── Periodic abort-summary reporter ────────────────────────
//
// Route handlers translate `ArgonAbortError` into a silent return (the
// client has already disconnected; writing to a torn-down socket is a
// no-op). That silent-by-design policy means an operator running with
// `LOG_LEVEL=info` (production default) sees zero signal when client-
// abort storms saturate the semaphore. A periodic summary log fixes the
// blind spot without flooding logs: one line per 60s interval iff at
// least one abort happened in that window.
//
// This is gated start/stop (not auto-started at module import) so vitest
// does not acquire the timer just by importing the module. `index.ts`
// calls `startArgon2AbortReporter()` from the `app.listen` callback and
// `stopArgon2AbortReporter()` from `shutdown()`. The interval is
// `.unref()`ed so a forgotten stop call cannot keep Node alive.

const ABORT_REPORT_INTERVAL_MS = 60_000;
let abortReportTimer: ReturnType<typeof setInterval> | null = null;
let abortLastReportedCount = 0;

function reportArgon2Aborts(): void {
  const current = defaultSemaphore.getArgon2AbortCount();
  const delta = current - abortLastReportedCount;
  if (delta > 0) {
    abortLastReportedCount = current;
    logger.info(
      { event: 'argon2_abort_summary', count: delta, intervalMs: ABORT_REPORT_INTERVAL_MS },
      'argon2 abort events in the last interval',
    );
  }
}

/**
 * Start the periodic `argon2_abort_summary` reporter. Emits one
 * `logger.info` line every `ABORT_REPORT_INTERVAL_MS` (60s) iff the
 * abort-counter delta since the last report is > 0. Quiet intervals
 * produce zero log lines. Idempotent: calling twice is a no-op.
 *
 * Wired from `index.ts` after `app.listen`. NOT auto-started at module
 * import so vitest workers don't acquire the timer (a leaked interval
 * across test files would surface as "Vitest is hanging" or worker-
 * process-doesn't-exit warnings).
 */
export function startArgon2AbortReporter(): void {
  if (abortReportTimer) return;
  abortReportTimer = setInterval(reportArgon2Aborts, ABORT_REPORT_INTERVAL_MS);
  abortReportTimer.unref();
}

/**
 * Stop the periodic abort reporter. Called from `shutdown()` in
 * `index.ts`. Idempotent.
 */
export function stopArgon2AbortReporter(): void {
  if (abortReportTimer) {
    clearInterval(abortReportTimer);
    abortReportTimer = null;
  }
}
