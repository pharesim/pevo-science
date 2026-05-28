# BACKEND-SIGNUP-ACTIVATION-FAILURE-RECOVERY-AND-POOL-HOLD — Make /confirm + /link account activation crash-recoverable without pinning a pool connection across the chain broadcast

**Owner:** backend
**Created:** 2026-05-27 (architect, surfaced by `/ce-code-review` of the signup-binding cluster — correctness/reliability/adversarial/performance convergence)
**Priority:** P2 (high impact × low likelihood at single-instance beta; one root design tension)

## Context

`POST /api/auth/confirm` and `POST /api/auth/link` (`backend/src/routes/signup-verify.ts`) activate a pending signup inside a `pg_advisory_xact_lock` transaction so a single `auth_token` cannot double-fire the single-use `createClaimedAccount` chain broadcast. The lock is the right fix for the double-fire race (verified working). But running the irreversible chain op inside the held-connection transaction creates two coupled problems that the cluster review surfaced:

### Facet 1 — recovery gap (PRE-EXISTING, not introduced by the advisory-lock work)

`createClaimedAccount` creates the on-chain account (irreversible, consumes a finite claimed-account token), then `encryptKey` runs, then the `UPDATE` clears `verify_token`, then `COMMIT`. If anything between the chain op succeeding and the durable commit fails — `COMMIT` itself, a connection drop, or the synchronous `encryptKey` throwing on a misconfigured `CUSTODY_ENCRYPTION_KEY` — the `ROLLBACK` restores `verify_token` (still set). On retry, the lookup finds the row, `getAccounts` shows the Hive account already exists, and the handler returns `409 DUPLICATE`. The Option C stuck-recovery path only matches `verify_token IS NULL`, so it does NOT cover this state: the user is permanently locked out behind a 409 and a claim token is burned. Verified pre-existing — the same `createClaimedAccount → encryptKey → UPDATE` ordering existed in the prior autocommit code, so this is a long-standing failure mode, not a regression. The advisory-lock transaction-wrap marginally widens it (COMMIT is one more failure point) but did not create it.

### Facet 2 — pool saturation (NEW, introduced by the advisory-lock work)

The transaction now holds one pool client across the full activation: `BEGIN` → lock → `getAccounts` (~10s dhive timeout) → `createClaimedAccount` (~30s broadcast timeout) → `UPDATE` → `COMMIT` — up to ~40s. With the app pool `max=5` (`backend/src/app-db.ts`), ~5 concurrent distinct-token signups check out all connections; the 6th connection request on any pool-using route fails after `connectionTimeoutMillis`. The prior autocommit code never held a connection across the broadcast, so this is new. Low likelihood at single-instance beta (simultaneous signups are rare), but a genuine resource-exhaustion vector.

These are two faces of one tension: an irreversible chain op that must be **deduplicated** under concurrency, must **not pin a scarce pool connection** across a slow chain round-trip, and must **fail recoverably**. A correct fix addresses them together.

## Constraint (do not regress)

Any redesign MUST preserve the **single-fire invariant**: at most one `createClaimedAccount` broadcast per `auth_token` under concurrency. The naive "move `createClaimedAccount` outside the lock" fix reopens the double-fire (two concurrent requests both pass a pre-lock check and both broadcast). The existing concurrent-activation test must still pass.

## Goal

Implementer's call on mechanism; acceptable shapes include:

1. **Durably record "chain account created" before the broadcast resolves into the cleared-`verify_token` state.** E.g., a row state column / marker written so that a crash mid-activation is detectable on retry, and the retry RESUMES the pg activation (encrypt keys + clear `verify_token`) WITHOUT re-broadcasting `createClaimedAccount`. Closes Facet 1.
2. **Do not pin a pool connection across the ~30s chain broadcast.** E.g., hold the advisory lock + record an "activating" marker + release the connection during the broadcast, then re-acquire to finalize; or move the broadcast out of the held connection while a dedup marker (a pg row state, or a Redis `SET NX` keyed per `auth_token`) lets a concurrent request observe the in-flight activation and bail. Closes Facet 2 while preserving single-fire. (Document the chosen approach and its single-fire argument.)
3. **Widen Option C stuck-recovery** to also cover the `verify_token`-still-set-but-chain-account-exists state (posting-key ownership proof on `/confirm`, signature on `/link`, mirroring the existing recovery gates), so even a mid-activation crash is user-recoverable rather than a permanent 409.

**Cheap partial mitigation that can land independently:** move the synchronous `encryptKey` call BEFORE the irreversible `createClaimedAccount` so a key-config error fails fast (500) before any claim token is burned.

## Acceptance

- A failure between `createClaimedAccount` success and durable activation leaves the user recoverable: a retry resumes activation without re-broadcasting, with no permanent 409 lockout and no second claim-token burn. Test exercises this (real Postgres; simulate the post-broadcast failure).
- A misconfigured `CUSTODY_ENCRYPTION_KEY` fails before any irreversible chain op (no burned token on a config error).
- Concurrent distinct-token signups do not exhaust the app pool: either no connection is pinned across the full chain broadcast, or the design otherwise prevents starvation. Document the chosen approach; a pool-pressure test or a documented rationale demonstrates the property.
- The single-fire invariant holds: the existing concurrent same-token test still passes (at most one `createClaimedAccount` per `auth_token`).

## Non-goals

- Reworking the session-binding mechanism (`backend-auth-token-session-binding`) or the rate-limit key cap (already landed).
- Changing the 24h signup-token expiry.

## Coordination & opportunistic cleanup

- This reworks the same `/confirm` + `/link` activation handlers as `backend-confirm-concurrent-activation-lock` (currently round-2 held for comment/test polish). Prefer landing that task's cheap fixes and archiving it first, then this redesign — or fold both if doing the redesign immediately — to avoid churning the same code twice. The interim `lock_timeout` and the "connection intentionally held" comment from that hold are superseded once this redesign removes the cross-broadcast connection hold.
- Opportunistic (below PEvO's 3-site extraction threshold today, but this redesign touches exactly this code): the `/confirm` and `/link` handlers share a copy-pasted `BEGIN`/advisory-lock/re-read/activate/`COMMIT`/release scaffold with a load-bearing `inTransaction` flag (every early-return ROLLBACK path must reset it or the catch double-ROLLBACKs), and `SignupRow`/`LinkRow` are byte-identical local types. If the redesign naturally consolidates the activation path, extract a single `withSignupActivationLock(...)` helper and hoist the shared row type; anchor any comment on the behavior, not on this task.

## [BLOCKED by Architect] — RESOLVED 2026-05-27 (moved to pending/)

This redesign reworks the exact `/confirm` + `/link` activation handlers that `backend-confirm-concurrent-activation-lock` was in `tasks/review/` for. Starting while that task was under review would have churned code mid-review and collided with the architect's review pass, and the interim `lock_timeout` / "connection intentionally held" fixes would have been superseded mid-review.

**Resolution:** `backend-confirm-concurrent-activation-lock` is archived (round-2 hold items all landed clean), so the activation scaffold is settled. This file is back in `tasks/pending/`. See the Architect unblock note below for the review residuals carried into this task.

## Architect unblock + carried-forward review residuals (2026-05-27)

The round-2 re-review of `backend-confirm-concurrent-activation-lock` surfaced three residuals that belong here, because this redesign reworks the same `/confirm`+`/link` activation path and supersedes the interim `lock_timeout`:

1. **Slow-holder spurious 500 (interim-mechanism edge).** When the advisory-lock holder runs longer than the 45s `lock_timeout` ceiling — worst case `getAccounts` failover budget plus the ~30s `createClaimedAccount` broadcast, under Hive-node degradation — a concurrent same-token waiter times out (pg 55P03) and gets a 500 instead of the pre-`lock_timeout` graceful already-consumed 400/200. No correctness break (the single-use `verify_token` UPDATE is the real backstop). Removing the cross-broadcast connection hold eliminates this; if any interim contention bound survives the redesign, prefer translating a lock-acquisition timeout into the already-consumed re-read path rather than a 500.
2. **int4 `hashtext` collision docblock.** `lockSignupActivation`'s docblock calls a rare int4 `hashtext` collision between two distinct tokens "harmless because each re-reads its own row" — accurate before `lock_timeout`, but with the 45s bound a colliding waiter could 500 before re-reading. Self-corrects once the redesign removes the connection-hold/`lock_timeout`; otherwise the wording needs updating.
3. **`lock_timeout`→55P03→500 path is untested.** The round-2 log-shape test injects its synthetic failure on the no-op `SET LOCAL lock_timeout` statement (before any lock is held or row written), so the inner-catch ROLLBACK it drives is empty and the real lock-acquisition-timeout→500 mapping plus connection-release-on-timeout has no direct coverage. The redesign will write fresh tests for whatever timeout/dedup mechanism replaces `lock_timeout`; **acceptance below should pin that mechanism's contention-timeout behavior** — a synthetic 55P03-coded injection at the lock-acquisition query is the cheap shape (mirrors the existing `(pool as any).connect` injection shim), or assert the connection-releases-without-500 property if the redesign removes the timeout entirely.

See this task's Coordination section above (the interim `lock_timeout` and "connection intentionally held" comment are explicitly superseded by this redesign).

## Backend completion signal (2026-05-28) — implemented in commit `e48b1d60`; task file was stranded in `pending/`

The redesign landed in `e48b1d60` (a prior backend session) but the task file was never `git mv`d out of `pending/`. A subsequent backend startup verified the implementation against the acceptance criteria and the carried-forward review residuals, ran the targeted suite green, and moved the file to `review/`. No re-implementation; this is the normal pending→review transition.

**What landed (`e48b1d60`):**
- New `backend/src/lib/signup-activation-lock.ts` — per-`auth_token` activation lock (`acquireSignupActivationLock`) replacing the cross-broadcast pg advisory lock. The broadcast now runs with NO pooled connection held (closes Facet 2 pool-saturation); the lock survives connection release and gives single-fire across the ~30s broadcast.
- `signup-verify.ts` `/confirm` + `/link` reworked: encrypt-before-broadcast (key-config error → 500 before any claim-token burn), `resumeChainExists` path (verify_token-set + chain-account-exists crash gap → resumes storing keys + clearing verify_token WITHOUT re-broadcasting, closes Facet 1), and the slow-holder lock-contention path now returns a retriable 409 LOCK_HELD instead of a spurious 500 (carried-forward residual #1).

**Acceptance ↔ test mapping (`signup-verify-activation-recovery.test.ts` + `-concurrent-activation.test.ts`):**
- Crash-resume w/o re-broadcast or 2nd token burn → `resumes (stores keys, clears verify_token) without re-broadcasting ... or burning a second token`
- Encrypt-fail-fast before chain op → `misconfigured CUSTODY_ENCRYPTION_KEY fails (500) BEFORE createClaimedAccount fires`
- No pool starvation across broadcast → `max concurrent distinct-token activations leave the pool free for other queries mid-broadcast`
- Single-fire invariant → `two concurrent /confirm ... exactly one 200, createClaimedAccount called at most once` (+ `/link` variant)
- Residual #1 (slow-holder → graceful, not 500) → `returns a retriable 409 LOCK_HELD (not 500) when a holder keeps the lock past the wait budget`

**Verification (2026-05-28):** `signup-verify-activation-recovery.test.ts`, `signup-verify-concurrent-activation.test.ts`, `signup-verify.test.ts` → 19/19 passing against real Postgres/Redis (file-serialized). `npm run typecheck` was clean as of `e48b1d60`; no further source change in this transition.

**Residuals #2/#3 disposition:** both are conditioned on the interim `lock_timeout` mechanism, which this redesign removed. #2 (the `hashtext`-collision docblock that referenced the 45s bound) and #3 (the untested `lock_timeout`→55P03→500 path) are obsolete; the new lock-contention behavior is instead covered by the `retriable 409 LOCK_HELD` test above. Flagging for architect confirmation during review.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
