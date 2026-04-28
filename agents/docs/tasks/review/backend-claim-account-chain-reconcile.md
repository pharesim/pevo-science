# BE-CLAIM-ACCOUNT-CHAIN-RECONCILE — Reconcile DB claim count with chain after broadcast timeout

**Owner:** backend
**Created:** 2026-04-22 (surfaced by BE-BROADCAST-SENDOPERATIONS-WRAP first-review)
**Priority:** P2

## Context

`BE-BROADCAST-SENDOPERATIONS-WRAP` added a 30s `BroadcastTimeoutError` to `hiveClient.broadcast.sendOperations` call sites. In `backend/src/account-creation.ts` the `claimAccountTokens` loop wraps each `claim_account` batch broadcast through the new helper.

Correctness + reliability review (0.92/0.90 convergent) identified: if the broadcast times out AFTER the `claim_account` op actually lands on-chain, the DB INSERT at `account-creation.ts:~49-52` is skipped because the timeout threw before reaching it. On-chain `claim_account` exists, DB count doesn't track it. Future claim cycles read from DB and can re-broadcast against chain state that already holds the claim.

(A sibling task `backend-argon2-concurrency-cap` round-2 handles the discrimination problem — stop halving `batchSize` and retrying on timeout. This task handles the reconciliation problem — make the DB eventually catch up to the chain state when timeouts happen.)

## Goal

After a `BroadcastTimeoutError` during `claim_account` broadcast:
1. Query chain for the admin account's `pending_claimed_accounts` counter before and after the timed-out broadcast (or use a block-range query over `claim_account` ops signed by the admin account).
2. If the on-chain count increased by the expected batch size, INSERT the corresponding DB rows retroactively. If it increased by less, INSERT what landed.
3. If the reconcile query itself fails, log loudly and skip — next cycle retries.

## Non-goals

- Changing the timeout value or replacing `broadcastSendOperationsWithTimeout`.
- Reconciling `create_claimed_account` timeouts (separate sensitivity — those create actual user accounts).
- Adding a persistent reconciliation queue. Stateless per-cycle reconcile is the scope.

## Acceptance

- `claimAccountTokens` after a `BroadcastTimeoutError`: fetches the admin account's pending-claimed counter via `hiveClient.database.getAccounts([config.hiveAdminAccount])`, compares to pre-broadcast counter, INSERTs any delta into the DB.
- Loud structured log (`logger.error` with `{ err, batchSize, preCounter, postCounter, inserted }`) so operators can audit.
- One integration test exercising: pre-count known, mock timeout, mock chain advance by N, assert N DB rows inserted.

## [TODO Architect]

- Confirm `pending_claimed_accounts` counter is the right signal vs a block-range query over `claim_account` ops (counter is simpler; ops query is more robust against other admin activity).

Backend re-review signal (2026-04-22, worktree agent-ae8349d1):

Implementation landed. Summary of choices:

- Counter signal: chose `pending_claimed_accounts` from `hiveClient.database.getAccounts([config.hiveOnboardAccount])`. Queried on the onboarding account (the `creator` in `buildClaimOps`), not `hiveAdminAccount`, since those can differ in config (`hiveOnboardAccount` defaults to `hiveAdminAccount` but is independently overridable). The task description referenced `hiveAdminAccount`; selected `hiveOnboardAccount` because that is the account actually signing the `claim_account` ops and whose counter will advance.
- Pre-counter is captured on every loop iteration (before each broadcast attempt), not once per cycle, so a halving retry path still has a correct baseline if the eventual final attempt times out. Extra chain reads are cheap vs a 30s broadcast timeout.
- Reconcile branch returns `inserted` count so `claimed` stays accurate and the trailing `pending_tokens` log reflects reality.
- Clamp: `inserted = clamp(postCounter - preCounter, 0, batchSize)` — negative delta (someone burned claims) becomes 0; delta > batchSize (a parallel admin actor also claimed) is capped at our batchSize so we only INSERT what our broadcast was responsible for.
- Log severity: `logger.error` for full-landing reconcile and all failure branches (no pre-counter, post-counter read fails, INSERT fails, nothing landed); `logger.warn` for partial-landing reconcile (intermediate, operators need to know but it's a known-handled case).
- dhive's `ExtendedAccount` type does not declare `pending_claimed_accounts`; accessed via a narrow cast in `fetchPendingClaimedAccounts`.

Test coverage: 6 new reconcile cases (full landing, partial landing, nothing landed, concurrent-actor clamp, pre-counter read fails, post-counter read fails) plus the 2 existing discrimination tests. All 8 pass. `npx tsc --noEmit` clean; `npm run lint` clean (2 pre-existing warnings in `seed-phrase.ts` unchanged).

Files modified:
- `backend/src/account-creation.ts` (added `fetchPendingClaimedAccounts` helper, `reconcileClaimTimeout` helper, updated `claimAccountTokens` loop to capture `preCounter` per-iteration and call reconciler on `BroadcastTimeoutError` before breaking).
- `backend/tests/account-creation.test.ts` (added `getAccounts` mock + new `post-timeout chain reconcile` describe block with 6 cases; updated header justification).

---

## Architect re-review (2026-04-28) — HELD PENDING FIXES

`/ce-code-review` ran on commit `ef56eab` with 8 personas (correctness, reliability, testing, data-integrity-guardian, maintainability, project-standards, kieran-typescript, agent-native, learnings). The implementation does what the task scoped (counter-delta reconcile). Counter-signal correctness verified: `hiveOnboardAccount` is correct (`buildClaimOps` sets `creator: config.hiveOnboardAccount`); per-iteration preCounter capture handles halving-retry; clamp arithmetic correct; 6 reconcile cases pass. Project-standards clean (trailer, carve-out justification documented).

But: 2 cross-reviewer-agreement items + 1 unresolved [TODO Architect] block clean archive.

### Items to address (incremental fixes — keeps counter-delta architecture)

**1. (P2) Fix log severity on the success/no-op branches**

Three reviewers (reliability, maintainability, agent-native) converged: `logger.error` is overused. Specifically:

| Branch | Current | Should be | Why |
|---|---|---|---|
| Full landing reconciled (success) | error | **info** | Happy path; expected outcome of timeout-with-landing. Operators paged on every clean recovery is alert noise. |
| Partial landing reconciled | warn | warn (keep) | Correct. |
| Nothing landed (delta=0) | error | **warn** | Clean state, but timeout itself worth knowing. |
| Pre-counter null | error | error (keep) | Reconcile abandoned. |
| Post-counter read fails | error | error (keep) | Reconcile abandoned, divergence possible. |
| Post-counter null | error | error (keep) | Same. |
| INSERT fails | error | error (keep) | Actual divergence. |

Two-line change in `reconcileClaimTimeout`. Once the success path is at `info`, an error-rate dashboard becomes useful instead of dominated by recoveries.

**2. (P2) Cover the untested branches**

Three reviewers (testing, reliability, data-integrity) flagged the same gap. Add tests for:
- **INSERT failure** (the highest-impact failure mode — produces unrecoverable drift). Inject a pool.query rejection on the INSERT, assert: `logger.error` fires with the expected fields, the function returns 0, the loop breaks correctly, and the trailing log reflects the failure.
- **`postCounter === null`** (post-counter read returns success but the field was undefined/NaN/string). Assert: function returns 0, `logger.error` fires.
- **Negative delta** (post < pre — someone burned a claim or the chain rewrote). Assert: clamp to 0, no INSERT, log appropriately.

**3. (P3) Add a `reconcile_outcome` enum field to all reconcile log lines**

`reconcile_outcome: "full" | "partial" | "none" | "abandoned_pre" | "abandoned_post_read" | "abandoned_post_null" | "insert_failed"`. Lets operators build a `count by outcome` dashboard without parsing message strings. Existing `inserted`/`batchSize`/`preCounter`/`postCounter` fields stay — this is one extra discriminant.

**4. (P3) Document the `hiveOnboardAccount` choice in code**

The rationale (counter belongs to the `creator` of `claim_account` ops, which is `hiveOnboardAccount` not `hiveAdminAccount` despite the task's wording) is currently only in the task file. Add a one-line code comment at the first `fetchPendingClaimedAccounts(config.hiveOnboardAccount)` call site explaining the choice. Future readers landing in `account-creation.ts` shouldn't need to navigate to this task file to understand it.

### Items dismissed (file separately or accept)

- **Pre-counter read on every iteration** (reliability low): bounded by dhive 10s timeout; optimizable but cheap vs 24h cycle. Skip.
- **Trailing log misreports "RC exhausted" when reconcile succeeded** (correctness low): minor cosmetic, not load-bearing for ops triage. Fold into item 1's two-line edit if cheap; otherwise skip.
- **Mock typing loose** (kieran-typescript low): production code defends with runtime narrowing; test-side risk bounded. Skip.
- **`reconcileClaimTimeout` 4-arg signature mixes log-context with logic** (maintainability low 35): readable as-is; refactor not justified. Skip.

### Architect decision on the task's open [TODO Architect]

The task asked: "Confirm `pending_claimed_accounts` counter is the right signal vs a block-range query over `claim_account` ops (counter is simpler; ops query is more robust against other admin activity)."

**Decision:** the counter approach is the **interim** shape. It's adequate for current beta operating volume but has two structural gaps the data-integrity reviewer surfaced:

- **DI-1:** No idempotency key on `account_creation_tokens` (schema is `id SERIAL PK` only, no `claim_tx_id`/`block_num`/UNIQUE). Reconcile firing twice across a process restart produces phantom rows.
- **DI-2:** `pending_claimed_accounts` decrements on every `create_claimed_account`. If users sign up during the 30s broadcast hang, postCounter is depressed and reconcile under-inserts. Permanent silent drift.

The right long-term shape is **Option A.3** from `agents/docs/solutions/conventions/chain-write-timeout-ambiguous-outcome-2026-04-22.md`: HAF poll by `claim_account` op fingerprint (`account = hiveOnboardAccount`, block range `[pre_block, post_block]`), INSERT one row per op with idempotency key (`UNIQUE(claim_tx_id, claim_op_index)`).

**A new task `backend-claim-account-haf-op-reconcile.md` (P1) will be filed in the same architect commit that produces this hold block.** That task closes DI-1 + DI-2 + finding #3 (INSERT-failure observability via the idempotency key + a startup health check). This task does not block on the new one — incremental fixes 1-4 above can land first; the architectural migration is independent work.

### Re-review signal

When items 1-4 land, `git mv` this file back to `tasks/review/`. Architect's next pass scopes `/ce-code-review` to the round-2 commit and archives on clean.

---

Backend re-review signal (2026-04-28, worktree agent-a2ce0b3e, round 2):

All four hold-block items addressed in `backend/src/account-creation.ts` and `backend/tests/account-creation.test.ts`:

1. **Log severity tightening** in `reconcileClaimTimeout`:
   - Full-landing branch: `logger.error` -> `logger.info` (happy path).
   - Nothing-landed branch (delta=0): `logger.error` -> `logger.warn` (clean state, timeout still worth knowing).
   - Partial-landing branch stays `warn`. Pre-counter null, post-counter read failure, post-counter null, INSERT failure all stay `error` per the table.

2. **New test coverage** in the existing `post-timeout chain reconcile` describe block (3 cases):
   - INSERT failure: pool.query rejection on the reconcile INSERT (highest-impact failure mode). Asserts `logger.error` fires with `reconcile_outcome: 'insert_failed'` plus the expected discriminant fields, single broadcast attempt, single INSERT call with `[50]`, no halve/retry. Uses `vi.spyOn(logger, 'error')` so the mock is restored by `vi.restoreAllMocks()` in afterEach.
   - `postCounter === null`: post-timeout `getAccounts` returns an account record without the `pending_claimed_accounts` field (older API shape). Reconciler abandons; `reconcile_outcome: 'abandoned_post_null'` logged at error.
   - Negative delta (post < pre): pre=100, post=80. Clamps to 0; `reconcile_outcome: 'none'` logged at warn (matches the new severity for the delta=0 branch).
   The test header carve-out justification was already in place from round 1; no edits needed.

3. **`reconcile_outcome` enum field** added to all seven reconcile log lines:
   - `'full'` (full-landing info)
   - `'partial'` (partial-landing warn)
   - `'none'` (delta=0 warn — both true-zero and clamped negative)
   - `'abandoned_pre'` (preCounter null error)
   - `'abandoned_post_read'` (post-counter read threw error)
   - `'abandoned_post_null'` (post-counter field missing error)
   - `'insert_failed'` (DB INSERT rejected error)
   Existing `inserted` / `batchSize` / `preCounter` / `postCounter` fields preserved — `reconcile_outcome` is one extra discriminant.

4. **`hiveOnboardAccount` choice documented inline** at the first `fetchPendingClaimedAccounts` call site in `claimAccountTokens`. Five-line comment explains the counter belongs to the `creator` of `claim_account` ops (signer), the two config values default equal but are independently overridable, and the signer is the only correct read source.

The architect's [TODO Architect] resolution and the new follow-up task `backend-claim-account-haf-op-reconcile.md` for the HAF op-fingerprint migration (DI-1, DI-2, INSERT-failure observability) are not addressed here — incremental fixes only, per the hold block's framing.

Verification:
- `npx vitest run tests/account-creation.test.ts` -> 11/11 passing (8 prior + 3 new).
- `npm run lint` -> clean (2 pre-existing warnings in `seed-phrase.ts` unchanged).
- `npx tsc --noEmit` -> clean.
- Full vitest suite NOT run by this worker (parent serializes after fan-out merges).

Files modified:
- `backend/src/account-creation.ts` (log-severity tweaks, `reconcile_outcome` field on all log lines, inline rationale comment for `hiveOnboardAccount`).
- `backend/tests/account-creation.test.ts` (added `logger` import, three new test cases in the `post-timeout chain reconcile` describe block).
