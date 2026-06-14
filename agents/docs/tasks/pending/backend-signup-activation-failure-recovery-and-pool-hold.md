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

## Architect review (2026-05-30) — HELD PENDING FIXES (round 1)

`/ce-code-review` on commit `e48b1d60` (8 personas — correctness/security/adversarial on Opus; reliability/testing/maintainability/project-standards/kieran-typescript on Sonnet; learnings researcher; `ce-agent-native-reviewer` skipped per PEvO). Core redesign is **sound on substance**: encrypt-before-broadcast verified at `signup-verify.ts:500-501` before `createClaimedAccount` at `:508` (a misconfigured `CUSTODY_ENCRYPTION_KEY` fails fast — no claim-token burn); pool starvation across the broadcast is genuinely closed (no `pool.connect()` retained across the chain op; every pg call uses `pool.query()` short-lived checkout); single-fire of `createClaimedAccount` holds via SET-NX + CAS-nonce-release on the happy Redis path; the `resumeChainExists` branch correctly serializes via the lock and skips re-broadcast when the chain account already exists; the `409 LOCK_HELD retriable:true` path replaces the spurious 55P03→500 on slow holders. The five acceptance criteria's tests are genuine mutation-killers (the encrypt-fail-fast `not.toHaveBeenCalled` assertion, the pool-pressure probe with `Promise.all`+gate-held mock, the `toHaveBeenCalledTimes(1)` single-fire pin, the gate-held 409 test). Carried-forward residuals #2 (`hashtext`-collision docblock) and #3 (`lock_timeout`→55P03→500) are CONFIRMED OBSOLETE — the new lock module removed the interim `lock_timeout` mechanism cleanly; no vestige remains in `signup-verify.ts` or `signup-activation-lock.ts`. Architect doc edit landed at this hold: `ARCHITECTURE.md § 6.1` "Reached by" for State D now enumerates the `/link` signup-verify(self) path; `§ 6.3` transition table adds `F ──signup-verify(self)──> D` so the `/link` stuck-resume defense at `signup-verify.ts:573-583` is grounded in the documented state machine (closes the `account-state defense review` doc-update-first item). Seven items hold the archive; the eighth (encrypt-fail-fast async-refactor robustness) was dismissed per `feedback_dismiss_preemptive_test_hardening`. Three findings spin out as separate tasks (filed in `tasks/pending/`): pre-existing anchor rot in signup-verify.ts + 4 test files → `backend-anchor-rot-sweep-signup-verify`; `/confirm`+`/link` ~110-line scaffold duplication → `backend-signup-verify-activation-scaffold-extraction`; UPDATE-failure-after-broadcast end-to-end test → `backend-signup-activation-update-failure-injection-coverage`.

1. **(P1, conf 80 — adversarial + security) `/confirm` stuck-recovery filter matches every steady-state light-custody row, not just mid-crash ones.** The filter at `signup-verify.ts:463-488` is `WHERE username=$1 AND verify_token IS NULL AND custody='light' AND posting_key_enc IS NOT NULL` — matches every successfully-finalized light-custody row in steady state. POSTing `/confirm` with ANY non-empty `auth_token` + a victim's username + their `posting_private` mints a fresh JWT via the stuck-resume's JWT-mint path (handler entry at `:691-705`), bypassing the password-gated `/api/auth/login` flow; bounded only by the IP-keyed 10/h limiter (per-token limiter doesn't catch this because attacker submits fresh tokens). Not a privilege escalation strictly (attacker needs the posting key, which already grants ownership), but contradicts the redesign's stated "auth_token still single-use" acceptance criterion — `auth_token` is treated as irrelevant on this path. Fix: tighten the stuck-recovery filter to require a recency / staleness marker so the path can only fire on a row recently written without finalization, not on every steady-state light-custody row. Cheap shape: `AND updated_at > NOW() - INTERVAL '1 hour'` (no schema change; the path is real-stuck-only by construction since `updated_at` is bumped at every signup-verify activation). Alternatively a dedicated `recovery_eligible` column set only when the activation crashed mid-flight (requires migration). Implementer's call on mechanism; the load-bearing property is "matches only genuinely-stuck rows, not steady-state". Item 6 below couples here.

2. **(P1, conf 75 — security + correctness + reliability + adversarial; cross-reviewer-promoted from anchor 50) Redis-down split-brain breaks lock-side single-fire; convention requires fail-closed on irreversible writes.** Race at `lib/signup-activation-lock.ts:116-137`: Holder H1 acquires Redis lock at T=0, Redis flaps unavailable at T=10 mid-`createClaimedAccount`. Concurrent same-`auth_token` H2 arrives at T=15, sees `isRedisAvailable()=false`, falls through to `memoryTryAcquire` — the in-process Map has no entry (H1's lock lives in Redis, not memory), H2 acquires the in-memory lock and double-broadcasts (burns 2nd claim token). The lock module's docstring acknowledges this and treats Hive consensus (rejecting duplicate `create_claimed_account` for an existing name) as the safety argument, not the lock — but per the canonical PEvO convention `read-then-write-races-on-haf-backed-routes-2026-05-15`, irreversible writes MUST fail-closed (503) when Redis is unavailable rather than degrade to the no-lock path (unlike orcid/bridge which degrade gracefully because their ops are idempotent — `createClaimedAccount` burns a finite claim token). Fix: drop the in-memory fallback for THIS lock (other call sites of the lock module pattern are unaffected; the deviation is specific to the signup-activation lock because of `createClaimedAccount`'s irreversibility). When `isRedisAvailable()` returns false at acquire time OR when `redis.set` throws after the availability check passes, return `{ acquired: false, reason: 'unavailable' }`; route maps to 503 retriable (mirroring the existing 503-retriable pattern for HAF unavailability). Update the lock module docstring to remove the "Hive consensus is the safety argument" caveat — the lock now IS the safety argument once in-memory fallback is gone. Add a unit test pinning that a `getRedis()` mock returning unavailable causes `acquireSignupActivationLock` to return the unavailable reason AND that `/confirm` returns 503. Couples with item 7's docstring reword.

3. **(P1, conf 75 — kieran-typescript) `createResult.block_num: 0` silently returned on both resume paths.** At `signup-verify.ts:408` the local is declared `let createResult: { block_num: number } = { block_num: 0 }` — type has no null branch, but both resume paths (`resumeChainExists` crash-resume + `verify_token`-NULL stuck-resume) skip the `if (!resumeStuck)` block that contains the actual `createClaimedAccount` assignment, so the local stays at `{ block_num: 0 }`. The 200 response at `:704` unconditionally returns `block_num: createResult.block_num`. Semantically a "block 0 doesn't exist on Hive" answer, but the response shape says "your account was created in this block". Frontend doesn't currently consume `block_num` from `/confirm`, so no live regression — but it's a type-contract lie that misleads any future consumer (frontend telemetry, integration test, fork). Fix: change `createResult` type to `{ block_num: number } | null`, initialize to `null`, conditionally omit `block_num` from the 200 response (or include it as `null`) on both resume paths. Add an assertion to the chain-exists crash-resume test in `signup-verify-activation-recovery.test.ts` pinning the new response shape (companion to item 1's coverage gap noted in #6 below).

4. **(P2, conf 90 — adversarial + correctness) Lock-release-before-accreditation gap permits double accredit-broadcast + double JWT mint on same-token retry.** The activation lock is intentionally released at `signup-verify.ts:552-553` (`/confirm`) and `:869` (`/link`) BEFORE the accreditation broadcast — documented design choice (lock module docstring `:546-551`; keeping the lock held across accreditation would re-introduce a long-hold problem for a non-irreversible op). But a same-token retry R2 arriving during R1's ~30s accreditation window acquires the lock (R1 released it), reads the row → `verify_token IS NULL` (R1 finalized it), falls into stuck-recovery, broadcasts a SECOND `accredit` custom_json (HAF probe lags R1's just-landed accredit), mints a SECOND JWT. `createClaimedAccount` IS still single-fired (the chain-exists `getAccounts` check catches it). The `/link` concurrent test explicitly tolerates this contract (`expect(broadcastCalls).toBeLessThanOrEqual(okCount)` — best-effort dedup); the `/confirm` test/acceptance implicitly claims stricter single-fire. Either tighten `/confirm` to match `/link`'s acceptance criterion OR document the dedup-via-read-time-`ROW_NUMBER` + `seedAccreditationBonus SET NX` backstop in `/confirm`'s contract. **Couples with item 1's filter narrowing:** the same recency/staleness marker that fixes item 1 closes this scenario automatically — a recently-finalized row is in steady state, not "stuck", and falls through to the normal 200 OK response on retry rather than into the resume path. Add a test fires a third same-token request DURING winner's lock-release-to-accreditation window asserting (a) NO second `createClaimedAccount`, (b) NO second `accredit` broadcast, (c) NO second JWT mint — converting the implicit acceptance claim into a real test.

5. **(P2, conf 85 — reliability + correctness) 409 LOCK_HELD consumes per-token rate-limit budget → 429 cliff.** The per-token rate limiter (`confirmTokenLimiter` / `linkTokenLimiter`, max=5/hour/token) at `signup-verify.ts:129-140, 387-396, 753-762` runs BEFORE `acquireSignupActivationLock`, so a 409 LOCK_HELD with `retriable:true` still consumed a slot. Under slow-but-healthy Hive node holder running ~30s, an auto-retrying client (as the response hint suggests) can burn all 5 slots in <2 minutes and end up at 429 with a 1-hour cooldown. The "Please retry in a moment" hint becomes misleading when the next retry is 429. Fix: skip the per-token rate-limit decrement when returning 409 LOCK_HELD (the slot was consumed by the holder, not the waiter; double-counting penalizes the waiter for the holder's slowness); add a `Retry-After` header on 409 LOCK_HELD so the client backs off respectfully rather than tight-looping. Leave `LOSER_WAIT_BUDGET_MS` at 5s to keep waiter connection hold bounded.

6. **(P2, conf 75 — security + adversarial + testing + correctness convergence) Lock-TTL-expires-mid-holder coverage gap (closes the only test gap not already addressed by items 1-5).** The `signup-verify-activation-recovery.test.ts` suite covers acceptance criteria via mutation-killing tests, but no test exercises the TTL-self-expiry-during-broadcast scenario: holder process slowdown beyond the 60s TTL (under sustained pool pressure, GC pause, syscall stall) leaves the lock self-expired with the broadcast still pending; the next request acquires fresh and may attempt to re-broadcast. The chain-exists resume catches the duplicate-name reject (the safety net), but no test pins the integrated path. Add a small test using the existing `gate-held Promise` pattern + a TTL-shrink override for the test, asserting that when the lock self-expires mid-broadcast, the next acquire DOES detect chain-exists AND DOES resume without re-broadcasting. Other test gaps surfaced by reviewers are closed by their coupled items: in-memory fallback test (item 2's hold), ADV-001 scenario test (item 1's hold), third-same-token-during-accreditation test (item 4's hold), block_num-on-resume assertion (item 3's hold).

7. **(P2, conf 80 — reliability + correctness) Lock TTL docstring claims `~35s holder budget` but real worst case is `~45s`.** Module docstring at `lib/signup-activation-lock.ts:60-67` states TTL=60s with `~35s holder budget` (encrypt + 30s `createClaimedAccount` + finalize). Real worst case is `~45s` once both `getAccounts` calls inside the lock window are counted — `hiveClient` has `timeout: 10_000`, and a degraded Hive node can have BOTH the availability check (`signup-verify.ts:451`) AND the posting-key-proof check (`:832`) each run to their 10s limit. The 60s TTL still covers the real worst case (15s margin instead of the documented 25s), but the docstring overstates the safety margin and the single-fire argument's TTL > holder-budget claim is built on the wrong numerator. Couples with item 2's docstring reword. Fix: update the holder-budget estimate to `~45s`, narrow the documented margin to `15s`, note that any future addition to in-lock IO (timeout bumps, new pre-broadcast calls) requires a TTL audit.

Dismissed at triage (no action required): **encrypt-fail-fast ordering robustness against a future async `encryptKey` refactor** — per `feedback_dismiss_preemptive_test_hardening`, the failure mode is contingent on a hypothetical refactor that doesn't currently exist; the current `not.toHaveBeenCalled` assertion pins ordering for the synchronous-throw implementation.

Spun off as separate tasks (filed in `tasks/pending/` at this hold): **pre-existing anchor rot** in `signup-verify.ts` + 4 test files (10 sites; not introduced by this commit) → `backend-anchor-rot-sweep-signup-verify`; **`/confirm` + `/link` ~110-line scaffold duplication** (the task body's `withSignupActivationLock(...)` extraction was not done; redesign widened the duplicated section) → `backend-signup-verify-activation-scaffold-extraction`; **UPDATE-failure-after-broadcast end-to-end test** (the recovery test currently seeds post-crash row state directly rather than driving the failure transition that produces it) → `backend-signup-activation-update-failure-injection-coverage`.

Learnings researcher surfaced three PEvO conventions worth a parallel audit but NOT held here: `chain-write-timeout-ambiguous-outcome-2026-04-22` (a `BroadcastTimeoutError` from `createClaimedAccount` should yield 504 retriable:false + outcome:uncertain envelope + Option A.1 lock-TTL extension; not implemented this round); `validate-once-cache-secret-pattern-2026-05-11` (the HKDF master key + AES key material should be parsed once at boot, not per-request); `post-broadcast-grace-period-record-must-follow-permanent-rethrow-cleanup-2026-05-19` (the resume record write ordering vs cascade cleanups). Architect's call: these are convention-compliance concerns, not regressions; surface for the implementer's awareness during the hold cycle and file follow-ups only if a real reachable failure mode is discovered.

When items 1-7 land, `git mv` this file back to `tasks/review/`. The mv is the re-review signal; round-2 review scopes to the fix commit(s) only. Do not edit this hold block; the commit diff is the evidence.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>

## [BLOCKED by Architect] (2026-06-05) — implementation complete, two hold-spec decisions needed before finalize

All 7 round-1 hold items are implemented and tested (50/50 signup-verify-* against real
Postgres/Redis; `npm run typecheck` + `npm run lint` clean). The work is **NOT in `main`**
— it is committed at `225d3ebe` and preserved on branch `backend-signup-activation-holds-wip`
(also in worktree `agent-a64333b45c3aac14f`). It was deliberately not merged: item 1 adds a
migration (`016_accounts_updated_at.sql`) and an unrun migration file in `main` would fail the
next backend boot's `verifyAppDbMigrations` probe. Two hold-spec issues need an architect
decision before this is merged + moved to `review/`:

**Decision A — item 1 requires a schema change the hint said it wouldn't.** Item 1's hint:
"`updated_at > NOW() - INTERVAL '1 hour'` (no schema change; updated_at is bumped at every
activation)." There is **no `updated_at` column on `accounts`** (only `created_at`,
`upgraded_at`, `expires_at`; none is bumped at `/confirm` finalize). The implementer took the
hold block's own named fallback ("a dedicated column ... requires migration. Implementer's
call on mechanism") and added migration `016` + sets `updated_at = NOW()` in both finalize
UPDATEs. Confirm the migration mechanism is acceptable, OR specify an alternative (e.g. a Redis
finalize-recency marker keyed per username, no DB column). Note: accepting the migration means
`./deploy.sh migrate` must run before the next backend start.

**Decision B — item 4's "no second JWT" is unsatisfiable as written.** The hold claims item 1's
recency marker "closes item 4 automatically — a recently-finalized row is in steady state, not
stuck." This is contradictory: a same-token retry *during* the accreditation window is the
*most* recently-finalized row, so item 1's `> NOW() - 1h` guard *admits* it to the resume path
— and the existing `signup-verify-stuck-recovery.test.ts` *requires* fast retry to enter
recovery (200 + JWT). A single recency marker cannot both admit fast retry (stuck tests) and
exclude it (item 4); there is no DB trace of accreditation completion to distinguish them. The
implementer implemented item 1 faithfully, kept all stuck-recovery tests green, and wrote the
item-4 test asserting the genuinely-guaranteed invariants — **no second `createClaimedAccount`**
(chain-exists check) and **no second accredit broadcast** (HAF-probe-observed) and a single
activated row — but did NOT assert "no second JWT mint" (the resume path mints one by design,
matching `/link`'s documented best-effort contract). Confirm the best-effort-JWT contract for
`/confirm` (matching `/link`), OR require strict single-JWT by holding the lock across
accreditation for the fresh path (which contradicts the documented lock-release-before-
accreditation design choice).

**Back-fill bug found in review (fix once Decision A confirms the migration).** Migration `016`
uses `ADD COLUMN ... NOT NULL DEFAULT now()`, which back-fills existing rows to migration time —
so for the first ~1 hour post-deploy every pre-existing finalized account satisfies
`updated_at > NOW() - INTERVAL '1 hour'`, leaving the stuck-recovery bypass item 1 closes **open
for ~1h after deploy**. The migration's own comment claims existing rows "fall outside the
recovery window," but `DEFAULT now()` does not achieve that. Fix: back-fill existing rows to a
definitively-past value (e.g. `UPDATE accounts SET updated_at = created_at` before `SET NOT NULL`
+ `SET DEFAULT now()`), so old finalized accounts are outside the window immediately. To be
applied when the migration mechanism is confirmed.

**What landed (`225d3ebe`, 7 items):** (1) both stuck-recovery lookups gated on
`updated_at > NOW() - INTERVAL '1 hour'` + finalize UPDATEs set `updated_at = NOW()` (migration
016); (2) lock fail-closed — in-memory fallback removed, Redis-down/throw → `reason:'unavailable'`
→ 503, docstring caveat removed; (3) `createResult` typed `| null`, `block_num` omitted on resume
paths; (4) double-accredit/double-JWT-window test (best-effort contract, see Decision B);
(5) 409 LOCK_HELD refunds the per-token rate-limit slot (`refundStatusCodes`) + `Retry-After: 5`;
(6) lock-TTL-self-expiry-mid-holder resume test; (7) TTL docstring holder-budget corrected to ~45s.

Architect: resolve A + B (and confirm the back-fill fix), then move this back to `pending/` for
the implementer to merge `backend-signup-activation-holds-wip` (with the back-fill fix), or
re-scope the changed items.

## [Architect] (2026-06-14) — DECISIONS A + B RESOLVED + back-fill confirmed; UNBLOCKED to pending/

**Decision A — accept migration `016_accounts_updated_at.sql` (the DB column, NOT a Redis marker).**
The recency guard's entire job is a *durable* "was this row recently written without
finalization" signal. A Redis finalize-recency marker is volatile (lost on flush/restart,
single-instance), so it would make the stuck-vs-steady-state distinction unreliable exactly
when it matters (post-restart recovery). A migration-added `accounts.updated_at` bumped at every
`/confirm`+`/link` finalize is the durable, schema-authoritative mechanism (per
`migrations-sole-schema-authority`), and `updated_at` is a generally-useful column. The hold's
"no schema change" hint was simply wrong (there is no existing bumped timestamp on `accounts`);
the implementer correctly took the hold's own named fallback. Accepted. Deploy note: this adds a
migration, so `./deploy.sh migrate` must run before the next backend start (the boot
`verifyAppDbMigrations` probe fails on an unrun migration — which is why the WIP was kept off
`main`).

**Back-fill fix — REQUIRED (confirmed).** Migration `016` must back-fill existing rows to a
definitively-past value before sealing the column, e.g. `UPDATE accounts SET updated_at =
created_at` THEN `ALTER ... SET NOT NULL` + `SET DEFAULT now()`. `ADD COLUMN ... NOT NULL DEFAULT
now()` alone stamps every pre-existing finalized row at migration time, leaving the item-1
stuck-recovery bypass OPEN for ~1h post-deploy. Land the back-fill with the merge.

**Decision B — accept the best-effort-JWT contract for `/confirm` (match `/link`); do NOT hold the
lock across accreditation.** The conflict is real and the implementer's reading is correct: a
single recency marker cannot both *admit* fast retry (required by the stuck-recovery tests) and
*exclude* it (item-4's "no second JWT"), because there is no durable trace of accreditation
completion to separate the two. Resolution: a duplicate JWT on a fast same-token retry during the
~30s accreditation window is **harmless** — it is minted for the *same* authenticated owner (who
already proved ownership via posting-key / signature on this path), and the properties that
actually matter are strictly held: **no second `createClaimedAccount`** (chain-exists check) and
**no second finite-claim-token burn**, with the second `accredit` bounded by the HAF-probe +
`seedAccreditationBonus` SET-NX backstop. Requiring strict single-JWT would force holding the lock
across the ~30s accreditation broadcast — which re-introduces the exact long-hold / pool-pressure
problem (Facet 2) this entire redesign exists to eliminate, so it is self-defeating and rejected.
The item-4 test as implemented (asserts no 2nd `createClaimedAccount`, no 2nd meaningful
`accredit`, single activated row; does NOT assert no-2nd-JWT) is correct and accepted. Action for
the implementer: state `/confirm`'s best-effort-JWT contract explicitly in the handler docblock
(mirroring `/link`'s documented contract) so a future reader does not mistake the resume-path
second JWT for a defect.

**Disposition.** All 7 round-1 hold items are implemented at `225d3ebe` on
`backend-signup-activation-holds-wip`; A + B are now resolved and the back-fill fix is required.
No re-scope needed. Moving to `pending/` for the implementer to: merge the WIP branch onto main
WITH the back-fill fix applied to migration `016`, add the `/confirm` best-effort-JWT docblock,
run `./deploy.sh migrate`-equivalent locally + the `signup-verify-*` suites green, then `git mv`
to `review/`. The round-2 re-review will scope to the merge commit.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
