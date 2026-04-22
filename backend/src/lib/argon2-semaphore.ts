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

let inFlight = 0;
let queueDepth = 0;
const waiters: Array<() => void> = [];

/**
 * Current number of callers waiting in the semaphore queue (not yet running
 * argon2). Exposed via /api/health so operators can observe saturation
 * events synchronously, independent of pino async-transport drainage.
 */
export function getArgon2QueueDepth(): number {
  return queueDepth;
}

/**
 * Current number of argon2 operations running concurrently. In normal
 * operation this stays at or below MAX_CONCURRENT_ARGON2_OPS.
 */
export function getArgon2InFlight(): number {
  return inFlight;
}

/**
 * Acquire one concurrency slot, run `fn`, release the slot. Callers MUST
 * use this wrapper for every argon2.hash / argon2.verify on auth paths so
 * the saturation oracle stays closed. Propagates fn's return value and
 * re-throws fn's errors (including argon2 native failures — the caller
 * still decides how to handle them).
 */
export async function runWithArgon2Slot<T>(fn: () => Promise<T>): Promise<T> {
  if (inFlight >= MAX_CONCURRENT_ARGON2_OPS) {
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
}
