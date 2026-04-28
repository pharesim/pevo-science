// Library-level unit tests for `argon2-semaphore.ts`.
//
// These tests use `createArgon2Semaphore(cap)` to dependency-inject an
// explicit cap > 1 without relying on `UV_THREADPOOL_SIZE` being set. Under
// Vitest the env var is unset by default, which makes the
// production-singleton cap fall back to 1 — at cap=1 the semaphore is
// indistinguishable from an inlined `fn()` call for concurrency-observation
// purposes, so a "revert semaphore to no-op" mutant would pass the
// route-level concurrent-burst test.
//
// Rather than modify vitest.config.ts (a sibling task handles that, and we
// must avoid file conflicts), this test suite injects the cap directly. It
// exercises:
//
//   T1 — in_flight peaks exactly at cap under a burst of cap+2 controlled-
//        delay functions. Confirms the semaphore queues excess work rather
//        than letting it run concurrently.
//   T2 — a rejecting fn releases its slot via the `finally` branch. Two
//        pre-queued waiters proceed and in_flight returns to 0 even when
//        the running fn throws (i.e., slot leak is proven absent).
//   Queue-full — a cap=1 semaphore with maxQueueDepth=2 rejects the 4th
//        concurrent caller with ArgonQueueFullError while allowing the 2nd
//        and 3rd to queue. Confirms the MAX_QUEUE_DEPTH bound is enforced
//        BEFORE push to `waiters`.

import { describe, it, expect } from 'vitest';
import {
  createArgon2Semaphore,
  ArgonQueueFullError,
  ShuttingDownError,
  ArgonAbortError,
  MAX_CONCURRENT_ARGON2_OPS,
  MAX_QUEUE_DEPTH,
} from '../../src/lib/argon2-semaphore.js';

// Helper: build a controllable async fn + its resolver.
function controllable<T>(): {
  fn: () => Promise<T>;
  resolve: (v: T) => void;
  reject: (err: unknown) => void;
  started: Promise<void>;
} {
  let outerResolve!: (v: T) => void;
  let outerReject!: (err: unknown) => void;
  let markStarted!: () => void;
  const started = new Promise<void>((r) => {
    markStarted = r;
  });
  const fn = () =>
    new Promise<T>((resolve, reject) => {
      outerResolve = resolve;
      outerReject = reject;
      markStarted();
    });
  return { fn, resolve: (v) => outerResolve(v), reject: (err) => outerReject(err), started };
}

describe('createArgon2Semaphore (DI factory for testing)', () => {
  it('rejects invalid cap values', () => {
    expect(() => createArgon2Semaphore(0)).toThrow();
    expect(() => createArgon2Semaphore(-1)).toThrow();
    expect(() => createArgon2Semaphore(Number.NaN)).toThrow();
    expect(() => createArgon2Semaphore(Number.POSITIVE_INFINITY)).toThrow();
  });

  it('rejects invalid maxQueueDepth values', () => {
    expect(() => createArgon2Semaphore(2, 0)).toThrow();
    expect(() => createArgon2Semaphore(2, -1)).toThrow();
    expect(() => createArgon2Semaphore(2, Number.NaN)).toThrow();
  });

  it('exposes the configured cap', () => {
    const sem = createArgon2Semaphore(3);
    expect(sem.cap).toBe(3);
    expect(sem.maxQueueDepth).toBe(MAX_QUEUE_DEPTH);
  });
});

describe('T1 — in_flight peaks at cap under cap+2 burst', () => {
  it('with cap=3, fan-out of 5 concurrent fns sees at most 3 in-flight at any time', async () => {
    const CAP = 3;
    const sem = createArgon2Semaphore(CAP);
    const N = CAP + 2; // 5

    const handles = Array.from({ length: N }, () => controllable<number>());

    // Launch all N runs without awaiting. Each one either starts immediately
    // (if a slot is open) or queues.
    const promises = handles.map((h, i) => sem.runWithArgon2Slot(() => h.fn().then((v) => v + i)));

    // Wait for the first `CAP` fns to start (they all acquire slots
    // synchronously from an empty queue).
    await Promise.all(handles.slice(0, CAP).map((h) => h.started));

    // Saturation snapshot: exactly cap running, 2 queued.
    expect(sem.getArgon2InFlight()).toBe(CAP);
    expect(sem.getArgon2QueueDepth()).toBe(N - CAP);

    // Sample peak across a few event-loop ticks before any resolution:
    // in_flight must not exceed cap at any observation.
    for (let t = 0; t < 5; t++) {
      await new Promise((r) => setImmediate(r));
      expect(sem.getArgon2InFlight()).toBeLessThanOrEqual(CAP);
    }

    // Resolve the first CAP runs, then the queued 2 get slots.
    for (let i = 0; i < CAP; i++) handles[i].resolve(i);
    await Promise.all(promises.slice(0, CAP));

    // Give the microtask queue a tick to let the next two start.
    await Promise.all(handles.slice(CAP).map((h) => h.started));
    expect(sem.getArgon2InFlight()).toBeLessThanOrEqual(CAP);

    // Resolve the remainder and confirm everything drains.
    for (let i = CAP; i < N; i++) handles[i].resolve(i);
    await Promise.all(promises);

    expect(sem.getArgon2InFlight()).toBe(0);
    expect(sem.getArgon2QueueDepth()).toBe(0);
  });
});

describe('T2 — slot released on throw (finally branch)', () => {
  it('rejecting fn releases its slot; 2 queued waiters proceed; in_flight returns to 0', async () => {
    const sem = createArgon2Semaphore(1); // Serialize for deterministic queue fill.

    // First fn: will throw. Queue 2 waiters behind it.
    const a = controllable<number>();
    const b = controllable<number>();
    const c = controllable<number>();

    const pA = sem.runWithArgon2Slot(() => a.fn());
    await a.started; // A is in-flight.
    const pB = sem.runWithArgon2Slot(() => b.fn()); // B queues.
    const pC = sem.runWithArgon2Slot(() => c.fn()); // C queues.

    // Yield so queue increments are observable.
    await new Promise((r) => setImmediate(r));
    expect(sem.getArgon2InFlight()).toBe(1);
    expect(sem.getArgon2QueueDepth()).toBe(2);

    // A rejects: its slot MUST release via `finally`, then B starts.
    const boom = new Error('boom');
    a.reject(boom);
    await expect(pA).rejects.toBe(boom);

    // B should now be in-flight; C still queued.
    await b.started;
    expect(sem.getArgon2InFlight()).toBe(1);
    expect(sem.getArgon2QueueDepth()).toBe(1);

    b.resolve(2);
    await pB;

    await c.started;
    c.resolve(3);
    await pC;

    // All drained — no leaked slot from the throw path.
    expect(sem.getArgon2InFlight()).toBe(0);
    expect(sem.getArgon2QueueDepth()).toBe(0);
  });
});

describe('MAX_QUEUE_DEPTH cap', () => {
  it('throws ArgonQueueFullError when waiters would exceed maxQueueDepth', async () => {
    const sem = createArgon2Semaphore(1, 2); // cap=1, queue=2 → 3 total concurrent capacity.

    const a = controllable<number>();
    const b = controllable<number>();
    const c = controllable<number>();

    const pA = sem.runWithArgon2Slot(() => a.fn()); // In-flight.
    await a.started;
    const pB = sem.runWithArgon2Slot(() => b.fn()); // Queued (1/2).
    const pC = sem.runWithArgon2Slot(() => c.fn()); // Queued (2/2).

    // Yield to observe queue depth.
    await new Promise((r) => setImmediate(r));
    expect(sem.getArgon2InFlight()).toBe(1);
    expect(sem.getArgon2QueueDepth()).toBe(2);

    // The 4th caller MUST throw synchronously-ish with ArgonQueueFullError.
    await expect(
      sem.runWithArgon2Slot(() => Promise.resolve('should-not-run')),
    ).rejects.toBeInstanceOf(ArgonQueueFullError);

    // State unchanged by the rejection — queue depth still at 2, in_flight at 1.
    expect(sem.getArgon2InFlight()).toBe(1);
    expect(sem.getArgon2QueueDepth()).toBe(2);

    // Drain.
    a.resolve(1);
    await pA;
    await b.started;
    b.resolve(2);
    await pB;
    await c.started;
    c.resolve(3);
    await pC;

    expect(sem.getArgon2InFlight()).toBe(0);
    expect(sem.getArgon2QueueDepth()).toBe(0);
  });

  it('does not reject the Nth-queued caller when there is still room', async () => {
    // cap=1, queue=3 → serves caller #1 in-flight, #2/#3/#4 queued.
    const sem = createArgon2Semaphore(1, 3);

    const handles = Array.from({ length: 4 }, () => controllable<number>());
    const promises = handles.map((h) => sem.runWithArgon2Slot(() => h.fn()));

    await handles[0].started;
    await new Promise((r) => setImmediate(r));
    expect(sem.getArgon2InFlight()).toBe(1);
    expect(sem.getArgon2QueueDepth()).toBe(3);

    // A 5th caller hits the cap.
    await expect(
      sem.runWithArgon2Slot(() => Promise.resolve('nope')),
    ).rejects.toBeInstanceOf(ArgonQueueFullError);

    // Drain.
    for (let i = 0; i < handles.length; i++) {
      if (i > 0) await handles[i].started;
      handles[i].resolve(i);
      await promises[i];
    }

    expect(sem.getArgon2InFlight()).toBe(0);
    expect(sem.getArgon2QueueDepth()).toBe(0);
  });
});

describe('drainArgon2Queue — graceful SIGTERM handling', () => {
  it('rejects all pending waiters with ShuttingDownError on drain', async () => {
    // cap=1 so only A runs; B, C, D queue.
    const sem = createArgon2Semaphore(1, 10);

    const a = controllable<number>();
    const pA = sem.runWithArgon2Slot(() => a.fn());
    await a.started;

    // Queue 3 waiters behind A.
    const pB = sem.runWithArgon2Slot(() => Promise.resolve('B-ran'));
    const pC = sem.runWithArgon2Slot(() => Promise.resolve('C-ran'));
    const pD = sem.runWithArgon2Slot(() => Promise.resolve('D-ran'));

    // Yield so queue increments land.
    await new Promise((r) => setImmediate(r));
    expect(sem.getArgon2InFlight()).toBe(1);
    expect(sem.getArgon2QueueDepth()).toBe(3);

    // Drain. All queued waiters reject with ShuttingDownError.
    sem.drainArgon2Queue();

    await expect(pB).rejects.toBeInstanceOf(ShuttingDownError);
    await expect(pC).rejects.toBeInstanceOf(ShuttingDownError);
    await expect(pD).rejects.toBeInstanceOf(ShuttingDownError);

    // Queue depth returns to 0 (each rejected waiter unwinds the finally).
    expect(sem.getArgon2QueueDepth()).toBe(0);

    // A is still running — drain does NOT interrupt in-flight ops.
    expect(sem.getArgon2InFlight()).toBe(1);

    // Complete A; it returns normally.
    a.resolve(42);
    await expect(pA).resolves.toBe(42);
    expect(sem.getArgon2InFlight()).toBe(0);
  });

  it('rejects new runWithArgon2Slot calls immediately after drain', async () => {
    const sem = createArgon2Semaphore(2);
    sem.drainArgon2Queue();

    // No waiters to reject, but the shutting-down flag now gates new calls.
    await expect(
      sem.runWithArgon2Slot(() => Promise.resolve('should-not-run')),
    ).rejects.toBeInstanceOf(ShuttingDownError);

    // No slot acquired.
    expect(sem.getArgon2InFlight()).toBe(0);
    expect(sem.getArgon2QueueDepth()).toBe(0);
  });

  it('is idempotent — multiple drain calls are safe', () => {
    const sem = createArgon2Semaphore(1);
    sem.drainArgon2Queue();
    expect(() => sem.drainArgon2Queue()).not.toThrow();
    expect(() => sem.drainArgon2Queue()).not.toThrow();
  });

  it('simulates full shutdown flow: burst queues, drain, callers see 503-ish error bounded-time', async () => {
    // Integration-flavor: simulate the auth-route pattern. A burst of 5
    // concurrent "requests" hits a cap=1 semaphore. One gets the slot; 4
    // queue. Drain fires while they're parked. Every queued caller must
    // resolve (reject, in this case) within a bounded tick window — NOT
    // hang until a force-timeout elsewhere kills their socket.
    const sem = createArgon2Semaphore(1, 10);
    const blocker = controllable<void>();

    const inFlight = sem.runWithArgon2Slot(() => blocker.fn());
    await blocker.started;

    // 4 queued callers. Each "handler" translates ShuttingDownError to a
    // 503-equivalent payload, mirroring the route-handler catch blocks.
    const handlers = Array.from({ length: 4 }, () =>
      sem
        .runWithArgon2Slot(() => Promise.resolve('ran'))
        .catch((err) => {
          if (err instanceof ShuttingDownError) {
            return { status: 503, code: 'SERVICE_UNAVAILABLE' };
          }
          throw err;
        }),
    );

    await new Promise((r) => setImmediate(r));
    expect(sem.getArgon2QueueDepth()).toBe(4);

    // Drain. All handlers should resolve (to a 503 payload) in bounded time.
    const startMs = Date.now();
    sem.drainArgon2Queue();
    const results = await Promise.all(handlers);
    const elapsedMs = Date.now() - startMs;

    // Bounded: microtask drain, should be well under 100ms. The semantic
    // assertion is "not hung for >30s" (the force-timeout in index.ts).
    expect(elapsedMs).toBeLessThan(1000);
    for (const r of results) {
      expect(r).toEqual({ status: 503, code: 'SERVICE_UNAVAILABLE' });
    }

    // Cleanup the in-flight blocker so the test doesn't leak.
    blocker.resolve();
    await inFlight;
  });
});

describe('AbortSignal — drop queued waiters on client disconnect', () => {
  it('aborted waiter rejects with AbortError, never runs fn, and the next live waiter proceeds', async () => {
    // cap=1 so A holds the only slot while B and C queue behind it.
    // Abort B while it is queued; assert:
    //   (1) B's argon2 fn is NEVER called,
    //   (2) B's promise rejects with ArgonAbortError (name === 'AbortError'),
    //   (3) B's queue slot is released cleanly (queueDepth decrements),
    //   (4) C — the next live waiter — still proceeds when A completes.
    const sem = createArgon2Semaphore(1, 10);

    const a = controllable<number>();
    const c = controllable<number>();

    const pA = sem.runWithArgon2Slot(() => a.fn());
    await a.started; // A is in-flight.

    // B is the aborted waiter. Its fn must not run; we use a sentinel
    // counter instead of a promise because a promise-never-resolves would
    // mask a bug where fn IS called but we just fail to observe it.
    let bFnCallCount = 0;
    const bAbort = new AbortController();

    const pB = sem
      .runWithArgon2Slot(
        () => {
          bFnCallCount += 1;
          return Promise.resolve('should-not-run');
        },
        { signal: bAbort.signal },
      )
      .catch((err) => err);

    // C is a live waiter that must still proceed after A finishes.
    const pC = sem.runWithArgon2Slot(() => c.fn());

    // Let both waiters actually park in the queue before aborting B.
    await new Promise((r) => setImmediate(r));
    expect(sem.getArgon2InFlight()).toBe(1);
    expect(sem.getArgon2QueueDepth()).toBe(2);

    // Abort B. Its waiter rejects synchronously via the event listener.
    bAbort.abort();

    const bErr = await pB;
    expect(bErr).toBeInstanceOf(ArgonAbortError);
    expect((bErr as Error).name).toBe('AbortError');
    expect(bFnCallCount).toBe(0); // argon2 fn was never invoked.

    // Queue drained of B; only C remains queued behind A.
    // (Microtask yield so the finally-branch queueDepth decrement lands.)
    await new Promise((r) => setImmediate(r));
    expect(sem.getArgon2InFlight()).toBe(1);
    expect(sem.getArgon2QueueDepth()).toBe(1);

    // Finish A — C should now get the slot, not a ghost B waiter.
    a.resolve(1);
    await pA;

    await c.started; // C proceeds because B did NOT consume the slot.
    expect(sem.getArgon2InFlight()).toBe(1);
    expect(sem.getArgon2QueueDepth()).toBe(0);

    c.resolve(3);
    await pC;

    // Everything drains cleanly; no leaked slots from the aborted path.
    expect(sem.getArgon2InFlight()).toBe(0);
    expect(sem.getArgon2QueueDepth()).toBe(0);
  });

  it('already-aborted signal short-circuits before any queue state is touched', async () => {
    const sem = createArgon2Semaphore(2, 5);
    const ac = new AbortController();
    ac.abort();

    let fnCalled = false;
    await expect(
      sem.runWithArgon2Slot(
        () => {
          fnCalled = true;
          return Promise.resolve('nope');
        },
        { signal: ac.signal },
      ),
    ).rejects.toBeInstanceOf(ArgonAbortError);

    expect(fnCalled).toBe(false);
    expect(sem.getArgon2InFlight()).toBe(0);
    expect(sem.getArgon2QueueDepth()).toBe(0);
  });
});

describe('module-level exports sanity', () => {
  it('MAX_CONCURRENT_ARGON2_OPS is a positive integer', () => {
    expect(Number.isInteger(MAX_CONCURRENT_ARGON2_OPS)).toBe(true);
    expect(MAX_CONCURRENT_ARGON2_OPS).toBeGreaterThanOrEqual(1);
  });

  it('MAX_QUEUE_DEPTH is a positive integer', () => {
    expect(Number.isInteger(MAX_QUEUE_DEPTH)).toBe(true);
    expect(MAX_QUEUE_DEPTH).toBeGreaterThanOrEqual(1);
  });
});
