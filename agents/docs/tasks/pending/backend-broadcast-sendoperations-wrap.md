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

---

**Architect re-review (2026-04-22) — HELD PENDING FIXES:**

First-pass `/ce-code-review` on commit `a4a3371` (correctness + reliability personas). All 6 `sendOperations` call sites correctly migrated; grep verification clean; tests mirror `broadcastJsonWithTimeout` shape. Two hold items on the new helper's interactions at call sites; one P2/P3 flattening of timeout-vs-chain errors filed as cross-reference to existing pending task.

1. **P2 — `claimAccountTokens` bare `catch{}` treats `BroadcastTimeoutError` as RC exhaustion** (correctness C2 0.92 + reliability R-T4-01 0.90, 2-reviewer convergence). `backend/src/account-creation.ts:~54-57` halves `batchSize` and retries on every throw. Task 4's new `BroadcastTimeoutError` inherits that behavior: a single 30s timeout produces up to `log2(50)≈6` retries × 30s = ~3 minutes of silent hanging, all logged as "insufficient RC." Fix: discriminate at the catch site — `if (err instanceof BroadcastTimeoutError) { logger.error({ err, batchSize }, 'claim_account broadcast timed out — outcome uncertain, DB count may diverge from chain'); break; }` (don't halve, don't retry, surface the error to the caller + next-cycle reconcile handles the DB/chain alignment via the separately-filed task `backend-claim-account-chain-reconcile.md`).

2. **P2 — New helper's JSDoc omits the two-phase timeout ambiguity caveat** (correctness C1 0.85). `broadcastJsonWithTimeout`'s docblock documents the orphan-outcome risk (tx may have landed during broadcast phase); `broadcastSendOperationsWithTimeout` at `backend/src/hive.ts:~99` omits the same caveat. dhive's `sendOperations` has the same preflight-read-then-broadcast pattern. Fix: copy the relevant paragraph from the sibling helper's docblock.

**Dismissed from round-1 findings (architect triage):**
- Route handlers flatten `BroadcastTimeoutError` + chain errors into the same 500 at `custody.ts:~144`, `bridge.ts:~264/~387`, `anonymousReview.ts:~236` (reliability R-T4-02 0.75): filed as a cross-reference note on the (in review/) pending task `backend-orcid-broadcast-timeout-outcome-handling.md`. Once that task's A.2 envelope is finalized, extend it to those 4 sites consistently. Dismissed here; tracked there.
- `as never` in test fixture (info 0.90): documented-only, no behavior impact.
- No AbortSignal threading at helper level (info 0.95): dhive's own limitation; matches sibling helper exactly.

**Filed as separate Pending task:**
- `backend-claim-account-chain-reconcile.md` (P2) — reconcile DB `claim_account` count with chain after timeout. Scope: query `pending_claimed_accounts` post-timeout, INSERT any delta into DB. Orthogonal to the discrimination fix above.

**Path to re-archive:** (1) Backend applies items #1-2 on this task. (2) Backend re-review signal block below the hold. (3) Architect re-reviews round-2; archives on clean.
