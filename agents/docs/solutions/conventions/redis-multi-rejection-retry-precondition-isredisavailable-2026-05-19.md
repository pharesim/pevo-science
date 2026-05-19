---
title: Redis MULTI/EXEC-with-del rejection leaves the row intact; in-memory-fallback retry tests must model the Redis flap explicitly
date: 2026-05-19
category: conventions
module: accreditation
problem_type: convention
component: authentication
severity: medium
applies_when:
  - A backend route writes a Redis MULTI pipeline that includes a del AND has an in-memory fallback for the pipeline-failure case
  - A test exercises the in-memory-fallback retry path on such a route
  - Architect hold-block acceptance criteria touch retry behavior on an in-memory-fallback path
  - Reviewing acceptance criteria for any route that uses redis.multi().exec() with a cleanup del
tags:
  - redis
  - multi-pipeline
  - retry-semantics
  - in-memory-fallback
  - is-redis-available
  - idempotency
  - test-precondition
  - hold-block-acceptance
---

# Redis MULTI/EXEC-with-del rejection leaves the row intact; in-memory-fallback retry tests must model the Redis flap explicitly

## Context

PEvO's accreditation completion path (`recordAccreditationCompletion` in `backend/src/routes/accreditation.ts`) writes a grace-period record and cleans up the pending token atomically inside a single `redis.multi().set(...).del(...).exec()` pipeline. An inner try/catch around the `.exec()` emits `accreditation.verify.completion_record_pipeline_failed` and falls through to in-memory writes (`memoryAccreditationCompletions.set` + `memoryTokens.delete`) so a Redis flap mid-pipeline does not break the user-facing 200 envelope.

During the round-3 review of `backend-verify-post-success-retry-idempotency`, the architect's hold-block specified an acceptance criterion for the pipeline-rejection spec that read: *"(c) issue a second /verify with the same token; assert 200 with cached envelope; assert broadcastJsonMock NOT re-invoked."* The implementer flagged in their round-3 signal that this acceptance was physically unachievable on healthy Redis. Without the `isRedisAvailable === false` flap precondition on the retry leg, a second call hits the surviving pending row through `getToken`'s Redis branch and re-broadcasts — the in-memory fallback never runs.

The deviation was correctly absorbed at round-4 triage (the implementer added the flap spy and the architect accepted the deviation), but the underlying ioredis MULTI/EXEC semantic — *pipeline rejection unwinds every command, including the del* — is not stated in the code, not visible from `recordAccreditationCompletion`'s body alone, and not covered by adjacent conventions ([[chain-write-timeout-ambiguous-outcome-2026-04-22]] discusses Redis flap for DECR and `expire` failures but not MULTI atomicity; [[post-broadcast-grace-period-record-must-follow-permanent-rethrow-cleanup-2026-05-19]] covers ordering of the record write relative to permanent-rethrow cleanups but treats the MULTI as a single best-effort unit without examining the post-rejection state). This convention captures the mechanic and its three downstream consequences so future code, tests, and architect hold blocks can account for it.

## Guidance

### Rule 1 — MULTI/EXEC rejection unwinds the del; design for the surviving row

When a `redis.multi()` pipeline includes a `del` and any command (or the whole pipeline) rejects, the entire transaction is uncommitted. The key targeted by `del` survives in Redis with its original TTL. Downstream code — inner catch blocks, in-memory fallbacks, retry handlers — must be written assuming the pending row is still present after a pipeline rejection. Do not assume the `del` committed.

Canonical pipeline shape:

```typescript
// backend/src/routes/accreditation.ts
try {
  await redis
    .multi()
    .set(completionKey, JSON.stringify(envelope), 'EX', COMPLETION_TTL_SECS)
    .del(pendingKey)   // does NOT run if the pipeline rejects
    .exec();
} catch (pipelineErr) {
  logger.warn(
    { err: pipelineErr, route, username, token_hash: hashTokenForLogs(token) },
    'accreditation.verify.completion_record_pipeline_failed',
  );
  // pendingKey is still alive in Redis here.
  // Fall through to in-memory writes.
  memoryAccreditationCompletions.set(token, { username, txId, expires_at });
  memoryTokens.delete(token);
}
```

A healthy-Redis retry against the same token will see the surviving pending row through `getToken`'s Redis branch and re-broadcast. The in-memory fallback only wins when `getToken`'s Redis branch is unreachable.

### Rule 2 — In-memory-fallback test specs must explicitly model `isRedisAvailable === false` on the retry leg

A spec that stubs `redis.multi` to reject once and then issues a healthy-Redis retry does not exercise the in-memory fallback. The retry hits the surviving pending row, re-broadcasts, and satisfies the 200-status assertion through the wrong path. A regression that later removes the inner catch is not caught by such a test.

Canonical test shape:

```typescript
// backend/tests/routes/accreditation-idempotency.test.ts
it('pipeline rejection → 200 envelope; warn fires; in-memory fallback satisfies retry under Redis flap', async () => {
  // First flight: stub the pipeline to reject.
  const multiSpy = vi.spyOn(redis, 'multi').mockReturnValueOnce({
    set: () => ({
      del: () => ({
        exec: () => Promise.reject(new Error('pipeline boom')),
      }),
    }),
  } as unknown as ReturnType<typeof redis.multi>);

  const res1 = await request(app).post('/api/accreditation/verify').send({ token });
  expect(res1.status).toBe(200);
  expect(warnSpy).toHaveBeenCalledWith(
    expect.objectContaining({ event: 'accreditation.verify.completion_record_pipeline_failed' }),
    expect.stringContaining('pipeline failed'),
  );

  // Retry leg: pendingKey is still alive in Redis. Without modeling the flap,
  // a healthy-Redis retry would re-broadcast through getToken's Redis branch.
  // Spy isRedisAvailable to false so getToken falls through to memoryTokens
  // (the fallback's delete made it empty) and the !pending branch reads
  // memoryAccreditationCompletions (the fallback's set) — returning the
  // cached envelope without re-broadcasting.
  const isAvailableSpy = vi.spyOn(redisModule, 'isRedisAvailable').mockReturnValue(false);
  try {
    const broadcastBefore = broadcastJsonMock.mock.calls.length;
    const res2 = await request(app).post('/api/accreditation/verify').send({ token });
    expect(res2.status).toBe(200);
    expect(res2.body.data).toMatchObject(res1.body.data);
    expect(broadcastJsonMock.mock.calls.length).toBe(broadcastBefore);  // no re-broadcast
  } finally {
    isAvailableSpy.mockRestore();
  }
});
```

The `isRedisAvailable` spy must be set **after** the first call and **before** the retry. Setting it before the first call would prevent the pipeline branch from running at all and the test would silently exercise the no-Redis path instead of the pipeline-rejection path. Use `mockReturnValue(false)` (not `mockReturnValueOnce`) so internal availability checks during the retry are all covered without ordering sensitivity.

The stub's `as unknown as ReturnType<typeof redis.multi>` cast erases the structural type check for the entire pipeline value. If the production `recordAccreditationCompletion` grows a new step (a second `.set`, an `.expire`, etc.) the stub's nested plain object will have no matching method and the cast will silently allow the spec to pass against an incomplete code path. Prefer a self-referential pipeline stub cast to `ChainableCommander` so any production-chain growth requires the stub to grow too:

```typescript
import type { ChainableCommander } from 'ioredis';
const fakePipeline = {
  set(..._args: unknown[]) { return this as unknown as ChainableCommander; },
  del(..._args: unknown[]) { return this as unknown as ChainableCommander; },
  exec: () => Promise.reject(new Error('pipeline boom')),
} as unknown as ChainableCommander;
vi.spyOn(redis, 'multi').mockReturnValueOnce(fakePipeline);
```

### Rule 3 — Architect hold-block acceptance for in-memory-fallback paths must name the Redis-availability precondition explicitly

Acceptance criteria phrased only as post-conditions on the retry response are unachievable on healthy Redis after a MULTI rejection. The hold block must state the precondition that makes the fallback path actually win.

**Incorrect form (post-condition only):**

> (c) Issue a second /verify with same token; assert 200 with cached envelope; assert broadcastJsonMock NOT re-invoked.

**Correct form (precondition named):**

> (c) With `isRedisAvailable` returning false on the retry leg, issue a second POST /api/accreditation/verify with the same token; assert 200 with the same response envelope as (b); assert `broadcastJsonMock` called exactly once across both calls (no re-broadcast on the retry).

The incorrect form generates a round-trip in one of two failure modes: (1) the implementer correctly observes the precondition gap and flags a deviation in their signal block (best case, one extra round); or (2) the implementer satisfies the letter of the criterion via the re-broadcast path and the test silently passes against the wrong path (worst case, silent correctness defect).

## Why This Matters

Three failure modes follow from missing the MULTI rejection semantic:

1. **Silent re-broadcast on healthy-Redis retry.** Pipeline rejection leaves `pendingKey` alive. If `/verify` runs again on healthy Redis before the 24h TTL expires, `getToken` finds the row, treats the operation as not-yet-complete, and re-broadcasts to the chain. In PEvO's current architecture the HAF idempotency gate and per-token dedup catch the duplicate at the rare intersection of pipeline-rejection-followed-by-healthy-Redis-retry, so the user-facing impact is contained — but the inner-catch fallback alone does not prevent re-broadcast in that window. (The architect-considered alternative of adding a best-effort `deleteToken(token)` to the inner catch would close the window, but was dismissed at round-4 triage as out-of-scope given the existing HAF backstop and PEvO's single-instance scale per [[project_single_instance_only]].)

2. **Test exercises the wrong path; regression class missed.** A spec that stubs the pipeline once and then issues a healthy-Redis retry achieves the 200-status assertion via re-broadcast, not via the in-memory fallback. The spec appears green; the regression-kill claim of the spec ("the in-memory fallback satisfies the retry") is false. A later change that removes the inner catch entirely would still let the test pass via re-broadcast.

3. **Architect/implementer round-trips from unachievable acceptance criteria.** When a hold block states "no re-broadcast on retry" without naming the precondition, the implementer either has to deviate from the literal acceptance (one extra round of clarification) or silently produces a test that passes through the wrong path. Either outcome is avoidable by naming the precondition up front. Architects writing hold-block acceptance for any in-memory-fallback retry test should state the Redis-availability condition the test is exercising under.

## When to Apply

- Any backend route that writes a `redis.multi()` pipeline containing a `del` AND has an in-memory fallback (try/catch or a `bestEffort` wrapper) for the pipeline-failure case.
- Any test exercising the in-memory-fallback retry semantics for such a route. The test MUST stub `isRedisAvailable` to false on the retry leg.
- Any architect hold block whose acceptance criteria touch retry behavior on an in-memory-fallback path. The criteria MUST name the Redis-availability precondition, not just the desired post-condition.

Does NOT apply to pipelines that only `set` or only `get` (no `del`) — rejection leaves no surviving row that could drive re-broadcast on retry. Does NOT apply when the route has no in-memory fallback and the contract on Redis-flap is just "return 5xx and let the client retry" — the precondition question is moot.

## Examples

**Before/after hold-block acceptance (real round-3 deviation):**

Before (round-3 architect prescription, post-condition only):

```
(c) issue a second /verify with same token; assert 200 with cached envelope;
    assert broadcastJsonMock NOT re-invoked.
```

After (round-3 implementer correction, precondition named — accepted at round-4):

```
(c) With isRedisAvailable returning false on the retry leg, issue a second
    POST /api/accreditation/verify with the same token; assert 200 with the
    same response envelope as (b); assert broadcastJsonMock called exactly
    once across both calls (no re-broadcast on the retry).
```

**Test retry-leg precondition snippet:**

```typescript
// After first call's 200 + warn assertions complete:
const isAvailableSpy = vi.spyOn(redisModule, 'isRedisAvailable').mockReturnValue(false);
try {
  const broadcastBefore = broadcastJsonMock.mock.calls.length;
  const res2 = await request(app).post('/api/accreditation/verify').send({ token });
  expect(res2.status).toBe(200);
  expect(res2.body.data).toMatchObject(res1.body.data);
  expect(broadcastJsonMock.mock.calls.length).toBe(broadcastBefore);
} finally {
  isAvailableSpy.mockRestore();
}
```

The spy targets `redisModule.isRedisAvailable` (the named export from `backend/src/redis.ts`) so the stub is visible to `getToken`'s import binding inside `accreditation.ts`. `mockReturnValue(false)` covers any number of internal availability checks during the retry without ordering sensitivity. The `finally` block restores the spy so later specs in the file are unaffected.

## Related

- [[chain-write-timeout-ambiguous-outcome-2026-04-22]] — parent convention for Redis-flap handling on chain-write paths. Covers DECR-failure and `expire`-failure flap classes; this convention extends the family with the MULTI/EXEC rejection class.
- [[post-broadcast-grace-period-record-must-follow-permanent-rethrow-cleanup-2026-05-19]] — sibling convention covering ordering of the grace-period record write relative to permanent-rethrow cleanups. Same canonical file (`recordAccreditationCompletion`); adjacent concern. This convention examines what the pipeline's del leaves behind on rejection; that convention examines what the wrapper's catch absorbs.
- [[helper-extraction-express5-response-ordering-2026-04-28]] — the response-ordering hazard that justifies `recordAccreditationCompletionBestEffort`'s outer catch. A propagating Redis error from a post-response-write step would reach Express 5's async-error handler over the in-flight 200; the outer catch contains that. Distinct from the pipeline-atomicity concern of this convention but operationally adjacent.
- [[inner-catch-shadows-outer-catch-in-route-tests-2026-04-28]] — sibling convention on test structure when an inner catch absorbs an error before the outer wrapper sees it. The distinct event discriminators on the inner pipeline-failed warn vs the outer best-effort warn are how the new spec's assertion pins the inner-catch path correctly.
- [[test-mock-carve-out-clause-c-2026-05-04]] — the carve-out justification framework for the `redis.multi` stub and the `isRedisAvailable` spy used in the canonical test. Both fall within the permitted mock-target scope; the spec's inline carve-out comment satisfies clause (a) and names the real-path companion (the sibling grace-period specs in the same file that exercise the live `redis.multi` chain against real Redis).
