## BACKEND-A1-EXTEND-LOCK-MISSING-EVENT-DISCRIMINATION (archived 2026-05-01) — round-2 clean ✓

Add operational discrimination to the `binding_lock_extend_lock_missing` operator anchor on the post-broadcast cascade path. Pre-fix the anchor collapsed three distinct ops causes (self-expire from HAF lag preamble exceeding the 35s lock window / Redis eviction / sibling DEL) into one signal. Round-1 (`1aa2382`) added a `redis.pttl(lockKey)` probe immediately before `redis.expire(lockKey, HAF_INDEXING_LAG_CEILING_SECONDS)`; when `expire` returns 0, the structured `logger.error` payload now carries a 3-way `cause:` discriminator (`'expired_or_evicted'` if pttlBefore === -2, `'released_during_extend'` if pttlBefore > 0, `'unknown'` defensive default) plus the raw `pttlBefore` value for dashboard correlation. Probe is best-effort by design — if `redis.pttl` itself throws, the existing outer catch fires `event:'binding_lock_extend_threw'`. 2 specs landed at round-1: strengthened lock-absent spec asserts `cause:'expired_or_evicted'` + `pttlBefore: -2` under `objectContaining`; new race-window spec uses `vi.spyOn(redis, 'pttl').mockResolvedValueOnce(30_000)` + `vi.spyOn(redis, 'expire').mockResolvedValueOnce(0)` to drive the rare sibling-DEL race deterministically. Round-1 architect review: 5-persona pass; 2 cross-reviewer findings held — P1 (testing T01 + reliability gap convergence) on uncovered pttl-throw path, P2 (testing T02 + project-standards residual convergence) on unupdated test-header carve-out documentation. Round-2 hold-fix (`16dbbdd`, test-only) added a 3-spec pttl-throw block (×2 modes via `describe.each([accredit,link])`) using `vi.spyOn(redis, 'pttl').mockRejectedValueOnce(...)`, asserting `event:'binding_lock_extend_threw'` via `objectContaining` + negative-shape assertion against `binding_lock_extend_lock_missing` + `expireSpy.not.toHaveBeenCalled()` (round-1 best-effort-probe-runs-first invariant); extended the test-file header docblock with a paragraph enumerating all three new specs with carve-out clauses (a)/(b)/(c). Round-2 architect review: 3-persona pass (testing, project-standards, correctness), all clean.

Architect refresh applied during cluster-A walk: task body's stale `a1_extend_*` literal references updated to `binding_lock_extend_*` per the [TODO Architect] handoff from BACKEND-ORCID-LOCK-TTL-EXTEND-ON-TIMEOUT round-3 hold (which renamed the literals).

Architect-owned residual (deferred): the round-1 [TODO Architect] convention-doc paragraph in `agents/docs/solutions/conventions/chain-write-timeout-ambiguous-outcome-2026-04-22.md` documenting the `cause:` discriminator + the eviction-vs-DEL classification caveat (reliability conf 60 from round-1 review). Defer to the broader event-anchor convention rollup landing across the broadcast-error file family.

## BACKEND-HANDLE-BROADCAST-ERROR-HELPER (archived 2026-05-01) — round-5 clean ✓

Extract the duplicated `BroadcastTimeoutError` 504/502 discrimination pattern from 7 HTTP-surface catch sites into a shared `handleBroadcastError(res, err, opts)` helper in `backend/src/lib/broadcast-error.ts`. Round-1 (`0c95115`) shipped the helper + migrated all 7 sites; round-1 hold (P1+P2) closed an `accreditation.ts /verify` `deleteToken` ordering regression and a "canonical envelope" doc-claim conflict. Round-2 hold (`14d3d2e`) wrapped the deleteToken in try/catch + cleanup-failure log. Round-3 hold (`2eb2efb`) tightened the integration test to mutation-pin the (b) cleanup-failure log and (c) no-`ERR_HTTP_HEADERS_SENT` guard with `vi.spyOn(logger,'error')` + key-targeted spy + 403 state-not-consumed assertion + verifyHiveSignature-throw spec via hoisted `verifyHiveSignatureFailureToken` flag. Round-4 hold added `BroadcastTimeoutError` constructor-time guard against NaN/±Infinity/0/negative `timeoutMs` (`4d7dcd5`); round-4 architect review surfaced 5-reviewer convergence (correctness, agent-native, reliability, adversarial, security) on a P1 — the constructor RangeError throws synchronously inside the `setTimeout(() => reject(new BroadcastTimeoutError(...)))` callback BEFORE `reject()` runs, escapes as Node `uncaughtException`, crashes the worker. Round-5 hold-fix (`5258102`) moved the bound check to the WRAPPER ENTRY via new `assertFinitePositiveTimeoutMs(timeoutMs, fnName)` helper called as the first executable statement in `broadcastJsonWithTimeout` and `broadcastSendOperationsWithTimeout`. RangeError now propagates as a normal async-function Promise rejection that reaches the route catch → `handleBroadcastError`'s non-timeout branch → 502 BROADCAST_FAILED with structured `event:'broadcast_failed'` operator log. Constructor guard kept as belt-and-suspenders for future direct callers (test fixtures); never fires in production. 12 new specs (6 per wrapper) cover the input matrix (NaN, +Infinity, -Infinity, 0, negative, finite-positive control) plus `expect(broadcastSpy).not.toHaveBeenCalled()` to pin BEFORE-dhive placement. Round-5 architect review: 6-persona pass, all clean. Mutation kill verified across all defense classes.

## BACKEND-ORCID-BROADCAST-OUTCOME-DISCRIMINATION (archived 2026-05-01) — round-5 clean ✓

Discriminate "broadcast succeeded, post-broadcast write threw" from "broadcast threw" so the operator-alert pipeline routes the former to DB on-call (not broadcast on-call). Round-1 (`d8b9b75`) added `PostBroadcastWriteError` class + `currentStep` tracking idiom + `instanceof` discrimination order (PostBroadcastWriteError check fires BEFORE BroadcastTimeoutError so a wrapped timeout cause still emits 502 POST_BROADCAST_FAILED with `details.outcome:'confirmed'` + `tx_id` + `failed_step`). Per-step `postBroadcastMsgFn` for ORCID-shaped user-facing messages. Round-1 hold cycled through 9 items including the `'unknown'` failedStep removal, msg-fn-throws guard, third return-value `'post_broadcast'`, native `Error.cause` forwarding, sanitized fallback. Round-2 hold (`6044ebc`) closed 5 P2/P3 items including switch+`assertNever` exhaustiveness on per-step messages, `Extract<>` narrowing on handleLink's `currentStep`, structured `event:'post_broadcast_msg_fn_threw'` field. Round-3 hold (`5acbdf1`) closed the round-2 holds; round-3 architect surfaced 4-reviewer convergence on a P2 — `event:` literal placed BEFORE `...opts.logContext` was caller-overrideable. Round-4 hold-fix (`4d7dcd5`) repositioned `event:` AFTER the spread at both anchor sites + 2 mutation-kill specs. Round-4 architect surfaced 3-reviewer convergence on a P2 spread-after-literal asymmetry — protection applied to `event:` only; `err`/`cause`/`txId`/`failedStep` still BEFORE the spread, same caller-override mechanic. Plus a P3 sibling-anchor convention gap: 3 sibling logger sites (`broadcast timed out`, `broadcast failed on ambiguous-outcome path`, `broadcast failed`) carried no structured `event:` discriminator. Round-5 hold-fix (`a811a12`) extended spread-after-literal to all 4 source-of-truth fields at both anchor sites + added `event:'broadcast_timeout'` / `'broadcast_ambiguous'` / `'broadcast_failed'` (placed AFTER spread per the same convention) + the file's docblock now enumerates all 5 anchors with both stable suffix and structured discriminator. 5 new test specs (3 sibling-anchor pin specs via `objectContaining` + 2 spread-kill specs covering 7 source-of-truth fields). Round-5 architect review: 6-persona pass, all clean.

Architect-owned residual (deferred to separate sweep): `agents/docs/api-contracts/common.md` already documents POST_BROADCAST_FAILED row with discriminator (added during round-1 review pass); ARCHITECTURE.md §5 Operator Signals catalog gains the 5 `event:'broadcast_*'` + `'post_broadcast_*'` literals alongside the broader event-anchor sweep landing across the broadcast-error file family.

## BACKEND-ORCID-LOCK-TTL-EXTEND-ON-TIMEOUT (archived 2026-05-01) — round-4 clean ✓

A.1 implementation: extend ORCID binding lock TTL to `HAF_INDEXING_LAG_CEILING_SECONDS` (120s) on `BroadcastTimeoutError` to structurally close the duplicate-bind race. Round-1 (`81795fd`) added the skipRelease return-signal pattern (caller signals "don't release on finally"), `extendBindingLockOnTimeoutOrLog` helper called BEFORE response-write so a malicious caller terminating mid-write cannot escape before extend lands. Round-1 hold (`ddfff93`) closed 9 items including operator-anchor logging on all 4 helper branches (success, lock-missing, redis-absent, throw), `HAF_INDEXING_LAG_CEILING_SECONDS` source-of-truth aliasing for `ORCID_BINDING_CACHE_TTL`, helper extraction. Round-2 hold (`5acbdf1`) closed 5 items: ordering spec rewritten to pin `redis.expire` invocation order (pinning the contract layer, not the helper extraction), structured `event:` field literals pinned via `objectContaining` across all 4 helper branches, derivation-chain comment block on the constant, `skipRelease` decorative on lock-missing branch, call-shape assertion on `redis.expire`. Round-3 hold (`7387435`) renamed the four `event:'a1_extend_*'` literals to domain-rooted `event:'binding_lock_extend_*'` (aligns with sibling anchors `nonce_drift`, `redis_outage`, `lock_contention_held`, `post_broadcast_write_failed`) + decoupled test assertions from the bare `120` literal via `__test_seams.HAF_INDEXING_LAG_CEILING_SECONDS` export. Round-3 architect review surfaced 3-reviewer convergence (project-standards + maintainability + testing) on a P1 — two sibling cross-reference comments (`backend/src/lib/broadcast-error.ts:185` + `backend/src/routes/accreditation.ts:305`) still cited the dead `a1_extend_*` literal, breaking the rename's "survive task slug staleness" intent. Round-4 hold-fix (`a811a12`, bundled with `BACKEND-ORCID-BROADCAST-OUTCOME-DISCRIMINATION` round-5) refreshed both cross-references. Round-4 architect review: 6-persona pass, all clean.

Architect-owned residual (deferred): the implementer's [TODO Architect] from round-3 — refresh `agents/docs/tasks/pending/backend-a1-extend-lock-missing-event-discrimination.md` body to reference `binding_lock_extend_*` literals — was actioned during the cluster-A walk on that task. The convention-doc paragraph documenting Option A.1's `cause:` discriminator (per `chain-write-timeout-ambiguous-outcome-2026-04-22.md`) still pending the broader event-anchor convention rollup.

## BACKEND-CASCADE-FNS-RETHROW-PERMANENT-ERRORS (archived 2026-05-01) — round-2 clean ✓

Make `PostBroadcastWriteError` discrimination reachable on real cascade failures. Pre-fix the discrimination machinery was dead-defensive: `cacheOrcidBinding` / `updateAccountOrcid` / `seedAccreditationBonus` all swallowed async errors internally, so the per-step 502 `POST_BROADCAST_FAILED` envelope (`details.outcome:'confirmed'`, `failed_step`) never fired in production. Architect chose option B-narrow: rewire `updateAccountOrcid` + `seedAccreditationBonus` to re-throw on permanent / operator-actionable errors; leave `cacheOrcidBinding` swallowing (lazy-repopulate is the right behavior on cache write). Round-1 (`09e01e3`) added private discriminators `isPermanentDbError` (SQLSTATE classes `23*` integrity / `42*` syntax+access — re-throw; connection / serialization / pool-exhaustion — swallow) and `isPermanentSeedError` (`TypeError|SyntaxError|RangeError` — re-throw; everything else — swallow); null-Redis branch on the seed kept as silent return per the contract that ephemeral Redis health must not surface 502 to the user-visible accredit envelope. Operator anchor on the 4th log-suffix gained `event:'post_broadcast_write_failed'`. 9 new specs (5 updateAccountOrcid + 4 seedAccreditationBonus) covering permanent SQLSTATE / TypeError / transient swallow / null-pool-throws-immediately / null-Redis-silent-return. Round-2 hold-fix (`545ba77`) tightened the vacuous null-Redis spec from `if (!redis) {} ` (zero assertions under documented topology) to `vi.spyOn(redisModule, 'getRedis').mockReturnValueOnce(null)` with concrete silent-return + zero-Redis-call + zero-log-line assertions; file-header docblock added a 30-line "Mock carve-out" paragraph documenting CLAUDE.md "Running Tests" clauses (a)/(b)/(c). Round-2 architect review: clean 3-persona pass (testing, project-standards, correctness). Mutation kill verified — dropping `if (!redis) return` from `seedAccreditationBonus` would make `redis.set` throw on null receiver → `isPermanentSeedError` matches TypeError → re-thrown → spec flips red on `resolves.toBeUndefined()`. Architect-owned deferred items remain trackable: the api-contracts/orcid.md POST_BROADCAST_FAILED entry already documents the envelope and per-step recovery semantics; the ARCHITECTURE.md "Operator Signals" section gains `event:'post_broadcast_write_failed'` alongside the broader event-anchor sweep landing across the broadcast-error file family.

## ARCHITECT-COMMIT-ZONE-AUDIT-HOOK (archived 2026-04-30) — round-3 clean ✓

Add `.githooks/commit-msg` zone-audit hook + per-agent staging guidance + convention doc to backstop cross-agent commit-scope drift (motivating case: `3c2a2a1` swept architect-driven `tasks/review→pending` moves into a backend worker commit). Round-1 (`a8ffb41`) shipped the initial hook (slug-prefix discrimination + per-agent CLAUDE.md path-scoped staging + convention doc + README setup); architect /ce-code-review surfaced 18 findings centered on a P0 slug-guard ordering bug and a P1 missing test artifact. Round-2 (`38540a7`) reworked the hook with architect bypass for any-slug task files + global rename-detection pass blocking non-architect review→pending moves + 32-case test script + zone-map SSOT pivot (hook is runtime-authoritative, doc + Files-You-Own derived) + bare-prefix style mandate (rejects `fix(role):` wrappers) + `--no-verify` documentation + 5 root-meta paths added to architect zone (`.gitignore`, `.dockerignore`, `.env.example`, `deploy.sh`, `LICENSE`). Round-2 review surfaced one remaining P1: `-M50` rename-detection bypassed when content change drops similarity below 50% (file shows as A+D not R). Round-3 (`41c111e`) added a complementary deletion-detection pass for non-architect agents, plus tests for the low-similarity reproducer, Unmerged (U) filter, `[skip-zone-audit]` precedence, and `tasks/blocked/` variants (38 tests passing). Root CLAUDE.md rule #2 cross-references the hook as runtime SSOT. Round-3 architect correctness re-review zero findings.

## BACKEND-ORCID-DROPLOCKCONTENTION-RETRIABLE (archived 2026-04-30) — round-2 clean ✓

Drop the unreachable `retriable: true` discriminator from the same-tick lock-contention 409 in `withOrcidBindingLock`. Round-1 (`b1aec7e`) stripped `retriable`, `retry_after_seconds`, and the `Retry-After` header from the `'held'` branch's `sendError` call; deleted the now-unused `ORCID_BINDING_LOCK_RETRY_AFTER_SECONDS` constant; updated test assertions to the new wire shape (409 + `ORCID_ALREADY_LINKED`, no `retriable`). Round-2 hold-fix (`4eb07ed`) added a structured `logger.warn` carrying `event:'lock_contention_held'`, `orcidId`, `routeLabel` so dashboards can pivot on the anchor; rewrote handleAccredit and handleLink durable-binding 409 comments to lead with the wire-shape invariant ("All ORCID_ALREADY_LINKED 409 paths share the same wire shape: status 409, code ORCID_ALREADY_LINKED, no `retriable`, no `Retry-After`, no `retry_after_seconds`") + cross-reference to `agents/docs/api-contracts/orcid.md:185`. Round-2 architect re-review zero findings.

Companion UI work: `UI-ORCID-CALLBACK-RETRIABLE-MACHINERY-REMOVE` (archived same day) strips the dead frontend auto-retry machinery that the dropped discriminator activated.

Convention reinforced: `chain-write-timeout-ambiguous-outcome-2026-04-22.md` "Sibling principle — `retriable: true` is meaningless when state is single-use" section is the canonical rationale; this commit is its first code-side implementation.

---

## UI-ORCID-CALLBACK-RETRIABLE-MACHINERY-REMOVE (archived 2026-04-30) — clean ✓

Strip the now-unused auto-retry machinery from `frontend/src/pages/orcid-callback.js` after the backend stopped emitting `retriable: true` on the same-tick lock-contention 409 (companion `BACKEND-ORCID-DROPLOCKCONTENTION-RETRIABLE`). Removed: `_retryCount`, `MAX_RETRIES`, `retryCountdown`, `errorKind === 'alreadyLinkedRetriable'`, `_retryVerify`, `_tickRetryCountdown`, `_lastVerifyArgs`, the `orcid.alreadyLinkedRetriable` locale key from all 16 languages + `STUBS.md` cleanup. Net `-357/+24`, 5 unit tests deleted (machinery-specific) + 2 added (durable-rendering + retriable-shaped-envelope-treated-as-durable for mutation-killing). Test count `37/37` pass.

Architect re-review zero findings. One adjacent gap surfaced (frontend has no `POST_BROADCAST_FAILED` 502 handler — activated by cluster 2 task 4's cascade-fns rethrow round-1) and was filed as `ui-orcid-callback-post-broadcast-failed-handler.md` in pending/; orthogonal to this cleanup.

Convention reinforced: `chain-primitive-proxy-prefer-deletion-2026-04-28.md` — when the authoritative layer (single-use OAuth state) makes a downstream defense unreachable, decommission the consumer rather than retain it as scaffolding.

---

## BE-CLAIM-ACCOUNT-CHAIN-RECONCILE (archived 2026-04-30) — round-2 clean, superseded by R4 ✓

Reconcile DB `account_creation_tokens` count with on-chain `pending_claimed_accounts` after `BroadcastTimeoutError` during `claim_account` batch broadcast. Round-1 (`ef56eab`) added `reconcileClaimTimeout` capturing pre/post counter delta and INSERT-reconcile path. Round-1 architect hold-block (`3312e2c`) flagged 4 items including log-severity tweaks, `reconcile_outcome` enum field on the seven reconcile log lines, and inline rationale comment for the `hiveOnboardAccount` choice. Round-2 hold-fix (`2622742`) landed all 4 items: 8/11 → 11/11 tests passing.

**Subsequently superseded by `BACKEND-ACCOUNT-CREATION-TOKENS-DROP` (commit `72978a0`, archived separately).** That round-2 review surfaced that `account_creation_tokens` was a soft proxy (reservation mutex, not a ledger) defending DB-row contention rather than chain double-spend, and chain consensus already serializes `create_claimed_account`. Per the new `chain-primitive-proxy-prefer-deletion-2026-04-28.md` convention, the table was dropped entirely; this task's reconcile machinery was removed by R4. This task archives on its own merits as a record of the intermediate state — the round-2 reconcile work was correct on the original premise; the premise itself proved unnecessary at audit time.

Convention prefigured: `chain-primitive-proxy-prefer-deletion-2026-04-28.md` was authored as direct aftermath of this task's premise re-evaluation.

---

## BACKEND-ARGON2-ABORT-OBSERVABILITY (archived 2026-04-29) — round-2 clean ✓

Periodic `argon2_abort_summary` log emission (`backend/src/lib/argon2-semaphore.ts`) for operator visibility into client-disconnect aborts during argon2 ops. Round-1 added the counter + reporter (commit `5d33f24`); round-1 hold-fix (`aeef5f2`) deduped the slot-grant-race double-increment via per-request `incrementAbortOnce` + 5 reporter unit tests. Round-2 hold-fix (`647a115`) closed three accuracy gaps: (1) gated parked-waiter `onAbort` counter on `waiters.indexOf(w) >= 0` so drain-race + slot-release-race no longer inflate the counter; (2) swapped function-entry guards so `shuttingDown` precedes `signal?.aborted` (pre-aborted-during-drain reclassifies as shutdown, not abort); (3) added `intervalMs` field to log payload so dashboards can express rates without hardcoding 60_000.

Round-2 architect re-review surfaced 3 ARCHITECTURE.md Section 5 gaps: missing `intervalMs` field row, missing round-2 accuracy-correction paragraph, missing "no abort traffic during SIGTERM rolling restart is expected" semantics. All 3 architect-side doc updates landed in commit `dcaab4a` during the re-review. Code in `647a115` was sound — no backend hold needed.

Convention docs governing: `tests-must-fail-on-mutation-of-code-under-test-2026-04-22.md`, `vitest-fake-timers-module-private-state-isolation-2026-04-29.md`, `mock-guard-assertion-must-verify-call-shape-2026-04-21.md`. The asymmetric counter rule (listener increments iff it owns propagation) is now documented in ARCHITECTURE.md Section 5.

---

## BACKEND-ARGON2-ERROR-HANDLER-EXTRACT (archived 2026-04-29) — round-4 clean ✓ (post orphan-replay)

Centralized argon2-error → HTTP translation across 4 routes (auth, custody, settings, signup-verify) into `backend/src/lib/argon2-error-handler.ts` with `handleArgonError`, `ARGON_HANDLED` / `ARGON_UNHANDLED` constants, and `isArgonSemaphoreError` type guard. Eliminated the 3-way inline `instanceof` chain at 9+ catch sites; collapsed `burnSentinel`'s 3-class re-throw into one `instanceof ArgonSemaphoreError`. Rounds 1-2 landed the helper + base class + `requestAbortSignal` extraction + `retryAfterSec` perimeter validation. Round-3 (`ada6814`) migrated the 4 remaining raw `instanceof ArgonSemaphoreError` sites to use the type guard. Round-4 (doc-only items in `647a115`) updated JSDoc on the base class + fallthrough comment in the helper to reference `isArgonSemaphoreError` consistently.

**Orphan-replay note:** the round-3 migration commit `ada6814` and its merge `9a811b9` lived only on `worktree-agent-a06fcd6a935d47929` and never reached main. Round-4's doc-only fix at `647a115` was authored under the false premise that round-3 had landed; on main HEAD it produced doc-vs-code drift (docs claimed `isArgonSemaphoreError`, code still used raw `instanceof`). Architect re-review caught the divergence and replayed `ada6814` onto main as `718b7ed`, which restored coherence between the round-4 docs and the production code. After the replay, all 4 raw `instanceof` sites use the type guard; `grep -n "instanceof ArgonSemaphoreError" backend/src/` shows only the type-guard's own implementation body in `argon2-semaphore.ts:114`.

Convention docs: `wrapping-primitive-exhaustive-call-site-audit-2026-04-22.md`, `route-level-error-class-coverage-after-helper-extraction-2026-04-29.md` (the latter authored to anchor this cluster's lessons; updated in commit `dcaab4a` to reflect the 2-arg `assertArgon2AbortIsSilent` shape).

---

## BACKEND-ARGON2-TEST-MOCKS-MIGRATE-PRE-EXISTING (archived 2026-04-29) — clean ✓ (post orphan-replay)

Migrated two pre-existing argon2 route tests (`auth-reset-request-shutdown.test.ts` + `auth-signup-dup-saturated.test.ts`) onto the shared `buildArgon2RouteMockKit` helper from `tests/support/argon2-error-mocks.ts`. Removes the in-file `vi.hoisted` synthetic class declarations; both files now bind the real production `ArgonSemaphoreError` hierarchy via `vi.importActual`. `auth-signup-dup-saturated.test.ts` also imports `ARGON_REASON_QUEUE_FULL` / `ARGON_REASON_SHUTDOWN_DRAIN` constants from `argon2-error-handler.ts` instead of hardcoding the literals. Implementer also added abort-class silent-return coverage on the `/reset-request` unknown-email branch (round-2 hold-block item from `backend-argon2-error-routes-test-coverage.md`) and on both `/signup` dup-burn sites (auth.ts:401 + auth.ts:416).

**Orphan-replay note:** the migration commit `c4d988e` lived only on `worktree-agent-a54a057f80a180193` and never reached main. Architect re-review replayed it as `cfd5a73`, which produced 3 test failures because `c4d988e` was authored when `assertArgon2AbortIsSilent` was 1-arg; current main HEAD has the 2-arg signature from `5cb0fbc` (round-3 P2 hold-fix on `backend-argon2-error-routes-test-coverage`). Architect post-replay fix at `002fec1` updated the 3 call sites to pass `mockRunWithArgon2Slot` per the predicted [TODO Architect] coordination note. After the fix, 98/98 argon2-related tests pass.

Convention doc: `route-level-error-class-coverage-after-helper-extraction-2026-04-29.md` covers the cluster pattern. The helper-extraction shape is the canonical example for "every route × concrete error subclass cell needs route-level coverage; helper extraction does not absolve route-level coverage."

---

## UI-PASSWORD-POLICY-HARMONIZE (archived 2026-04-29) — round-1 clean ✓

UI side of cross-stack password-policy harmonization. Adds a `Keep in sync with backend/src/lib/password-policy.ts` pointer comment to `frontend/src/password-policy.js`, citing the backend CI drift-check test as the gate. Lands alongside the backend half (`backend-password-policy-harmonize`, currently held in pending/ on round-1 for two test-coverage hardening items). UI half passed `/ce-code-review` (6 personas: correctness, testing, maintainability, project-standards, agent-native, learnings) with zero findings on the comment-only diff. Implementer commit: `0b73a53`.

The pair (BE drift-check test + FE pointer comment) implements the agreed cross-stack harmonization shape: two independent helper implementations, one CI gate that loads both and asserts behavioral agreement on a labelled test-vector grid, plus reciprocal pointer comments so a future unilateral edit has a visible nudge to update the other side. The drift-check test (`backend/tests/lib/password-policy-drift.test.ts`) is the audit surface; the pointer comments are the editor-visible nudges.

---

## BACKEND-ORCID-BROADCAST-TIMEOUT-OUTCOME-HANDLING (archived 2026-04-29) — round-4 clean ✓

Architect decision Option A.2 (504 + retriable:false + verify_before_retry envelope) for ORCID-binding broadcast paths whose 30s timer fires while outcome is genuinely uncertain. Closes the ambiguous-outcome window the prior round-3 sweep left open: when chain-write timer fires, the broadcast may or may not have landed; client must verify before retry to avoid duplicate-bind.

Implementation landed in commit `0a5c890` (round-2 hold-fix) and `a0f121d` (round-3 hold-fix) on `backend/src/lib/broadcast-error.ts` and `backend/src/routes/orcid.ts`. Round-3 added a mutation-kill spec for the lockState='unavailable' non-timeout broadcast error path (rejects broadcastJsonMock with non-timeout `Error('synthetic ...')`, asserts 504 ambiguous-outcome envelope with no `details.timeout_ms`, `/uncertain/i` message, ambiguous-outcome operator-alert log suffix, all via the existing `describe.each([accredit, link])` matrix). Item #2 added `errorSpy` named-local capture in `tests/lib/broadcast-error.test.ts` to pin the operator-alert log suffix at unit-layer. Item #3 swapped `MockBroadcastTimeoutError` cause to a generic `Error('synthetic db cascade failure')` in the post-broadcast seam test for semantic clarity.

Architect-applied in-place fixes during round-3: 4th log-suffix added to docblock (`PostBroadcastWriteError` discrimination path), stale "forceAmbiguousOutcome above" comment replaced, `HandleBroadcastErrorAmbiguousOpts` re-derived via `Extract<>`-narrowed type for mechanical sync with `AmbiguousOutcomeFields`, convention-doc round-2 example block rewritten to reflect the discriminated-union shape.

Round-4 review (all 6 commits since round-3 architect review): correctness + testing + adversarial all confirm mutation-kill rigor lands. P3 polish items (hardcoded line numbers in test comments, redundant `not.toHaveProperty` after exact-match `toEqual`, integration-layer log-filter substring vs unit-layer exact match) all dismissed as below action threshold.

Convention docs: `agents/docs/solutions/conventions/chain-write-timeout-ambiguous-outcome-2026-04-22.md`, `inner-catch-shadows-outer-catch-in-route-tests-2026-04-28.md`, `correlated-options-discriminated-union-2026-04-28.md`, `tests-must-fail-on-mutation-of-code-under-test-2026-04-22.md` all directly govern the work.

Full history: see commits `0a5c890`, `df264d7`, `27befcf`, `0d0c156`, `d8b9b75`, `a0f121d` and the task file body via `git show HEAD~N:agents/docs/tasks/review/backend-orcid-broadcast-timeout-outcome-handling.md`.

---

## BACKEND-ORCID-ACQUIRED-BRANCH-THROW-GUARD (archived 2026-04-29) — round-2 clean ✓

Filed by architect during BE-ORCID-BROADCAST-TIMEOUT-OUTCOME-HANDLING round-2 re-review (finding #2). The lock-acquired branch of `withOrcidBindingLock` previously had no outer try/catch — sync throws (e.g. `PrivateKey.fromString` on malformed admin key) escaped to the outer `/callback` catch and emitted 500 INTERNAL_ERROR with state token consumed (a hard-block class). Implementation in commit `0d0c156` added the symmetric outer try/catch routing through `handleBroadcastErrorAmbiguous`, producing the 504 ambiguous-outcome envelope. The post-broadcast cascade (`updateAccountOrcid`) is the live integration coverage; pre-broadcast SYNC throws on the acquired branch were filed separately as `backend-pevo-admin-key-startup-validation.md` (a startup-time validation guard makes the production trigger unreachable).

Round-1 architect review held one P3 item (matcher tightening from `toBeGreaterThanOrEqual(1)` to `toBe(1)` at `tests/routes/orcid.test.ts:1340` and `:1441` for the operator-alert log assertions). Round-2 hold-fix in commit `acae57e` landed exactly the 2-line tightening. Mutation-kill verified: a regression that double-emits the operator-alert log (e.g. a misplaced retry that re-throws from the catch block) now flips green-to-red, matching the stated intent in the surrounding spec comments. Lines 2008/2132 (unavailable branch + state-replay scope) deliberately left at `>=1` per architect scope.

Architect-applied in-place fixes during round-1: JSDoc 'acquired' bullet rewrite, NB comment update post-`d8b9b75` discrimination, convention-doc symmetric-branch paragraph addition, `agents/docs/api-contracts/orcid.md` 504 BROADCAST_TIMEOUT entry rewritten to enumerate three trigger paths with `details.timeout_ms` presence rule, `agents/docs/api-contracts/common.md` POST_BROADCAST_FAILED row added.

Full history: see commits `0d0c156`, `acae57e`, `53da6c9` and the task file body via git.

---

## UI-ORCID-CALLBACK-RETRIABLE-BRANCH (archived 2026-04-29) — round-3 clean ✓ (machinery now being removed)

Frontend consumer of the lock-contention 409 retriable surface. Round-2 hold-fix bundle (commit `f996d37`) landed 5 items: upper-bound clamp on `Retry-After` (`Math.max(1, Math.min(300, err.retryAfterSeconds ?? 10))` defending against backend emitting `Retry-After: 99999` which would pin the user for ~28 hours), stale `_retryCount` comment fragment dropped, "single self-triggered retry" prose reworded to "up to MAX_RETRIES self-triggered retries" at two sites, redundant `comp._mounted = true` deleted from a timer-based test (createTimerGuard already initializes it), `expect(comp._retryCount).toBe(0)` invariant added to the undefined-retryAfter test.

Special context: a parallel architect task `ARCHITECT-ORCID-STATE-CONSUMPTION-VS-RETRIABLE-409` (archived 2026-04-29 — Option B chosen) determined the retriable-branch contract is **unreachable by design** — backend consumes the OAuth state token at `orcid.ts:299` BEFORE dispatching to the lock-contention branch, so the SPA's `_retryVerify` always lands on 400 BAD_REQUEST first. The follow-on task `ui-orcid-callback-retriable-machinery-remove.md` strips the `_retryCount`/`MAX_RETRIES`/countdown machinery this round just polished. Per the round-2 architect note "independent and does not block this archive", the polish-then-remove order is acceptable.

Round-3 review: correctness + testing + julik-frontend-races + adversarial all confirm the 5 items land. One vacuous-`_retryCount=0`-assertion finding dismissed as "polish on dead-code-pending" — the surfaces are being torn out anyway by the machinery-removal task.

Full history: see commits `fbe8578`, `f996d37`, `9b2f774` and the task file body via git.

---

## ARCHITECT-ORCID-STATE-CONSUMPTION-VS-RETRIABLE-409 (archived 2026-04-29) — Option B chosen ✓

# ARCHITECT-ORCID-STATE-CONSUMPTION-VS-RETRIABLE-409 — Resolve the unreachable-by-design retriable-409 contract

**Owner:** architect (product decision needed before backend or UI implementation)
**Created:** 2026-04-29 (architect, surfaced by adversarial reviewer adv-1 during round-2 review of `UI-ORCID-CALLBACK-RETRIABLE-BRANCH` commit `fbe8578`)
**Priority:** P1
**Source:** `agents/docs/tasks/pending/ui-orcid-callback-retriable-branch.md` round-2 review (architect 2026-04-29) — adversarial conf 85.

## Problem

The `ORCID_ALREADY_LINKED` 409 envelope's `retriable: true` discriminator on the same-tick lock-contention branch is **unreachable by design** — backend consumes the OAuth state token before the contention is detectable, and the frontend's retry path then fails with 400 BAD_REQUEST instead of the retried operation succeeding.

Concrete trace:

1. `POST /api/orcid/callback` with `{code, state}`.
2. `backend/src/routes/orcid.ts:282-302` — backend reads `stateKey`, validates auth (for AUTHENTICATED_MODES), then **deletes `stateKey` at line 299** (`redis.del(stateKey)` / `orcidStates.delete(state)`). Comment at line 297 is explicit: "Auth passed (or mode is public). Consume state now so it can't be replayed."
3. `:335` switch routes to `handleAccredit` / `handleLink`.
4. Inside the handler, `withOrcidBindingLock` runs and may emit the 409 ORCID_ALREADY_LINKED with `retriable: true` + `Retry-After: 10` from its `'held'` branch.
5. Frontend (`frontend/src/pages/orcid-callback.js:288` `_retryVerify`) replays the same `{code, state}` after the countdown.
6. Backend `:282` state-check fires FIRST: `if (!storedMode) { sendError(res, 400, 'BAD_REQUEST', 'Invalid or expired state parameter'); return; }`. Returns 400, not the retried-and-succeeding operation.
7. Frontend's catch block hits the generic-fallback branch (no special handling for 400 BAD_REQUEST after a retriable retry) and renders `orcid.verificationFailed`.

The retriable-discriminator infrastructure is structurally correct on each side (backend signals retriable+Retry-After; frontend consumes and counts down then retries) but the composition fails: the user never reaches the lock-contended retry that the contract promises. `MAX_RETRIES=1` (the round-1 hold-fix safety cap on this task) just bounds how many times the wrong outcome repeats.

This is **pre-existing** — the issue dates to whenever backend's lock-contention 409 first signaled `retriable: true`. UI-ORCID-CALLBACK-RETRIABLE-BRANCH (consumer side) shipped over an already-broken contract.

## Why this matters

- **The retriable-discriminator UX is silently lying to users.** A user hits the same-tick contention, sees a "retrying in 10 seconds" countdown, watches it fire, then sees a generic verification-failed message with no actionable signal. They restart OAuth and (most likely) succeed because the contention is transient. The countdown was theatre.
- **Operator alerts on retriable-409 are undercounted.** The frontend's 400 BAD_REQUEST after retry is indistinguishable from a normal state-token-replay attempt; operators reviewing 400 rates can't separate "user retried our retriable promise" from "actual replay attack."
- **Silent contract drift erodes trust in the retriable discriminator going forward.** If we ship A.1's lock-TTL-extension envelope on `BroadcastTimeoutError` (separate task, already shipped via 81795fd) and operators or future contributors look at the existing retriable-409 as a reference, they'll model new retriable contracts on a broken precedent.

## Three product directions (architect to decide)

### Option A — Backend: defer state consumption until after lock acquisition

Move the `redis.del(stateKey)` from `:299` (pre-dispatch) to inside the handler, AFTER `withOrcidBindingLock` returns successfully (or signals a non-retriable failure). The retriable-409 then preserves the state token, the frontend retry succeeds.

**Cost:** opens a state-replay attack window during the lock-acquisition + broadcast window (3-30s). An attacker who steals the state token between OAuth redirect and our consume-now point can race a parallel `/callback` request, both hitting different `handleAccredit` invocations against the same state. Today this is closed by the eager `redis.del`; deferring opens it.

**Mitigation:** the lock itself is keyed on `orcid_id`, so two concurrent `/callback`s with the same state would race for the same lock — one wins, the other gets `'held'` 409 retriable. The retry-with-same-state would then succeed (lock free) for whichever client retries first. The "attack" reduces to "attacker can force the legitimate user into a single retriable-409 round-trip" — UX nuisance, not auth compromise. The state token is still single-use *eventually* (consumed after the successful broadcast).

This is the cleanest architectural fix.

### Option B — Backend: drop `retriable: true` from lock-contention 409

Keep the eager state-consume. Acknowledge that the same-tick contention case is genuinely terminal from the user's perspective (state is gone; restart OAuth). Drop the `retriable: true` and `retry_after_seconds` from this specific 409 emission. Frontend continues to receive a `ORCID_ALREADY_LINKED` 409 but treats it as durable.

**Cost:** the user retry flow on contention is "restart full OAuth" instead of "wait 10s." Acceptable at PEvO's scale (contention is rare); same-tick contention typically clears before the user restarts.

This is the simplest fix. Honest to the actual contract.

### Option C — Frontend: treat `retriable: true` as informational

Keep both sides. Frontend renders the countdown but does NOT auto-retry — instead shows "another request is in progress; try again in N seconds" and lets the user manually click retry once N passes. A manual retry restarts OAuth (new state token) rather than replaying the consumed one.

**Cost:** kills the value-add of UI-ORCID-CALLBACK-RETRIABLE-BRANCH (auto-retry was the point). Defeats the round-1 hold's `_retryCount` + `MAX_RETRIES` machinery (no auto-retry to cap).

Defensible only if Option A's replay-window cost is judged unacceptable AND Option B's "drop the discriminator" feels like a contract regression we don't want to advertise.

## Recommendation (architect, leaning)

**Option B.** Same-tick lock contention is a rare edge case at PEvO's scale (tens of signups/day). The retriable-discriminator's value is on the lock-extended-on-`BroadcastTimeoutError` path (Option A.1, already shipped via `81795fd`) — and that path doesn't have the state-consumption-order problem because the timeout fires *after* the state was consumed by a successful broadcast acceptance. Dropping the same-tick `retriable: true` honestly aligns the contract with reality and removes the broken-by-design surface entirely.

If chosen, the follow-on UI work is to remove the now-unused `_retryCount` / `MAX_RETRIES` / countdown machinery from `orcid-callback.js` (or repurpose it for the BroadcastTimeoutError envelope, which DOES have a working retriable contract on the backend side).

## Decision (architect, 2026-04-29)

**Option B chosen.** Drop the `retriable: true` discriminator from the same-tick lock-contention 409. The case is genuinely terminal from the user's perspective (state is consumed before lock acquisition can run, so any same-`{code, state}` retry returns 400 BAD_REQUEST) — the discriminator was promising a retry path that never reached the handler.

Rationale:

- Same-tick contention is rare at PEvO scale (tens of signups/day).
- The retriable-discriminator's actual value is on the lock-TTL-extended `BroadcastTimeoutError` path (already shipped via `81795fd`) — and that path is correctly `retriable: false` with `verify_before_retry: true`. State has been consumed by the time the timer fires, so retry isn't expected.
- Option B aligns the contract with reality and removes the broken-by-design surface entirely. Option A's deferred-state-consume would have opened a (narrow, mitigated) replay window for an edge case that's already rare; the cost-benefit doesn't justify the change.

Follow-on tasks filed:

- `backend-orcid-droplockcontention-retriable.md` — strip `retriable: true` + `retry_after_seconds` + `Retry-After` from the `'held'`-branch 409 in `withOrcidBindingLock`.
- `ui-orcid-callback-retriable-machinery-remove.md` — remove `_retryCount`, `MAX_RETRIES`, `retryCountdown`, `_retryVerify`, `_lastVerifyArgs`, the `alreadyLinkedRetriable` template branch, and the `orcid.alreadyLinkedRetriable` locale key.

Doc updates landed alongside this decision:

- `agents/docs/api-contracts/orcid.md` — same-tick contention 409 documented as non-retriable; convention paragraph updated; degraded-mode-success tail-sentence reference to retriable-409 retry agents removed.
- `agents/docs/solutions/conventions/chain-write-timeout-ambiguous-outcome-2026-04-22.md` — appended a "Sibling principle: `retriable: true` is meaningless when state is single-use" section with audit checklist; tags + last_updated bumped.

## Acceptance

A separate `backend-orcid-...` task implements the chosen option once architect decides. This task closes when the decision is recorded in this file (or the file moves to archive) and the implementation task is filed.

## Coordination

- Pairs with `tasks-archive.md` BACKEND-ORCID-LOCK-TTL-EXTEND-ON-TIMEOUT entry — that task's `retriable: false` 504 envelope on `BroadcastTimeoutError` (Option A.2 in the chain-write convention doc) is the OTHER retriable-vs-not signal in this surface, and IS correctly shaped (state has been consumed by the time the timer fires; the user is told to verify before retry, not auto-retry). The current task only resolves the same-tick contention path, not the timer-fire path.
- Convention doc `agents/docs/solutions/conventions/chain-write-timeout-ambiguous-outcome-2026-04-22.md` — would benefit from a paragraph on "retriable=true is meaningless if state is single-use" once a decision is recorded.

## Source

- `agents/docs/tasks/pending/ui-orcid-callback-retriable-branch.md` round-2 architect review (2026-04-29) — adversarial finding adv-1 (P1 conf 85, "composition failure: state token consumed before retriable 409 emits").
- `backend/src/routes/orcid.ts:282-302` — state validate + consume.
- `backend/src/routes/orcid.ts:1027-1036` — lock-contention 409 with `retriable: true`.
- `frontend/src/pages/orcid-callback.js:288` — `_retryVerify`.
- `agents/docs/api-contracts/orcid.md:188` — same-tick lock-contention contract description.

## BE-503-REASON-DISCRIMINATION (archived 2026-04-29) — Round-1 clean ✓

# BE-503-REASON-DISCRIMINATION — Add `details.reason` to argon2-503 envelopes so canary monitors can branch on shutdown vs queue-saturation

**Owner:** backend
**Created:** 2026-04-28 (surfaced by cluster A `/ce-code-review` of `backend-argon2-semaphore-shutdown-drain.md`, agent-native persona reframed as ops observability per root `CLAUDE.md` "API Consumer Surface")
