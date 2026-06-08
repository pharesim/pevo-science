# BACKEND-REPUTATION-PIPELINE-EXEC-ERROR-CHECK — `pipeline.exec()` per-command errors silently committed before atomic Lua swap

**Owner:** backend
**Created:** 2026-05-30 (surfaced by HAF-query multi-lens review, rank #22 medium severity, correctness)
**Priority:** P2 (violates the explicit atomicity invariant; on partial failure leaves prod keys at a mix of cycle N and cycle N+1 until next run ~1h later)

## Problem

ioredis `pipeline.exec()` does NOT throw on per-command errors — it resolves with `[[err, result], ...]` and the outer error is always null. [reputation-batch.ts:339-362](backend/src/reputation-batch.ts#L339-L362) never inspects per-command errors.

If a staging SET fails, sentinel still gets SET, and the Lua RENAME throws `ERR no such key` mid-loop. Crucially, Redis scripts are NOT transactions — already-executed RENAMEs in the loop are committed, leaving prod keys at a mix of cycle N and cycle N+1 until next run (~1h).

This directly violates the explicit atomicity invariant documented at lines 13-14 and 81-82.

## Goal

Inspect per-command errors after `pipeline.exec()` and bail before the sentinel SET if any failed.

### Suggested approach

```typescript
const results = await pipeline.exec();
if (!results || results.some(([err]) => err !== null)) {
  break;
}
// ... existing sentinel SET + Lua swap
```

Leaves `cycle:last` unadvanced and lets `clearStagingKeys` on the next run cleanly drop the partial set without entering the destructive Lua path.

## Acceptance

- Regression test: inject a staging SET failure (e.g. via a Redis-mock seam); assert the sentinel is NOT set and `cycle:last` is NOT advanced.
- Happy-path tests stay green.
- The invariant documented at lines 13-14 / 81-82 now holds — pin via test that explicitly asserts no partial cycle state survives a per-command failure.
- Comment anchors clean.
- `npm run typecheck` + `npm run lint` clean.

## Notes

- Compounds with #10 (SQL-error silent advance) — both are "don't advance `cycle:last` on failure" defects, but at different layers. Land both.
- Interacts with #32 (CYCLE_SWAP via evalScript) — the registry move is orthogonal; this fix is in the caller path, not the Lua.

## Cross-references

- [backend/src/reputation-batch.ts](backend/src/reputation-batch.ts) lines 339-362, lines 13-14 + 81-82 (atomicity invariant docblock).
- HAF-query review run `w274tijk0` rank #22.

## Architect re-review (2026-06-06) — HELD PENDING FIXES (2 items)

`/ce-code-review` (correctness + adversarial on Opus; reliability, testing, maintainability, project-standards on Sonnet; ce-agent-native-reviewer skipped per PEvO) on commit d1dc69f8. The guard is verified CORRECT on every attack angle: it sits after the staging exec and before the sentinel SET + Lua swap; `break` matches the sibling guards' monotonicity argument; `cycle:last` advances per-cycle so a break on cycle N+1 cannot lose N's committed advance; no in-progress sentinel exists at the bail point so nothing leaks; the ioredis null/tuple contract is handled; the pipeline is built fresh with only SETs queued; partial staging keys are dropped by `clearStagingKeys` on the next run (claim verified against the post-SCAN-refactor code). Two items hold.

### Items held (must fix before archive)

1. (P1, testing + correctness, both at confidence 100) The Arm 3 comments claim "no production staging key is actually written for the errored command". That claim is FALSE: the spy calls the real exec() unconditionally, so every queued SET executes against live Redis and the staging key IS written; the spy only flips the first RETURNED tuple. Rewrite the three comment sites (test-header Arm 3 paragraph, the inline wrap comment, the tuple-flip comment) to state: all queued .set() calls execute for real; the spy alters only the returned result tuple; the written staging key is cleaned by clearKeys() in afterEach (and would be dropped by clearStagingKeys on a next run); the guard's contract is the tuple-error inspection alone. Comment-only, no logic change. (The guard behavior itself and the mock hygiene — restoreAllMocks between retries — were verified fine.)
2. (P2, reliability) The bail log line drops which command failed and why. Include the first error tuple's message in the EXISTING logger.error fields (e.g. `err: results?.find(([e]) => e !== null)?.[0]?.message`). Zero log-volume cost (same single line, fires at most once per failed run); without it an operator cannot distinguish OOM from WRONGTYPE from eviction.

While addressing the holds, append a brief `## Implementation notes` section (this task moved to review in a batch commit without one).

### Items dismissed at triage (no action)

- Belt-and-suspenders spy restore inside the test's own finally: afterEach restoreAllMocks already covers every retry path.
- A non-first-tuple error injection arm and a sentinel-set-then-Lua-throws recovery pin: the some()-over-all-tuples semantic and the pre-existing crash-mid-Lua recovery are covered by construction and by the internals suite; preemptive.
- Sibling unchecked pipeline.exec() in backfillAccreditationSeeds: folded into the redis-keys-scan-replacement hold (that task is already editing the same pipeline).

### Re-review signal

When both items land, `git mv` this file back to `tasks/review/`. The mv is the re-review signal; the next review scopes to the fix commits only.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>

## Implementation notes

The staging pipeline in `runBatchComputation` builds a fresh `redis.pipeline()` queuing one `SET ${REDIS_KEY_STAGING_PREFIX}<user>` per scored user, then `await pipeline.exec()`. The guard sits between that exec and the sentinel SET + atomic `CYCLE_SWAP` Lua: `if (!results || results.some(([err]) => err !== null)) { logger.error(...); break; }`. `break` (not `continue`) leaves `cycle:last` unadvanced, so the next scheduled run re-attempts the cycle and `clearStagingKeys` drops the partial staging set before the destructive Lua path is ever reached. This closes the ioredis-`exec()`-doesn't-throw-on-per-command-error gap that would otherwise let a partially-staged set flow into the RENAME-and-advance swap.

## Backend re-review signal (2026-06-08, commit on main)

Both held items landed:

1. (P1 testing/correctness comment accuracy) Rewrote the three Arm-3 comment sites in `reputation-batch-sql-failure.test.ts` — the test-header Arm-3 wrap description, the inline `redis.pipeline` wrap comment, and the tuple-flip comment. They no longer claim "no production staging key is actually written for the errored command" (false: the wrap calls the real `exec()` unconditionally, so every queued SET writes a real staging key; only the FIRST returned tuple is rewritten to an error). The comments now state: all queued `.set()` calls execute for real; the spy alters only the returned result tuple; the written staging key is the exact partial-staging state the guard must bail on, and is cleaned by `clearKeys()` in `afterEach` (a real run's next-cycle `clearStagingKeys` would drop it regardless); the guard's contract is the tuple-error inspection alone. No logic change.
2. (P2 reliability) The bail `logger.error` now includes the first failed command's message: `err: results?.find(([e]) => e !== null)?.[0]?.message`, in the same single log line (zero log-volume cost), so an operator can distinguish OOM vs WRONGTYPE vs eviction.

`npm run typecheck` + `npm run lint` clean; `reputation-batch-sql-failure` green (3/3) in isolation. The dismissed sibling — the unchecked `pipeline.exec()` in `backfillAccreditationSeeds` — is being addressed under `backend-redis-keys-scan-replacement` item 2 as noted at triage.
