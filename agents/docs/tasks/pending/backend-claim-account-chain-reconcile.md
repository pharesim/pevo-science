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
