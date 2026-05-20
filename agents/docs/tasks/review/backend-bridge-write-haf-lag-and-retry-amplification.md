# BACKEND-BRIDGE-WRITE-HAF-LAG-AND-RETRY-AMPLIFICATION — Concurrent /register HAF-lag race + /update version-counter race

**Owner:** Backend Agent
**Created:** 2026-05-04 (architect, surfaced by α `/ce-code-review` cluster B, pre-existing patterns the migration touched)
**Priority:** P2 (reliability)

## Why now

α's `/ce-code-review` surfaced two race-condition patterns in `bridge.ts` that the broadcast-error migration didn't introduce but did touch:

### 1. /register duplicate-check + broadcast HAF-lag race (R-1, conf 85)

`bridge.ts:191-202` `checkExistingBridge` reads HAF SQL then the broadcast fires. HAF indexing lags chain by ~1-3 seconds (more on node restarts/forks). Two concurrent `/register` requests for the same identifier can both pass the duplicate check, both broadcast, and both land on chain. There is no DB reservation, no Redis advisory lock, and no Hive-level duplicate guard at the application layer before the broadcast.

Mitigations today:
- The bridge generates a deterministic permlink per identifier — chain rejects the SECOND broadcast as `tx_duplicate` (502, OK) IF the permlink is fully deterministic.
- `checkExistingBridge` does swallow HAF errors and return `{exists: false}` — a sustained HAF outage means duplicate check passes on every call (pre-existing R-2 in α's review, also flagged).

Risk: if a future change adds any non-determinism to the permlink (timestamp, version-from-stale-read, environment-derived prefix), TWO distinct posts land. The race window is worst precisely when the node is slow.

### 2. /update version-counter computed in-memory under timeout (R-2, conf 80)

`bridge.ts:344-401` `newVersion = previousVersion + 1` is computed from the HAF-fetched existing post and baked into `json_metadata` before broadcast. On a 504 timeout, if the caller retries without verifying HAF first, the next `/update` reads the same `previousVersion` (HAF lag), computes the same `newVersion`, and broadcasts a second edit with the same version number. Both ops land; HAF will have two `version=N` entries.

Rate limiter is per-IP, not per-permlink. A well-behaved client that respects `verify_before_retry:true` avoids this; an automated/broken client does not.

## Goal

Close both races at the application layer rather than relying on Hive-side dedup. Provide deterministic guarantees regardless of HAF lag or client behavior.

## Acceptance

### 1. /register duplicate-check race

Pick ONE of:

**(a) Redis advisory lock keyed on the deterministic permlink** — backend acquires a short-TTL Redis lock (`SET ${appTag}:bridge_register_lock:${permlink} ${requestId} NX EX 10`) before `checkExistingBridge`. Lock held until broadcast resolves (success / 502 / 504). Concurrent /register attempts on same permlink wait or 409.

**(b) Per-permlink in-process semaphore** — module-level `Map<permlink, Promise<result>>`. First request kicks off; concurrent requests await the same in-flight promise.

**(c) Database UNIQUE constraint on `(source_doi, source_type)` in a `bridge_papers_pending` table** — first INSERT wins; second gets a constraint violation → 409. Schema migration; heavyweight.

Recommended: (a). Lock at the deterministic-permlink layer; survives multi-process backend deploys (Redis is shared); short TTL bounds blast radius if a request hangs.

Add canary tests: fire 2 concurrent `/register` for same identifier with mocked broadcast (resolves slowly), assert exactly ONE broadcast fires + the second returns 409 LOCK_HELD (or waits for the first's outcome — implementer's choice).

### 2. /update version-counter race

The same lock pattern applied per-(author, permlink): lock acquisition before HAF-read of `previousVersion`, lock held until broadcast resolves. Concurrent `/update` for the same paper serializes → no double-incremented `newVersion`.

Alternative: store `version_counter` in Redis per-paper, atomic INCR. Trade-off: divergence from HAF as source-of-truth. Less recommended — keep HAF as the version-truth source; lock the read+broadcast cycle.

Add canary tests: fire 2 concurrent `/update` for same paper, assert exactly ONE broadcast fires with `version: N+1`; the second gets 409 LOCK_HELD or serializes to `version: N+2`.

### 3. HAF-outage failure mode for `checkExistingBridge`

Pre-existing pattern: HAF errors swallowed → `{exists: false}` → duplicate check passes on every call during a HAF outage. Architect-owned design decision: should this remain fail-soft (allow registration during HAF outage; rely on chain-side dedup) or become fail-closed (refuse registration during HAF outage; preserves invariant but blocks legitimate use)?

Recommended: fail-closed with a 503 SERVICE_UNAVAILABLE + `{retriable: true}` + a structured log alert. Bridge writes are infrequent; a HAF outage is operationally significant; failing closed surfaces it. The current fail-soft is a quiet failure mode.

### 4. Convention update

Add a new entry under `agents/docs/solutions/conventions/`: `read-then-write-races-on-haf-backed-routes-2026-05-XX.md` documenting:
- The HAF-lag race class.
- The Redis advisory lock pattern as the canonical fix.
- Cross-reference bridge `/register` + `/update` as the two surfaces this convention applies to.
- Survey other read-then-write surfaces (papers `/edit`, claims, etc.) for the same class.

Architect-owned; backend leaves [TODO Architect] markers.

## Out of scope

- Refactoring HAF query layer to add stronger consistency guarantees (HAF is an external service; PEvO doesn't control it).
- Generic distributed-locking framework. Per-route `SET NX EX` with documented key shapes is sufficient.
- Cross-process work-queue / outbox pattern. Per-request lock is the right granularity.

## Coordination

- **α's hold-block:** α's hold-fix items don't depend on this task. Once α archives, this task is independent.
- **`backend-broadcast-idempotency-cluster-followup.md`:** related but separate. That task ensures retry-after-504 doesn't double-broadcast (idempotency_key + HAF dedup BEFORE broadcast). This task ensures concurrent-requests don't double-broadcast (lock at the read-then-write boundary). Together they close the full retry-amplification class on bridge writes.

## Source

- α `/ce-code-review` (cluster B, 2026-05-04): reliability R-1 + R-2 (P2). Filed in α's "Items dismissed" → "Pre-existing patterns; filed as separate task".

## Cross-references

- `agents/docs/solutions/conventions/chain-write-timeout-ambiguous-outcome-2026-04-22.md` — sibling convention on broadcast retry behavior.
- `backend-broadcast-idempotency-cluster-followup.md` — companion task for retry-after-504 idempotency.

---

## Backend re-review signal (2026-05-05, working tree)

All four acceptance items landed. Lock pattern mirrors `withOrcidBindingLock` (per-acquisition nonce + Lua CAS release).

### Item 1 — `/register` per-permlink SETNX lock

- `backend/src/routes/bridge.ts:48-50` — `BRIDGE_LOCK_TTL_SECONDS`, `BRIDGE_LOCK_NONCE_RE`, `BRIDGE_RELEASE_LOCK_LUA` constants.
- `backend/src/routes/bridge.ts:52-54` — `bridgeRegisterLockKey(permlink)` helper.
- `backend/src/routes/bridge.ts:71-108` — `acquireBridgeLock` / `releaseBridgeLock` wrappers.
- `backend/src/routes/bridge.ts:322-334` — `/register` lock acquisition before `checkExistingBridge`; `held` → 409 `DUPLICATE` `{retriable: true}`.
- `backend/src/routes/bridge.ts:430-434` — try/finally release under Lua CAS on the per-acquisition nonce.

### Item 2 — `/update` per-(author, permlink) SETNX lock

- `backend/src/routes/bridge.ts:56-58` — `bridgeUpdateLockKey(author, permlink)` helper.
- `backend/src/routes/bridge.ts:463-475` — `/update` lock acquisition before HAF-read of `previousVersion`; `held` → 409 retriable.
- `backend/src/routes/bridge.ts:580-584` — try/finally release.

### Item 3 — Fail-closed on HAF query error in `checkExistingBridge`

- `backend/src/routes/bridge.ts:157-177` — `BridgeCheckResult` discriminated union (`'ok'` vs `'haf_unavailable'`).
- `backend/src/routes/bridge.ts:228-237` — HAF-error catch returns `{status: 'haf_unavailable'}` and emits structured warn log (`event: 'bridge.register.haf_check_failed'`, `route: 'bridge.register'`).
- `backend/src/routes/bridge.ts:262-269` — `/check` (read-only) maps `haf_unavailable` back to `{exists: false}` to preserve fail-open on the probe path.
- `backend/src/routes/bridge.ts:340-345` — `/register` (write path) maps `haf_unavailable` to 503 `SERVICE_UNAVAILABLE` `{retriable: true}` per acceptance.

### Item 4 — [TODO Architect] marker

See "TODO Architect" section below.

### Tests

`backend/tests/routes/bridge-haf-lag-locks.test.ts` (new file, 3 specs):
- `/register` two concurrent same-identifier requests → exactly ONE broadcast, second returns 409 retriable.
- `/update` two concurrent same-paper requests → exactly ONE broadcast with `version: 2`, second returns 409 retriable.
- `/register` HAF query throws → 503 `SERVICE_UNAVAILABLE` with `retriable: true` + structured warn log.

Existing `bridge.test.ts` (13) and `bridge-paper-author-gate.test.ts` (14) green.

### Redis key shapes (with mandatory `${config.appTag}` prefix)

- `${config.appTag}:bridge_register_lock:${permlink}`
- `${config.appTag}:bridge_update_lock:${author}:${permlink}`

### Lock-release strategy

Per-acquisition 16-byte hex nonce stored as the lock value. Release via Lua CAS: `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end`. The CAS ensures a stale lock from a different request cannot be released by accident if our broadcast outlasts the 35s TTL and a sibling re-acquires under a new nonce. Mirrors `RELEASE_LOCK_LUA` in `routes/orcid.ts`.

### Integration note

Worker B's worktree was based on stale commit `2616cc1` (predating `23bdae9`'s `getCachedBridgePostingKey()` boot-cache). Cherry-pick onto current main resolved by adopting worker's full lock-wrapped flow and then re-applying main's boot-cache pattern at the two key-fetch sites: `import { getCachedBridgePostingKey } from '../startup-checks.js'` (replaces worker's `import { PrivateKey } from '@hiveio/dhive'`), and both `const key = ...` lines now read `const key = getCachedBridgePostingKey()!;` (with the `assertBridgeKeyConfigured`-above invariant comment). The `assertBridgeKeyConfigured(res)` guards at the two route entry points (worker's lines 301 and 455 → integrated lines 305 and 459 area) remain in place.

### Note on lock-extension on `BroadcastTimeoutError`

The bridge implementation does not extend the lock TTL on `BroadcastTimeoutError` (unlike orcid's A.1 protection). If duplicate-broadcast-after-timeout becomes a measured problem on the bridge surface, that extension lands as a follow-up. Operator visibility today is the 504 `BROADCAST_TIMEOUT` envelope's `verify_before_retry` hint plus the standard broadcast-timeout log emission.

## [TODO Architect] — new convention doc needed

Suggested filename: `agents/docs/solutions/conventions/read-then-write-races-on-haf-backed-routes-2026-05-XX.md`.

Suggested content outline (architect to draft via `/ce-compound`):

- **Pattern.** Routes that read HAF (or any indexed view of an asynchronously-replicated chain state) and then broadcast a write under a service account are susceptible to read-then-write races. The HAF index lag between broadcast and read-back is the race window. `/register` and `/update` in `routes/bridge.ts` are the second instance of this class (after ORCID `/callback` bind flow); the third instance will arrive without warning.
- **Mitigation.** Per-key Redis SETNX lock acquired BEFORE the HAF read, held until broadcast resolves, released in finally under Lua CAS on a per-acquisition nonce. Lock TTL must exceed the broadcast wall-clock timeout (`DEFAULT_BROADCAST_TIMEOUT_MS = 30s` in `hive.ts`); 35s is the current default for bridge and orcid routes.
- **Fail-closed on HAF outage.** When the HAF query throws, do NOT proceed with broadcast on write paths. Surface 503 + `{retriable: true}` with a structured warn log. Read-only paths can fail-open if the consequence is bounded (e.g. a spurious "no duplicate" answer on a `/check` probe is harmless; the same answer on a `/register` handler licenses a duplicate broadcast).
- **Redis key prefix.** All lock keys MUST be prefixed with `${config.appTag}:<lock_domain>:` per project Redis conventions.
- **Lock release MUST use Lua CAS on a per-acquisition nonce.** A naive `redis.del(lockKey)` in finally races against TTL expiry — if our broadcast takes longer than the lock TTL, a sibling can acquire the lock under a new nonce, and our finally would delete the sibling's lock. The Lua CAS prevents this. See `BRIDGE_RELEASE_LOCK_LUA` in `bridge.ts` and `RELEASE_LOCK_LUA` in `orcid.ts` (identical shape).
- **Cross-references.** Link to `agents/docs/solutions/conventions/chain-write-timeout-ambiguous-outcome-2026-04-22.md` for the `BroadcastTimeoutError` envelope semantics and to `routes/orcid.ts`'s `withOrcidBindingLock` for the wrapper pattern when the lock is reused across multiple handlers.

---

## Architect re-review (2026-05-11, round-1 → round-2) — HELD PENDING FIXES

`/ce-code-review` ran on round-1 main-tree SHA `d513d7d` with 11 reviewer personas (correctness, security, adversarial at opus; testing, maintainability, project-standards, learnings, reliability, kieran-typescript, api-contract, performance at sonnet; `ce-agent-native-reviewer` skipped per project CLAUDE.md). Three items in the round-1 acceptance landed structurally (per-permlink SETNX on `/register`, per-(author, permlink) SETNX on `/update`, fail-closed HAF discriminated union), AND the `/update` lock work is dead code per the subsequent commit `e647abb` retiring `/update`. Re-review surfaced 9 items clustered on: the SPA-facing 409 contract, the hafCache poisoning of `haf_unavailable`, an unguarded discriminated-union switch, the lookupPreprint cascade pushing in-lock wall-clock past TTL, log-route mislabeling, mock-carve-out clause C, the Lua CAS no-op signal, and two test gaps.

Several cross-task / cross-zone findings (the EVALSHA migration consolidating the duplicated Lua + lock-state types, the SPA `handleRegister` LOCK_HELD-aware UX, the contract-doc updates at archive, the test-fence replace-setTimeout polish) are filed as new follow-up tasks rather than bundled here — they have different ownership shapes than this task's narrow contract.

### Items to address (bundle into one round-2 commit)

**1. (P1, anchor 100, api-contract AC-1) Two distinct 409 DUPLICATE shapes share the same `code: 'DUPLICATE'`.** `backend/src/routes/bridge.ts:321` (lock-held) and `:343` (existing-duplicate). Lock-held emits `{code:'DUPLICATE', message:'...in progress', details:{retriable:true}}`; existing-duplicate emits `{code:'DUPLICATE', message:'...already registered', existing_author, existing_permlink}` (no `details`, no `retriable`). A frontend or integrator handling `err.code === 'DUPLICATE'` gets both conflated; message-string discrimination is a load-bearing contract surface that the next refactor breaks silently.

   Fix: rename the lock-held 409 code from `DUPLICATE` to `LOCK_HELD` at `bridge.ts:321`. Update `bridge.test.ts` (and any other test) assertions accordingly. Existing-duplicate 409 keeps `code: 'DUPLICATE'` unchanged. Architect updates `bridge.md` at archive of this task to document both codes atomically.

**2. (P2, anchor 100, 4-reviewer corroboration: reliability R-1 + adversarial ADV-003 + kieran-typescript KT-3 + correctness C-3) `hafCache.getOrSet` caches the `haf_unavailable` sentinel for 30s, poisoning `/check`.** `backend/src/routes/bridge.ts:256`. `QueryCache.getOrSet` caches any non-null return value; `{status: 'haf_unavailable'}` is a non-null object and lands in the cache. Subsequent `/check` calls within the 30s TTL return cached `haf_unavailable` mapped back to `{exists: false}` (fail-open), serving stale answers for up to 30s after HAF recovers in 1-2s. `/register` is unaffected (no cache).

   Fix: skip caching when `checkExistingBridge` returns `{status: 'haf_unavailable'}`. Two acceptable shapes:
   (a) Resolve `checkExistingBridge` directly outside `getOrSet` and pass only the `'ok'` variant into the cache. Architect-preferred — keeps `getOrSet`'s value type to the "known-good" shape.
   (b) Use `getOrSet`'s skip-cache hook if one exists; if not, the resolve-outside pattern is cleaner than introducing one.

**3. (P2, anchor 100, cross-reviewer: correctness C-1 + kieran-typescript KT-2 + learnings convention `correlated-options-discriminated-union-2026-04-28.md`) `BridgeCheckResult` switch lacks `assertNever`.** `backend/src/routes/bridge.ts:262` (`/check`) and `:340` (`/register`). The 2-variant union (`'ok' | 'haf_unavailable'`) is discriminated via `if (...) { } else { }` with no exhaustiveness check. A future 3rd variant (e.g. `'haf_lag_high'` for degraded freshness) compiles cleanly and silently falls through to the `'ok'` branch — exactly the failure class this task closes. orcid.ts at `withOrcidBindingLock` uses `assertNever(lock)` precisely for this. Bridge adopted the rest of the orcid lock pattern but missed this guard.

   Fix: add `assertNever(result)` (helper exists in codebase, see orcid.ts) at the trailing else of each call site. Two locations. About 4-6 lines total.

**4. (P2, anchor 100, cross-reviewer: reliability R-2 + maintainability M-3) `checkExistingBridge` log hardcodes `route: 'bridge.register'` but called from both `/register` and `/check`.** `backend/src/routes/bridge.ts:226-229`. The function is called from `/register` (line 332/340) AND from `/check` (line 256 via `hafCache.getOrSet`). The catch's logger.warn emits `event: 'bridge.register.haf_check_failed'` + `route: 'bridge.register'`. When the warn fires from a `/check` HAF failure, operator dashboards filtering on `route: 'bridge.register'` see a false alert. The test spec at `bridge-haf-lag-locks.test.ts:1227-1233` asserts these specific values, making the divergence structural.

   Fix: thread a `callerLabel: string` parameter through `checkExistingBridge` (default to `'bridge.register'` for backward compat). `/register` passes the default (or `'bridge.register'`); `/check` passes `'bridge.check'`. The event field can also become parameterized (e.g. `event: \`${callerLabel}.haf_check_failed\``), or stay route-prefixed. Test spec at bridge-haf-lag-locks.test.ts:1227-1233 updates accordingly.

**5. (P2, anchor 75, project-standards PS-001) Test mock carve-out clause C not satisfied.** `backend/tests/routes/bridge-haf-lag-locks.test.ts` (header carve-out justification). The header cites `bridge.test.ts`'s unlocked-degrade path as the real-path companion — but that exercises Redis-unavailable fallback (a different failure mode), not SETNX lock contention (this file's actual risk class). Per CLAUDE.md mock carve-out clause C, the companion must exercise the same risk class OR a follow-up task must be filed.

   Fix: backend EITHER (a) updates the header to cite an existing real-Redis SETNX-contention test if one exists (e.g., the orcid suite if `withOrcidBindingLock` is exercised against real Redis), OR (b) files a new task and references it in the header. The architect is filing `backend-bridge-lock-real-redis-companion.md` at archive as the follow-up companion (option b is the architect's choice if no orcid real-Redis companion exists). Implementer's task: update the test-file header to cite the actual companion that satisfies clause C.

**6. (P2, anchor 75, adversarial ADV-001) TTL-exceeded cascade: `lookupPreprint` inside lock can push wall-clock past 35s TTL.** `backend/src/routes/bridge.ts:354`. The critical section currently spans `acquireBridgeLock` → `checkExistingBridge` (~100ms HAF query) → `lookupPreprint` (CrossRef 15s timeout + DOI scrape 10s, PubMed adds ~15s) → broadcast (`DEFAULT_BROADCAST_TIMEOUT_MS = 30s`). Worst-case wall-clock 55-70s; lock TTL is 35s. Lock can expire mid-broadcast, sibling re-acquires under new nonce, sibling broadcasts a duplicate. The chain `tx_duplicate` is the last line of defense — exactly the dependency the lock was added to remove.

   Fix: move `lookupPreprint` call BEFORE lock acquisition. The lookup is a pure metadata fetch (external HTTP, no chain state); it doesn't need lock protection. Concretely: between `resolveToCanonical` at `bridge.ts:299` and `acquireBridgeLock` at `:316`, hoist the `lookupPreprint(identifier)` call (current location `:354`). After the refactor, in-lock time = HAF query (~100ms) + broadcast (~30s) = comfortably under 35s TTL. Error handling for `lookupPreprint`'s failure path moves with it.

**7. (P3, anchor 75, reliability R-3) Lua CAS no-op on TTL-expired lock not logged.** `backend/src/routes/bridge.ts:93-101` (releaseBridgeLock). The Lua script returns 1 on a successful CAS-delete, 0 on no-op (lock TTL expired or sibling re-acquired). The current code doesn't inspect the return. A 0-return is operationally significant: it means the broadcast outlasted the 35s TTL (likely under load, slow Hive node, or external API stall). Operators have no signal. Same shape exists in orcid.ts — not a regression introduced here; close it on bridge first to set the pattern.

   Fix: inspect the return value of `redis.eval` in `releaseBridgeLock`. On 0-return, emit a structured warn log: `logger.warn({event: 'bridge.lock.release_noop', lockKey}, 'lock release no-op: TTL expired or sibling re-acquired');`. About 5 lines. If desired, file a follow-up to apply the same pattern to orcid.ts — but that's separate from this task.

**8. (P3, anchor 75, testing T-1) `/check` fail-open `haf_unavailable` path has no test.** `backend/src/routes/bridge.ts:255-260` adds new behavior mapping `haf_unavailable` to `{exists: false}` on `/check`. The new test file `bridge-haf-lag-locks.test.ts` has no spec covering this branch. A regression that mapped `/check` to 503 (matching `/register`), returned the raw discriminated-union with `status` field exposed on the wire, or returned an empty object would be undetected.

   Fix: backend adds a `/check` HAF-failure spec to `bridge-haf-lag-locks.test.ts`. Pattern: inject a throwing `pgQueryImpl`, call `GET /api/bridge/check?identifier=...`, assert response 200 + body shape `{data: {exists: false, author: null, permlink: null, title: null, created: null}}` (status field is INTERNAL to BridgeCheckResult and must NOT appear on the wire). About 20 lines.

**9. (P3, anchor 75, testing T-2) Lock-release `finally` correctness not asserted in concurrency specs.** `backend/tests/routes/bridge-haf-lag-locks.test.ts:276` (both `/register` and `/update` concurrency describes). Specs assert response status (200 + 409) and `sendOperations.toHaveBeenCalledTimes(1)` but never check that the Redis lock key is absent from `fakeRedis.store` after the request completes. A bug bypassing the `finally` block (early return outside try, missing `state === 'acquired'` check) would leave the lock held forever; the tests would still pass.

   Fix: after `await Promise.all([reqA, reqB])` in each concurrency spec, add `expect(fakeRedis.store.has(lockKey)).toBe(false)`. Lock key reconstructable from `config.appTag` + `bridgeRegisterLockKey(permlink)` / `bridgeUpdateLockKey(author, permlink)`. About 4 lines per spec, 2 specs.

   Note: the `/update` concurrency spec exists in this test file at d513d7d but is dead code on current main (`/update` route retired by `e647abb`). The implementer may EITHER (a) keep both specs and apply the assertion to both, OR (b) drop the `/update` spec entirely and apply the assertion only to `/register`. Architect prefers (b) — drop the `/update` spec; the dead path doesn't warrant test maintenance.

### Re-review signal

When items 1-9 land in a single round-2 commit, `git mv` this file back to `tasks/review/`. Architect's round-2 review scopes `/ce-code-review` to the round-2 commit only. Item 6 (lookupPreprint hoist) is the highest-risk change semantically; items 1+3+4 are mechanical; items 2+5+7+8+9 are localized to specific sites. Test-suite green requirement applies.

### Architect-zone items (NOT for the implementer)

The following are architect-owned and land at archive of this task, not as round-2 hold items:
- Update `agents/docs/api-contracts/bridge.md` (and `common.md` if appropriate) at archive: document the new `LOCK_HELD` 409 code (per item 1), correct the `/check` errors section to reflect the 200-with-fail-open behavior on HAF failure (api-contract AC-3), enumerate the two 503 SERVICE_UNAVAILABLE sub-cases (key-not-configured + HAF-unavailable) (api-contract AC-4), and document the DUPLICATE shape including both code paths (api-contract AC-2).
- Add a residual note in `tasks-archive.md` (when this task archives) explicitly naming the Redis-unavailable degrade path as a known residual: `acquireBridgeLock` returns `'unavailable'` and the route falls through unlocked during a Redis outage, intentionally trading the rare-race window for not-503ing every /register during a Redis flap (adversarial ADV-002). The code comment at `bridge.ts:59-91` documents this; the archive entry should call it out so future maintainers reading the archived task don't infer "race closed unconditionally."
- File new task `backend-bridge-outer-catch-event-discriminators.md` at archive (pre-existing bridge.ts pattern that task #3's custody change made visible — out of this task's scope).
- File new task `backend-broadcast-attempt-helper-extraction.md` at archive (P2 moderate refactor for the duplicated `logBroadcastAttempt` closure across custody.ts + bridge.ts — discovered via task #3 review).
- File new task `backend-bridge-lock-real-redis-companion.md` at archive (the clause-C companion for item 5).
- File new task `ui-bridge-register-lock-held-ux.md` at archive (gated on item 1's `LOCK_HELD` rename landing — SPA branches on the new code).
- File new task `backend-bridge-test-fence-replace-setTimeout.md` at archive (P3 test infrastructure polish — replace the `setTimeout` stagger fence with an explicit barrier; adversarial ADV-004).
- Defer EVALSHA migration + shared Lua constant + shared RedisLockState type (maintainability M-1 + M-2 + performance PERF-1) to the EVALSHA-optimization task currently in `tasks/review/`. Architect ensures that task's migration scope includes bridge.ts when it's reviewed.

---

## Backend re-review signal (2026-05-11, round-2 hold-fixes — commit `8f81492` on `main`, originally `1fbac32` on `worktree-agent-a1b9aacbbc1e25e82`)

Round-2 hold items 1-9 all landed in commit `8f81492` on `main` (originally `1fbac32` on worktree branch `worktree-agent-a1b9aacbbc1e25e82`). Scoped vitest (`bridge-haf-lag-locks.test.ts` + `bridge.test.ts` + `bridge-paper-author-gate.test.ts`) all green (3 + 13 + 12 = 28 specs); `tsc` and `eslint` clean (preexisting `seed-phrase.ts` `any` warnings unchanged). Parent's full-suite `npx vitest run` post-merge surfaced 2 pre-existing failures unrelated to this task's diff: `tests/routes/disciplines-canon-mocked.test.ts:669` (continuation-chain head-override — failure path doesn't touch any file in this task's scope) and `tests/routes/stats-profile-parity.test.ts:166` (real-chain data flake — passed on retry).

- **Item 1 (LOCK_HELD discrimination).** `bridge.ts:404` (lock-held branch) emits `code: 'LOCK_HELD'`; `bridge.ts:426` (existing-duplicate) keeps `code: 'DUPLICATE'`. `types/api.ts` ErrorCode union extended with `LOCK_HELD` literal. Concurrency spec updated to assert the loser's `code` is `LOCK_HELD`. The architect-zone note on `bridge.md` contract doc update was left for the archive pass (per the hold-block "Architect-zone items" section already calling it out).
- **Item 2 (haf_unavailable cache skip).** Chose architect-preferred in-bridge.ts solution. `/check` now probes `hafCache.get` for the `'ok'` shape only and writes-through ONLY the ok variant; `haf_unavailable` bypasses the cache entirely. `cache.ts` API surface unchanged (no `skipCacheIf` predicate added).
- **Item 3 (assertNever exhaustiveness).** Added `assertNever(result)` at the trailing else of the `BridgeCheckResult` switch in `/check` (`bridge.ts:318`) and `assertNever(existing)` in `/register` (`bridge.ts:437`). Imported from `../util/assertNever.js` (mirrors orcid.ts pattern).
- **Item 4 (callerLabel parameter).** `checkExistingBridge` accepts `callerLabel: 'bridge.register' | 'bridge.check'` (default `'bridge.register'` for backward compat). Both call sites pass the appropriate literal. HAF-failure warn log emits `event: \`${callerLabel}.haf_check_failed\`` + `route: callerLabel` so `/check` HAF blips no longer false-alert on the `bridge.register` operator dashboard filter.
- **Item 5 (mock carve-out clause C).** New follow-up task filed: `agents/docs/tasks/pending/backend-bridge-lock-real-redis-companion.md`. The test-file header in `bridge-haf-lag-locks.test.ts` was updated to cite the follow-up task explicitly; clause C is satisfied via the "OR a follow-up task is filed" branch. Implementer chose option (b) per the hold-block note since no existing real-Redis SETNX-contention test was found in the suite.
- **Item 6 (lookupPreprint hoist).** Hoisted `lookupPreprint(identifier)` to BEFORE `acquireBridgeLock` in `/register`. In-lock wall-clock is now HAF (~100ms) + broadcast (~30s), comfortably under the 35s `BRIDGE_LOCK_TTL_SECONDS`. The lookup's error path (CrossRef/PubMed failure) moved with it; the broadcast still owns the lock as before.
- **Item 7 (Lua CAS no-op log).** `releaseBridgeLock` now takes `(lockKey, nonce, acquiredAtMs, routeLabel, permlink)` and inspects the Lua eval return. On 0-return (TTL expired or sibling re-acquired), emits `logger.warn({ event: 'bridge.lock.release_no_op', wallClockMs, ttlSeconds, ... })`. `BridgeLockState.acquired` carries `acquiredAtMs` so the wall-clock-since-acquisition is structured-loggable without re-clocking. Bridge-side only per task scope.
- **Item 8 (/check fail-open test).** New `describe` block at the bottom of `bridge-haf-lag-locks.test.ts` covers the `/check` HAF-throw path. Asserts 200 + body `{exists:false, author:null, permlink:null, title:null, created:null}` + NOT `toHaveProperty('status')` (no internal discriminator leaks on the wire) + warn-log `route: 'bridge.check'` (item 4 follow-through).
- **Item 9 (lock-release finally assertion).** Concurrency spec asserts `fakeRedis.store.has(\`${config.appTag}:bridge_register_lock:bridge-arxiv-2301-99999\`)).toBe(false)` after both requests resolve. Per architect option (b), the dead `/update` spec was not present in the file (already retired upstream) — only `/register` got the assertion.

---

## Architect re-review (2026-05-15, round-2 → round-3) — HELD PENDING FIXES

`/ce-code-review` ran on round-2 main-tree SHA `8f81492` with 10 reviewer personas (correctness, security, adversarial at opus; testing, maintainability, project-standards, learnings, reliability, kieran-typescript, api-contract at sonnet; `ce-agent-native-reviewer` skipped per project CLAUDE.md). Round-2's 9 hold items (LOCK_HELD vs DUPLICATE discrimination, `haf_unavailable` cache skip, `assertNever` exhaustiveness, `callerLabel` parameter, mock-carve-out clause C follow-up, `lookupPreprint` hoist OUT of lock window, Lua CAS no-op signal, `/check` fail-open spec, lock-release finally assertion) all landed structurally and against intent. Re-review surfaced 4 small items to bundle into round-3; several adversarial / api-contract / maintainability findings were dismissed at architect triage (rationale below).

The clause-C companion task was filed in `78e8578` (initially `agents/docs/tasks/pending/backend-bridge-lock-real-redis-companion.md`), then the test-file header was updated in `6eaad6f` to cite `orcid.test.ts:1040` as the real-Redis SETNX-contention companion, then archived in `9c8e44e`. Clause-C is currently satisfied via the orcid real-path companion; the project-standards PS-001 finding in this round is historically true at the 8f81492 snapshot but currently moot. Not bundled into round-3.

Architect-zone parallel work landed in commit `938af54` (separate from this hold-block): added `LOCK_HELD` row to `common.md` standard error codes table and corrected `/check` errors section in `bridge.md` to document the fail-open envelope (round-2 item 2's `/check` change made the prior `INTERNAL_ERROR` doc misleading). Both surfaced in this review (api-contract AC-2 + AC-3); architect resolved fix-in-place at review time rather than queuing as hold-block items since they are architect-zone files.

### Items to address (bundle into one round-3 commit)

**1. (P2, anchor 85, cross-reviewer: testing T-1 + adversarial ADV-004) `/check` fail-open spec missing `fakeRedis` cache-key-absence assertion.** `backend/tests/routes/bridge-haf-lag-locks.test.ts` (the new `/check fail-open on HAF outage` describe block added in round-2 item 8). The spec asserts the response shape and the warn log event/route but never checks that the cache key is absent from `fakeRedis.store` after the request. Round-2 item 2's primary correctness invariant ("`haf_unavailable` never lands in the 30s cache") has no mutation-killing assertion: a regression re-introducing `hafCache.getOrSet(...)` wrapping (or incorrectly calling `hafCache.set` on the `haf_unavailable` branch) would write the cache key into the store with zero failing test signal. This invariant is THE point of round-2 item 2; leaving it untested makes the item fragile.

   Fix: after the response assertion block in the fail-open spec, add `expect(fakeRedis.store.has(\`${config.appTag}:cache:bridge-check:arxiv:2301.99999\`)).toBe(false);` (or the equivalent for whatever identifier the spec uses — match the cache-key shape produced by `hafCache.getOrSet`'s key derivation). Mutation-kills the round-2 item 2 invariant. ~4 lines including a comment naming the invariant.

**2. (P3, anchor 100, cross-reviewer: correctness + adversarial) Sibling stale archived-task reference at `backend/src/routes/bridge.ts:474-478`.** The `logBroadcastAttempt` closure / factory call site in `/register` still references the archived `backend-broadcast-idempotency-cluster-followup.md` task by name with the "lands the real per-key counter" framing. Same drift class as the `custody.ts` sites already fixed in `backend-bridge-custody-broadcast-discrimination` round-4 and the `broadcast-error.ts:649-658` site held for round-5 in that task. Cluster archived 2026-05-12 (commit `c715db1`) without a per-attempt counter. Bundle the `bridge.ts` site here so the cluster converges in one round.

   Fix: rewrite the docblock at `backend/src/routes/bridge.ts:474-478` to drop the archived-task name and reflect actual state. Mirror the framing applied at the `custody.ts` sites in round-4: idempotency layer landed, per-attempt counter intentionally not added, slot stays absent until a per-key counter mechanism exists. ~5 lines.

**3. (P3, anchor 100, 3-reviewer corroboration: adversarial ADV-005 + kieran-typescript KT-3 + maintainability RR2) `callerLabel` default `'bridge.register'` is a silent-wrong-label trap.** `backend/src/routes/bridge.ts:210` (`checkExistingBridge` parameter signature). Both current callers (`/register` at line 303, `/check` at line 426) now pass the label explicitly. The default `'bridge.register'` exists "for backward compat" per the commit message, but there is no other caller — and the very purpose of round-2 item 4 was to eliminate `/check` HAF blips false-alerting on the `bridge.register` operator dashboard. A future third caller that forgets the argument silently inherits `'bridge.register'`, reintroducing the false-alert problem the parameter was added to prevent. Removing the default forces the compiler to enforce explicit labeling at every new call site, which is the entire point of the literal-union type.

   Fix: change `callerLabel: 'bridge.register' | 'bridge.check' = 'bridge.register'` to `callerLabel: 'bridge.register' | 'bridge.check'` (drop the default). Both existing call sites already pass explicitly; verify any direct-helper-call test sites (if any) also pass the label. Compile-time enforcement at the call boundary.

**4. (P3, anchor 75, maintainability RR1) HAF-failure warn log message string says "failing closed" on the `/check` fail-open path.** `backend/src/routes/bridge.ts:269` (the human-readable message in `checkExistingBridge`'s HAF-failure warn log). The current message is `'Bridge check HAF query failed — failing closed, surfacing 503 to caller'`. With round-2 item 4's `callerLabel` parameter, this same code path now fires from BOTH `/register` (fail-closed → 503; message accurate) AND `/check` (fail-open → 200 with `{exists:false}`; message misleading). The structured fields (event, route) are correctly parameterized; only the human-readable message text remains hardcoded to the `/register` interpretation. Dashboards key on structured fields so this is human-readable-text-only drift, but a developer reading logs during a `/check` HAF blip would see a message claiming 503 was surfaced when actually 200 was.

   Fix: parameterize the message string by `callerLabel`, OR generalize it to something like `'Bridge HAF query failed; route field carries the fail-open / fail-closed disposition'`. ~2-5 LOC.

### Items dismissed during architect triage

- **DUPLICATE 409 response shape moved from `error.*` to `error.details.*` (api-contract AC-1, conf 100 as flagged).** False positive: the DUPLICATE branch in BOTH pre-diff and post-diff inlines the response with `existing_author` and `existing_permlink` at the top level of `error` (post-diff `backend/src/routes/bridge.ts:426-432`; pre-diff `:343-348`). Neither version uses `sendError(...)` for this branch. The api-contract reviewer hallucinated a `sendError` refactor that never occurred; no contract change for the existing DUPLICATE response shape. Verified by inspection of both commit blobs.
- **`releaseBridgeLock` has 5 positional parameters (maintainability M1).** Single call site at `:560`, well-named parameters, immediate adjacency to the call. PEvO bias is YAGNI: an options-object refactor adds indirection to protect against a transposition bug that has not occurred and is unlikely with one call site. Revisit if a second call site lands.
- **`assertNever` throw at `/register:437` escapes outer try/finally (adversarial ADV-008 + security RR).** The outer `try` has a `finally` (lock release) but no `catch`, so a runtime `assertNever` throw propagates to Express's default error handler — response is the default-handler envelope, not the structured `INTERNAL_ERROR` JSON. Lock release fires correctly via finally; no partial broadcast (the throw is pre-broadcast). The path is TS-guarded at compile time; reaching the runtime throw requires actively silencing exhaustiveness (e.g. `as any` or `@ts-expect-error`). The Express default error handler response shape divergence is cosmetic, not behavioral. Defense-in-depth on a hypothetical TS-bypass; not worth boilerplate.
- **`wallClockMs` uses `Date.now()`, vulnerable to wall-clock step (adversarial ADV-002).** PEvO is single-instance per project memory `project_single_instance_only.md`; the operator signal exists for TTL-exceeded cascades (~30-65s wall-clock); NTP slew at millisecond scale is invisible at the signal's resolution. Swap to `performance.now()` if observability becomes a real concern.
- **TTL-exceeded warn log unbounded under sustained slow-Hive (adversarial ADV-003).** Bridge writes rate-limited 10/hour/IP; a sustained cascade IS the operationally-noteworthy event the log exists to surface. Sampling would defeat the signal. PEvO's log-minimal stance applies to ADDING logs; this log is already in the diff, justified by operator-visibility, and bounded upstream.
- **LOCK_HELD 409 missing `Retry-After` hint (adversarial ADV-006).** SPA is the sole consumer today and handles retries on its own cadence. Beta-stability stance in `common.md` covers future integrators. Revisit if a non-SPA client appears.
- **Project-standards PS-001 (mock carve-out clause C unfulfilled at 8f81492).** Historically true at the round-2 snapshot but currently moot: the companion task was filed in `78e8578`, then the test-file header was switched in `6eaad6f` to cite `orcid.test.ts:1040` as the real-Redis SETNX-contention companion, then the companion task archived in `9c8e44e`. Clause C is currently satisfied via the orcid real-path companion.

### Architect followups (land at archive, do NOT block backend re-submit)

- **A1 (new).** `/ce-compound` for the "read-then-write races on HAF-backed routes" convention — round-1 [TODO Architect] from this task that never landed. Bridge `/register` and (retired) `/update` are the canonical exemplars; ORCID `/callback` is the prior instance. Pattern: hoist external IO out of lock window; lock TTL must exceed worst-case in-lock wall-clock; HAF read fail-closed on write paths, fail-open on read-only probes.
- **A2 (new).** `/ce-compound` for the "Redis advisory lock with Lua CAS release on per-acquisition nonce" pattern, exemplified by `withOrcidBindingLock` in `orcid.ts` and `acquireBridgeLock` / `releaseBridgeLock` in `bridge.ts`. Includes the nonce-ownership invariant, the 0-return semantics (TTL expired or sibling re-acquired = TTL-exceeded cascade signal), the structured warn log shape, and the TTL-sizing constraint relative to expected wall-clock.
- **A3 (carry forward).** Round-1 architect followup A2 (`timeout_ms` qualifier in `bridge.md` / `custody.md` BROADCAST_TIMEOUT details: present iff the underlying throw was a `BroadcastTimeoutError`; `common.md` line 75 is already correctly qualified) carries forward unchanged.

### Re-review signal

When items 1-4 land in a single round-3 commit, `git mv` this file back to `tasks/review/`. Architect's round-3 review scopes `/ce-code-review` to the round-3 commit only. Items 1-4 are localized to 3 files: `backend/src/routes/bridge.ts` (items 2, 3, 4 — docblock rewrite + signature change + message string), `backend/tests/routes/bridge-haf-lag-locks.test.ts` (item 1 — assertion). Total diff ~15-20 LOC of source + ~5 LOC of test assertion. Expect convergence at round-3 and archive immediately after, at which point the architect lands followups A1, A2, and A3 in separate architect-zone commits.

---

## Backend re-review signal (2026-05-15, round-3 hold-fixes)

All four round-3 hold items landed in a single commit. Scoped vitest (`bridge-haf-lag-locks.test.ts` + `bridge.test.ts` + `bridge-paper-author-gate.test.ts`) all green (3 + 13 + 17 = 33 specs); `npm run lint` clean (preexisting `seed-phrase.ts` `any` warnings unchanged); `npx tsc --noEmit` clean.

### Item 1 — `/check` fail-open cache-key-absence assertion

`backend/tests/routes/bridge-haf-lag-locks.test.ts:494-502` — added `expect(fakeRedis.store.has(...)).toBe(false)` for the appTag-prefixed `cache:bridge-check:arxiv:2301.99999` key inside the existing `/check fail-open on HAF outage (round-2 hold item #8)` describe block. The key shape matches `hafCache`'s `${config.appTag}:cache:` prefix concatenated with the route-side cache key (`bridge-check:${parsed.type}:${parsed.id}`). Mutation-kills round-2 item 2's invariant: a regression re-introducing `hafCache.getOrSet(...)` wrapping or calling `hafCache.set` on the `haf_unavailable` branch would write the prefixed key and fail this assertion.

### Item 2 — `logBroadcastAttempt` docblock rewrite

`backend/src/routes/bridge.ts:474-481` — replaced the stale `backend-broadcast-idempotency-cluster-followup.md` reference and "lands the real per-key counter" framing with the custody.ts round-3 framing: idempotency layer landed (HAF dedup + tx_id replay short-circuit), per-attempt counter intentionally not added, slot stays absent until a per-key counter mechanism exists. Mirrors the `custody.ts:507-516` framing one-for-one.

### Item 3 — Drop `callerLabel` default value

`backend/src/routes/bridge.ts:215` — `callerLabel: 'bridge.register' | 'bridge.check'` (no default). Both call sites (`/check` at `:309` after the docblock additions and `/register` at `:432`) already pass explicitly. TS surfaced a follow-on constraint: `callerLabel` (now required) cannot follow `resolvedParsed?` (optional). Resolved by dropping `?` from `resolvedParsed` (line 210). Both call sites already pass `parsed` non-null after the route's early-400 guard, so the change is safe. The `?? parseIdentifier(identifier)` defensive fallback inside `checkExistingBridge` stays in place for the `null` case.

### Item 4 — Generalize HAF-failure warn log message

`backend/src/routes/bridge.ts:271-277` — message string changed from `'Bridge check HAF query failed — failing closed, surfacing 503 to caller'` to `'Bridge HAF query failed; route field carries fail-open vs. fail-closed disposition'`. Now disposition-neutral and accurate for both `/register` (fail-closed → 503) and `/check` (fail-open → 200) call paths. Operator dashboards key on structured fields (`event`, `route`), not message text. Verified at runtime in the test output: both the `/register` HAF-throw test and the `/check` HAF-throw test now emit the new message with the appropriate `route` field discriminator.

### Notes on the architect-zone items

The "Architect followups (A1, A2, A3) at archive" section is unchanged. Item 5 from round-2 (mock carve-out clause C) was historically true at `8f81492` but currently moot per the architect's dismissal in this round-3 hold block — clause C is satisfied via the orcid real-Redis SETNX-contention test cited in the test-file header (`orcid.test.ts:1040`).

---

## Architect re-review (2026-05-17, round-3 → round-4) — HELD PENDING FIXES

`/ce-code-review` ran on round-3 main-tree SHA `7690efd` with 6 reviewer personas (correctness on Opus; testing, maintainability, project-standards, learnings-researcher, kieran-typescript on Sonnet; `ce-agent-native-reviewer` skipped per project CLAUDE.md; security/adversarial/reliability/api-contract/performance/data-migrations skipped at architect scope — the round-3 diff is 3 files / ~50 LOC, narrow signature/comment/log-text changes with no new behavioral surface). Round-3's 4 hold items (cache-key-absence assertion, logBroadcastAttempt docblock, `callerLabel` default drop, disposition-neutral warn message) all land structurally and against intent. One small item holds for round-4 from maintainability; other findings dismissed at architect triage (rationale below).

### Item to address (round-4 hold)

**1. (P1, anchor 75, maintainability M1) Round-3 item 4's warn-log message overcorrects: meta-explanation of the data model belongs in code comments, not in operator-facing log text.** `backend/src/routes/bridge.ts:271-277`. The message `'Bridge HAF query failed; route field carries fail-open vs. fail-closed disposition'` was changed from the prior `'Bridge check HAF query failed — failing closed, surfacing 503 to caller'`. The disposition-neutral change is correct (the prior message was `/register`-specific and inaccurate when fired from `/check`), but the replacement appends a structured-field explanation into the human-readable message string. That explanation is already fully present in the inline comment block at `bridge.ts:276-280` immediately above the `logger.warn` call. Two copies of the same rationale to keep in sync; operator dashboards key on structured fields (`event`, `route`) not message text.

   Fix: trim the message string to `'Bridge HAF query failed'`. Disposition-neutrality is preserved (no `/register`-specific wording), the inline comment carries the WHY for future maintainers, and the operator-facing surface stays clean. ~1 LOC change.

### Items dismissed during architect triage

- **(testing, P3 anchor 50, conf 55) Cache-key absence assertion passes vacuously if `bridge-check:` prefix or `${parsed.type}:${parsed.id}` shape is renamed.** Reviewer self-flagged as preemptive hardening. Dismissed per project memory `feedback_dismiss_preemptive_test_hardening`: a cache-key rename is an obvious scope-change that would be caught at code review; no concrete refactor planned; the assertion's current mutation-kill claim (round-2 item 2 invariant) is intact for any regression in the actual cache-skip logic.
- **(kieran-typescript KT-1, P2 anchor 50, conf 55) `resolvedParsed: ... | null` is dead-null branch given both callers null-guard `parsed` before invocation.** Real type-accuracy observation but below the confidence gate; the `??` fallback is defensive depth that compiles cleanly and runs as a sanity check. Dismissed; revisit if a third caller is added that doesn't null-guard upstream.
- **(testing T-01 + maintainability RR-1) Documentation/wording nits on the new `resolvedParsed` comment block.** Below threshold; comment correctly captures the WHY (`??` retention) for future readers.

### Architect followups (land at archive after round-4 clean — do NOT block backend re-submit)

Carried forward unchanged from round-3 hold-block:
- **A1.** `/ce-compound` candidate for the "deliberately remove a defaulted optional to force explicit-labeling at every call site" pattern — sibling to existing `wrapping-primitive-exhaustive-call-site-audit-2026-04-22.md`. Round-3 item 3 (`callerLabel` default drop) is the canonical exemplar. Architect's discretion at archive.
- **A2/A3.** "Read-then-write races on HAF-backed routes" + "Redis advisory lock with Lua CAS release on per-acquisition nonce" — both convention docs already exist (`read-then-write-races-on-haf-backed-routes-2026-05-15.md`, `redis-advisory-lock-with-lua-cas-nonce-2026-05-15.md`); no new work needed.
- Pre-existing architect-zone followups from round-2/3 stand.

### Re-review signal

When item 1 lands in a single round-4 commit, `git mv` this file back to `tasks/review/`. The mv itself is the re-review signal. Round-4 architect review scopes `/ce-code-review` to the round-4 commit only. Diff is ~1 LOC; round-4 should converge clean.

---

## Backend re-review signal (2026-05-17, round-4 hold-fix)

Round-4 item 1 landed. `backend/src/routes/bridge.ts:281` (inside `checkExistingBridge`'s HAF-failure `logger.warn`) — message string trimmed from `'Bridge HAF query failed; route field carries fail-open vs. fail-closed disposition'` to `'Bridge HAF query failed'`. The structured-field meta-explanation now lives only in the inline comment block at `bridge.ts:276-280`; structured `event` and `route` fields continue to carry the fail-open vs. fail-closed disposition for operator dashboards.

Scoped vitest (`bridge-haf-lag-locks.test.ts` + `bridge.test.ts` + `bridge-paper-author-gate.test.ts`): 33 specs green. `npx tsc --noEmit` + `npm run lint` clean.

## Architect re-review (2026-05-20) — HELD PENDING FIXES

`/ce-code-review` ran on round-4 commit `fda790f` with a minimal persona fleet (correctness on Opus; project-standards, maintainability at Sonnet) appropriate to the ~1 LOC string-trim scope. The round-4 message-string change landed against intent; all checked invariants (structured `event`+`route` fields still emitted, no test assertions on the old message text, rationale preserved in the inline comment block at `bridge.ts:276-280`) confirmed clean.

Maintainability surfaced one item that is a convention-enforcing-fix gap from round-4 itself: the inline comment block round-4 trimmed FROM also contains a round-number citation that should have been swept during the same edit.

### Item to address (round-5 hold)

**1. (P3, anchor 100, maintainability + correctness residual) Round-number citation `Round-3 hold item #4:` in `bridge.ts:276` comment block.** The inline comment above the trimmed warn-message at `bridge.ts:276-280` opens with `Round-3 hold item #4:`. Per CLAUDE.md "Comment anchors" + `agents/docs/solutions/conventions/task-slug-citations-in-comments-go-stale-on-archive-2026-05-15.md`, round-number citations rot when the task archives (imminent — this task is on the archive path after round-5 clean). The behavioral substance that follows (`this path fires from /register (fail-closed → 503) AND /check (fail-open → 200) so the human-readable message stays disposition-neutral...`) is correctly anchored on route handler paths and structured-field rationale — only the `Round-3 hold item #4:` prefix is rot.

   Convention-enforcing-fix per `convention-enforcing-fix-must-audit-its-own-new-code-2026-05-17.md`: round-4 was itself a convention-enforcing fix (trimming a message because the structured-field rationale belongs in code comments, not log text). The same edit should have audited the comment above for similar rot — exactly the failure mode the convention exists to prevent.

   Fix: drop the `Round-3 hold item #4: ` prefix (3 words including trailing space). Behavioral framing below is preserved unchanged. ~1 LOC delta.

### Items dismissed during architect triage

- **(project-standards: comment block content unchanged this round; emdash + staging + Co-Authored-By + zone all clean)** Verified.

### Architect followups (no implementer action — already resolved or carry-forward)

- **A1.** `/ce-compound` candidate for "deliberately remove a defaulted optional to force explicit-labeling at every call site" pattern. Architect discretion at archive.
- **A2/A3.** "Read-then-write races on HAF-backed routes" + "Redis advisory lock with Lua CAS release on per-acquisition nonce" convention docs already exist; no new work needed.
- Pre-existing architect-zone followups from round-2/3/4 stand.

### Re-review signal

When item 1 lands in a single round-5 commit, `git mv` this file back to `tasks/review/`. The mv itself is the re-review signal. Diff is ~1 LOC (3 words removed); round-5 should converge clean and the task archives.

---

## Backend re-review signal (2026-05-20, round-5 hold-fix)

Round-5 item 1 landed. `backend/src/routes/bridge.ts:276` — dropped the `Round-3 hold item #4: ` prefix (4 words including trailing space) from the inline comment block above `checkExistingBridge`'s HAF-failure `logger.warn`. Behavioral framing below (route field carries the fail-open vs. fail-closed disposition; this path fires from /register fail-closed → 503 AND /check fail-open → 200; operator dashboards key on structured fields, not message text) preserved unchanged.

Comment block was re-flowed to fill the same width after the prefix drop; the comment is now 5 lines instead of 5 lines (same span). No behavioral or structural code change.

Scoped vitest (`bridge-haf-lag-locks.test.ts` + `bridge.test.ts` + `bridge-paper-author-gate.test.ts`): 33 specs green. `npm run typecheck` carries a pre-existing failure at `tests/support/argon2-error-mocks.ts:178` (`isRetriableHafError` missing from `dbStubFactory`) that is documented as round-2 hold item 2 of `backend-fetch-paper-detail-haf-error-vs-not-found` and round-3 hold item 1 of `backend-haf-outage-translation-audit-across-routes` — unrelated to this 1-LOC comment edit (bridge.ts → argon2-error-mocks.ts is a non-existent dependency). `npm run lint` clean for this change (preexisting `seed-phrase.ts` / `author-supersession.ts` warnings unchanged).