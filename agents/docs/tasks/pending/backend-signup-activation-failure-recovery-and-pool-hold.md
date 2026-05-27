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
