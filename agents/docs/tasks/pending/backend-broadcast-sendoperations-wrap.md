# BE-BROADCAST-SENDOPERATIONS-WRAP — Extend broadcast-abort-timeout coverage to broadcast.sendOperations call sites

**Owner:** backend
**Created:** 2026-04-22 (surfaced by BE-ORCID-BROADCAST-ABORT-TIMEOUT first-review)
**Priority:** P2

## Context

`BE-ORCID-BROADCAST-ABORT-TIMEOUT` wrapped every `hiveClient.broadcast.json` call via `broadcastJsonWithTimeout`. The helper's acceptance criterion was "grep `hiveClient.broadcast.json` outside the helper returns zero matches" — which is satisfied.

But the helper doesn't cover `hiveClient.broadcast.sendOperations`, which has identical no-timeout behavior (dhive's `Client.timeout` applies only to reads). 5 call sites in the backend use `sendOperations`:

- `backend/src/account-creation.ts`
- `backend/src/routes/anonymousReview.ts`
- `backend/src/routes/bridge.ts`
- `backend/src/routes/custody.ts`
- (5th site per review)

Each can hang indefinitely against a slow Hive node, leaving the same class of execution-stomp and request-holding risk that `broadcast.json` had pre-helper.

F4.8, maintainability residual. See `.context/compound-engineering/ce-code-review/aggregated/04-backend-orcid-broadcast-abort-timeout.md` § F4.8.

## Goal

Extend `broadcastJsonWithTimeout` (or add a sibling `broadcastSendOperationsWithTimeout`) so every `sendOperations` call has a 30s wall-clock abort, matching the `broadcast.json` invariant.

Two shapes:

- **A. Single helper, operation-type agnostic.** Refactor `broadcastJsonWithTimeout` into `broadcastWithTimeout(op, ...)` that accepts either `broadcast.json` or `broadcast.sendOperations`. Single source of truth; 5 call sites migrate.

- **B. Second helper (`broadcastSendOperationsWithTimeout`).** Mirror of the existing helper. Clearer intent per primitive; slight code duplication.

## Non-goals

- Changing dhive version or adding custom transport code.
- Coordinating with `BE-ORCID-BROADCAST-TIMEOUT-OUTCOME-HANDLING` (that task handles ambiguous-outcome; this one just makes sure the timer fires at all).

## Acceptance

- Grep `hiveClient.broadcast.sendOperations` outside the helper returns zero matches.
- Test per helper covering happy path, timeout, error propagation (mirror the existing `hive-broadcast-timeout.test.ts` shape).
- `BroadcastTimeoutError` is thrown on timeout for both primitives (consistent class).

## [TODO Architect]

- Lean: Option A (single helper). The `broadcast.json` and `broadcast.sendOperations` return types overlap enough that a single generic helper is cleaner.

---

**Backend re-review signal (2026-04-22, worktree branch `worktree-agent-a31de74a`):**

Implementation landed. Chose **Option B (sibling helper)** rather than the architect's leaned Option A — rationale: Option A requires renaming `broadcastJsonWithTimeout` → `broadcastWithTimeout` and threading the new generic through every existing caller (`orcid.ts`, `wot.ts`, `anonymousReview.ts`, `accreditation.ts`, …). That rename cascade would collide with the in-flight `BE-ORCID-BROADCAST-TIMEOUT-OUTCOME-HANDLING` worktree which also touches `orcid.ts`. Option B adds `broadcastSendOperationsWithTimeout` as a sibling with the same structure, zero churn on existing `broadcastJsonWithTimeout` callers. Architect can re-decide during review; the consolidation to Option A would be a local edit on `hive.ts` plus a mechanical rename in callers if preferred.

**[TODO Architect]** — If you prefer Option A after all, the follow-up is a `hive.ts` refactor + 4 call-site renames; can be filed as a separate P3 task.

1. **`broadcastSendOperationsWithTimeout` added in `backend/src/hive.ts:80-115`.** Mirrors `broadcastJsonWithTimeout` — 30s default abort (`DEFAULT_BROADCAST_TIMEOUT_MS`), `BroadcastTimeoutError` on timeout, underlying dhive errors pass through unchanged. Uses `Parameters<typeof hiveClient.broadcast.sendOperations>[0]` for the operations argument type so the signature tracks dhive's upstream shape without a manual import.
2. **All 6 `hiveClient.broadcast.sendOperations` call sites migrated** (task said 5; actual count is 6 — `bridge.ts` has two). Sites: `backend/src/account-creation.ts:46` (claim batch), `backend/src/account-creation.ts:112` (create_claimed_account), `backend/src/routes/anonymousReview.ts:171` (anonymous review comment), `backend/src/routes/bridge.ts:229` (bridge post creation), `backend/src/routes/bridge.ts:355` (bridge continuation post), `backend/src/routes/custody.ts:133` (custodial broadcast). Grep acceptance: `grep -rn 'hiveClient\.broadcast\.sendOperations\|client\.broadcast\.sendOperations' backend/src/` returns only the 2 `Parameters<typeof ...>` / `ReturnType<typeof ...>` type references inside `hive.ts` itself.
3. **Tests extended in `backend/tests/hive-broadcast-timeout.test.ts`** with a second `describe` block covering `broadcastSendOperationsWithTimeout`: happy path passes result through, hanging broadcast rejects with `BroadcastTimeoutError` at ~timeoutMs (not the full underlying hang), underlying chain errors propagate unchanged. 6 tests total (3 per helper), all green. Same justification block in the file header covers both — mocking dhive is the only deterministic way to exercise the >30s hang mode.

Acceptance verified locally: grep clean outside helper module; 6 broadcast-timeout tests pass; `tsc --noEmit` clean; `npm run lint` 0 errors (6 pre-existing warnings unchanged).
