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
 * Thrown by `runWithArgon2Slot` (and by the process-wide default semaphore)
 * when the waiter queue is at `MAX_QUEUE_DEPTH`. Callers MUST re-throw or
 * translate to 503; swallowing this error silently inside burnSentinel would
 * reopen the timing oracle under DoS conditions (~0ms response instead of
 * the argon2.verify floor).
 */
export class ArgonQueueFullError extends Error {
  constructor(message = 'argon2 semaphore queue full') {
    super(message);
    this.name = 'ArgonQueueFullError';
  }
}

export interface Argon2Semaphore {
  runWithArgon2Slot<T>(fn: () => Promise<T>): Promise<T>;
  getArgon2QueueDepth(): number;
  getArgon2InFlight(): number;
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
  const waiters: Array<() => void> = [];

  return {
    cap,
    maxQueueDepth,
    getArgon2QueueDepth(): number {
      return queueDepth;
    },
    getArgon2InFlight(): number {
      return inFlight;
    },
    async runWithArgon2Slot<T>(fn: () => Promise<T>): Promise<T> {
      if (inFlight >= cap) {
        // Queue-full guard: reject BEFORE pushing to `waiters` to bound the
        // unbounded-growth DoS path. Must throw rather than block so callers
        // can translate to 503 SERVICE_UNAVAILABLE.
        if (waiters.length >= maxQueueDepth) {
          throw new ArgonQueueFullError();
        }
        queueDepth += 1;
        try {
          await new Promise<void>((resolve) => waiters.push(resolve));
        } finally {
          queueDepth -= 1;
        }
      }
      inFlight += 1;
      try {
        return await fn();
      } finally {
        inFlight -= 1;
        const next = waiters.shift();
        if (next) next();
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
 * Throws `ArgonQueueFullError` when the waiter queue is at MAX_QUEUE_DEPTH.
 * Route handlers MUST translate this into 503 SERVICE_UNAVAILABLE; burn-
 * Sentinel MUST re-throw rather than swallow (swallowing reopens the
 * timing oracle under DoS conditions).
 */
export async function runWithArgon2Slot<T>(fn: () => Promise<T>): Promise<T> {
  return defaultSemaphore.runWithArgon2Slot(fn);
}
