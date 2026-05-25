# BACKEND-BRIDGE-OUTER-CATCH-TEST-RESTORATION — restore the `bridge.register.internal_error` outer-catch spec orphaned by the bridge-queue migration

**Owner:** Backend Agent
**Created:** 2026-05-21 (architect, surfaced by /ce-code-review testing reviewer at archive of `backend-bridge-outer-catch-event-discriminators` round-1 hold-fixes — downstream-staleness from the subsequent bridge-queue migration commit)
**Priority:** P2 (production code uncovered; specific named outer-catch with no regression backstop)

## Context

The bridge `/register` route handler still contains an outer-catch block that emits `logger.error({ event: 'bridge.register.internal_error', ... })` and returns 500 INTERNAL_ERROR. The catch was added to wrap pre-broadcast SYNC throws inside the lock-acquired body (`buildBridgeBody` / `buildBridgeMetadata` rejecting malformed metadata, `assertNever` firing on a `BridgeCheckResult` variant drift, or any other unexpected throw escaping `checkExistingBridge`'s internal HAF catch).

The original test coverage for this catch lived in `backend/tests/routes/bridge.test.ts` as a spec that mocked `buildBridgeBody` via `mockImplementationOnce(() => { throw new Error('synthetic body-construction failure'); })` and asserted the outer-catch fired with `event: 'bridge.register.internal_error'` + route/identifier/username/permlink context.

When `/register` migrated from synchronous broadcast to enqueue+202, the migration commit removed that spec along with the `BridgeKeyCacheUnpopulated` spec, leaving:

- The outer-catch in production (`backend/src/routes/bridge.ts`) — still emits the event tag, still returns 500.
- The mock infrastructure in `bridge.test.ts` — the `vi.mock('../../src/bridge.js', ...)` block still re-exports `buildBridgeBody` as a `vi.fn(...)` passthrough; the wiring is wired but unused.
- The carve-out file header in `bridge.test.ts` — documents a clause-(a) justification for the `buildBridgeBody` mock for a spec that no longer exists.

Result: a production catch with no regression backstop. A future refactor that swaps the event tag, the status code, the error envelope, or removes the catch entirely will ship green.

## Goal

Either restore the spec or remove the orphan mock+header. Restoration is the better option because the outer-catch is still live production code defending a real failure class (`buildBridgeBody` / `buildBridgeMetadata` / `assertNever` / sync throws from the lock-acquired body), and the queue migration did not eliminate that class — it only changed what comes AFTER the validation+broadcast-classification phase.

## Acceptance

### 1. Choose restore or clean-up

**Restore (preferred):** Add a spec under the existing `describe('BACKEND-BRIDGE-OUTER-CATCH-EVENT-DISCRIMINATORS — catch-block log shape', ...)` block (or under a behavioral-anchor describe if that one is also up for cleanup) that:
- Uses `mockImplementationOnce` on the `buildBridgeBody` mock to throw a synthetic error.
- POSTs a valid signed `/register` request that survives `validateRegisterBody`, `verifyHiveSignature`, `getAccreditedSet`, and reaches the lock-acquired body.
- Asserts the response is 500 INTERNAL_ERROR with code `INTERNAL_ERROR` and message `'Failed to register bridge paper'`.
- Asserts the error log fired with `event: 'bridge.register.internal_error'`, `route: 'bridge.register'`, `identifier`, `username`, `permlink` context fields.

**Clean-up (acceptable alternative):** Remove the unused `vi.fn(...)` passthrough for `buildBridgeBody` from the `vi.mock('../../src/bridge.js', ...)` block AND remove the now-stale `buildBridgeBody` carve-out paragraph from the file header. Note in the commit message that the production outer-catch is intentionally left uncovered (cite this task and the queue-migration commit for context).

Restoration is preferred because (a) the catch still defends real production failure classes, (b) the mock infrastructure is already wired, (c) the carve-out header is already written. The marginal cost of restoring the spec is much lower than the regression cost of leaving the catch untested.

### 2. Behavioral anchor on the restored spec

The spec name and describe-block label must NOT cite the round number, task slug, or `BACKEND-BRIDGE-OUTER-CATCH-EVENT-DISCRIMINATORS` handle (per the comment-anchor convention — those rot on archive). Use a behavioral-anchor describe such as `'POST /api/bridge/register — outer-catch fall-through emits bridge.register.internal_error'` or similar.

If the existing `describe('BACKEND-BRIDGE-OUTER-CATCH-EVENT-DISCRIMINATORS ...', ...)` block label is preserved as-is, also file a separate one-line cleanup to rename it as part of the existing `backend-anchor-rot-sweep-2026-05-21` umbrella sweep (it's already in scope for that task's surface).

### 3. Verification

- `npm run typecheck` clean.
- `npm run lint` clean.
- `npx vitest run tests/routes/bridge.test.ts` passes.
- If restored: mutation-kill verified — removing the outer-catch in `bridge.ts` (or changing the event tag literal, or changing the status code) causes the new spec to flip RED.

## Out of scope

- The `BridgeKeyCacheUnpopulated` precursor-log spec that was also removed in the queue migration — separate failure class; if its coverage is also desired, file a separate task.
- Any other test gap surfaced by the queue migration — this task is scoped to the outer-catch only.
- Rewriting the production outer-catch itself — the catch is correct as-is.

## References

- `backend/src/routes/bridge.ts` — outer-catch block at the `/register` handler (search for `event: 'bridge.register.internal_error'`).
- `backend/tests/routes/bridge.test.ts` — current state with the orphan `buildBridgeBody` mock + stale carve-out header.
- `tasks-archive.md` — `BACKEND-BRIDGE-OUTER-CATCH-EVENT-DISCRIMINATORS` entry has the original test design context.
- `agents/docs/solutions/conventions/event-label-granularity-tier-convention-2026-05-13.md` — the convention the original event-tag rename complied with; the restored spec should still assert the coarse `.internal_error` tier.
- `agents/docs/solutions/conventions/test-mock-carve-out-clause-c-2026-05-04.md` — the carve-out clauses that govern the mock justification on restoration.

## Backend implementer signal (2026-05-25, commit <sha>)

**Option taken: RESTORE — with an injection-point adaptation.** The "Restore (preferred)" path was implemented, but the task's premise that `buildBridgeBody` is "called inside the lock-acquired body" of `/register` is STALE. Verified against current `backend/src/routes/bridge.ts`:

- The outer-catch is intact and matches the spec exactly: event tag `'bridge.register.internal_error'`, response 500 `INTERNAL_ERROR` with message `'Failed to register bridge paper'`, context fields `route: 'bridge.register'`, `identifier`, `username`, `permlink`.
- BUT `buildBridgeBody` / `buildBridgeMetadata` are NOT imported or called by `bridge.ts` anymore. `grep` confirms they are now consumed ONLY by `backend/src/bridge-worker.ts` (the queue dispatcher), lines 34-35/252-253. The queue migration moved post-body construction out of the route. So mocking `buildBridgeBody` could never reach the route's outer-catch — the prior orphan mock was a dead injection point.
- The reachable in-body throw that escapes to the outer-catch (the try block spanning `checkExistingBridge` → `tryEnqueueBridgeImport` → 202-response build) is **202-response serialization**: `serializeQueueRow(enqueueResult.row)` calls `row.scheduled_at.toISOString()` synchronously inside the outer try. `checkExistingBridge` has its own internal catch (→ `haf_unavailable`/503) and `tryEnqueueBridgeImport` is wrapped in an inner catch (→ `bridge.register.enqueue_failed`), so neither escapes to the outer-catch; serialization does.

**Adaptation:** injection now goes through a new `vi.mock('../../src/bridge-queue.js', ...)` block exposing `tryEnqueueBridgeImport` as a vi.fn passthrough. The new spec uses `mockImplementationOnce` to return `{ status: 'enqueued', queuePosition: 1, row: { ...scheduled_at: 'not-a-date' } }`, which makes `serializeQueueRow` throw synchronously inside the outer try. Removed the now-genuinely-orphan `buildBridgeBody` `vi.fn` passthrough from the `vi.mock('../../src/bridge.js', ...)` block and rewrote the stale `buildBridgeBody` carve-out header paragraph to document the `tryEnqueueBridgeImport` mock instead (same clause-a justification + clause-c real-path companion `bridge-haf-lag-locks.test.ts`).

**Spec details:** new describe `'POST /api/bridge/register — outer-catch fall-through emits bridge.register.internal_error'` (behavioral anchor; no slug/round/SHA). Signed `/register` POST survives `validateRegisterBody` + real `verifyHiveSignature` + `getAccreditedSet` (in-memory accredited set) + lock acquisition (Redis stubbed to unavailable → unlocked path) and reaches the lock-acquired body. Asserts 500 / `INTERNAL_ERROR` / `'Failed to register bridge paper'`; finds the log by `event === 'bridge.register.internal_error'` (not message substring) then asserts `route: 'bridge.register'`, `identifier`, `username`, `permlink`, `err instanceof Error`, plus no broadcast.

**Verification:** `npm run typecheck` clean; `npm run lint` clean (test file lints 0 findings; the one pre-existing `author-supersession.ts` warning is unrelated). `npx vitest run tests/routes/bridge.test.ts` → 13/13 passed (bridge test uses mocked db/redis; env supplied inline). Production `backend/src/routes/bridge.ts` byte-unchanged (`git diff --stat` empty). **Mutation-kill:** changing the production event literal `'bridge.register.internal_error'` → `'bridge.register.MUTANT'` flips ONLY this new spec RED (12 passed / 1 failed), confirming the event-discriminator is the load-bearing assertion; restored and re-ran green.
