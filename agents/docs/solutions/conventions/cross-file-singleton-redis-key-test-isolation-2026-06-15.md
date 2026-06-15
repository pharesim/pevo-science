---
title: A cross-file singleton Redis key (one fixed name, not a namespace) perturbs concurrent sibling batch tests; pin the read, delegate, suppress writes
date: 2026-06-15
category: conventions
module: backend
problem_type: convention
component: testing_framework
severity: medium
applies_when:
  - "Vitest config sets `maxWorkers > 1` (PEvO: `maxWorkers: 2`), so two test files run concurrently"
  - "A new SINGLETON Redis key is added: ONE fixed name (e.g. `${appTag}:reputation:calc:version`), NOT a per-entity namespace, read by a batch loop on each run beside an existing cursor/marker key"
  - "Multiple sibling test files drive the same batch entrypoint (`runBatchComputation`) and each depends on a specific pre-seeded cursor geometry (e.g. `cycle:last` set so `startCycle > 0`, or a clean start)"
  - "A sibling run READS the key (stale value) or WRITES it (its stubbed value) during execution, knocking another file off its expected branch or leaking a fingerprint into shared Redis"
related_components:
  - redis
  - batch-reputation
tags:
  - vitest
  - test-isolation
  - redis
  - parallel-workers
  - cross-file-contamination
  - batch-reputation
  - singleton-key
---

# A cross-file singleton Redis key (one fixed name, not a namespace) perturbs concurrent sibling batch tests; pin the read, delegate, suppress writes

## Context

PEvO's backend test suite runs with `maxWorkers: 2` (`backend/vitest.config.ts`), so two test files always execute concurrently. The reputation batch loop (`runBatchComputation`, `backend/src/reputation-batch.ts`) gained a new SINGLETON Redis key, `REDIS_KEY_CALC_VERSION` (`${appTag}:reputation:calc:version`), stamped beside the existing `${appTag}:reputation:cycle:last` cursor. On each run the loop reads `calc:version`, compares it to `computeCalcVersion(weights)`, and on a mismatch forces a full replay from cycle 0 (then persists the new value once the replay durably completes).

A singleton key (one fixed name) is a different contamination shape from a per-entity namespace. The known PEvO learning [[test-teardown-wildcard-delete-shared-id-band-parallel-workers-2026-06-14]] covers a shared DB-ROW band where a teardown wildcard DELETE collides; the fix there is exact-ID cleanup scoping. The singleton-key case has no namespace to scope: every file that drives `runBatchComputation` touches the SAME one key, and the collision happens DURING execution, not at teardown. Two failure modes:

1. A sibling test that set `cycle:last` to pin a specific `startCycle` (e.g. `cycle:last = 0` expecting a resume from `startCycle = 1`) instead sees a `calc:version` mismatch (the key is absent, or holds a concurrent sibling's stub) and force-replays from cycle 0, silently skipping the resume path it meant to pin.
2. A test that lets `runBatchComputation` run to completion under a changed version PERSISTS its stubbed fingerprint into the shared key, leaking it into the next file's run.

This is also distinct from the load-induced suite flakiness operator note (`project_fullsuite_test_flakiness`, the 429/503/504 from the external HAF node) and from the Lua warm/cold SHA-cache mocking concern in [[evalscript-test-mocks-both-verbs-and-key-discriminator-2026-05-26]]: here a clean test fails because another concurrent file's read/write of one shared Redis key moved it off its branch.

## Guidance

A sibling test file that does NOT own the singleton key must PIN ITS READ to a matching value so the batch loop takes the no-change branch, and must never write the key. Capture the real getter first, then spy `redis.get` to return the matching fingerprint for that ONE key while delegating every other key to the real client:

```ts
// Pin ONLY the calc:version read to the fingerprint runBatchComputation will
// compute for the stubbed weights, so calcVersionChanged is false: the run
// neither replays-from-0 (preserving this file's startCycle geometry) nor
// persists calc:version (so it cannot leak a stub into shared Redis or knock a
// concurrent sibling into a full replay). Every other key hits real Redis.
function pinCalcVersionRead(redis: NonNullable<ReturnType<typeof getRedis>>) {
  const realGet = redis.get.bind(redis); // capture BEFORE the spy replaces it
  return vi
    .spyOn(redis, 'get')
    .mockImplementation(((key: string) =>
      key === __test_seams.REDIS_KEY_CALC_VERSION
        ? Promise.resolve(STUB_VERSION)
        : realGet(key)) as never);
}
// ...restore in finally: calcVersionGetSpy.mockRestore();
```

Returning the MATCHING fingerprint (computed from the same stubbed weights the run uses, via `computeCalcVersion`) is what makes `calcVersionChanged` false. That single fact buys both properties at once: geometry preserved (no replay) AND no write (the persist is gated on `calcVersionChanged && reachedFullyElapsed`, so a no-change run never SETs the key). Delegating other keys to `realGet` keeps the rest of the test exercising real Redis.

The file that DOES own the key (the one testing the recompute trigger itself) instead snapshots and restores it around the suite, so it can freely set/clear it without leaking:

```ts
beforeEach(async () => {
  priorVersion = await redis.get(__test_seams.REDIS_KEY_CALC_VERSION);
  await redis.del(__test_seams.REDIS_KEY_CALC_VERSION); // own it for this run
});
afterEach(async () => {
  if (priorVersion !== null) await redis.set(__test_seams.REDIS_KEY_CALC_VERSION, priorVersion);
});
```

## Why This Matters

Under `maxWorkers: 2` a singleton key is a guaranteed shared mutable global across every concurrently-scheduled file that touches the batch loop. Without the read-pin, a file's documented `startCycle` geometry is at the mercy of whatever a sibling last wrote (or didn't write) to the one key, so a structurally-correct test fails intermittently with a wrong-branch symptom (an unexpected full replay, a skipped resume, a missing `batchMapToScoreRecord` call) that looks like a logic bug in the file under test but originates in a sibling. The read-pin + write-suppression makes each non-owning file deterministic and leak-free without serializing the suite.

## When to Apply

Any time a batch loop or scheduler gains a NEW cross-file singleton Redis key (a fixed-name cursor, version stamp, marker, or sentinel that more than one test file's run will read) and the suite runs files concurrently. Reach for this pattern instead of `del`-everything teardown (which races) or running the files serially (which hides the real isolation requirement). The reusable shape is: capture `realGet`, spy the ONE key to a value that drives the loop down its no-op branch, delegate the rest, restore in `finally`; the owning file snapshots/restores instead.

## Examples

Canonical implementation: the `pinCalcVersionRead(redis)` helper in `backend/tests/routes/reputation-batch-sql-failure.test.ts`. The same inline shape (capture `realGet`, spy `REDIS_KEY_CALC_VERSION` to a matching fingerprint, delegate other keys) appears in `backend/tests/routes/reputation-batch-cycle-boundary.test.ts` and `backend/tests/routes/reputation-batch-internals.test.ts`. The owning file, `backend/tests/routes/reputation-calc-version-recompute.test.ts`, instead snapshots and restores both `cycle:last` and `calc:version` in `beforeEach`/`afterEach` because it deliberately sets the key to drive the recompute trigger.

## Related

- [[test-teardown-wildcard-delete-shared-id-band-parallel-workers-2026-06-14]] — the DB-ROW band variant of the same parallel-workers contamination class; that one collides at teardown over a shared namespace and is fixed by exact-ID cleanup scoping, whereas the singleton-key case collides during execution over one fixed key and is fixed by read-pin + write-suppression.
- [[evalscript-test-mocks-both-verbs-and-key-discriminator-2026-05-26]] — a different Redis test-isolation concern (Lua script warm/cold SHA caches), not the cross-file shared-key shape.
