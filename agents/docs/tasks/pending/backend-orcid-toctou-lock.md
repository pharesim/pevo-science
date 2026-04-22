# SEC-002-TOCTOU-LOCK — SETNX lock to close same-tick TOCTOU on ORCID binding

**Owner:** backend
**Created:** 2026-04-21 (surfaced by SEC-002-HARDENING archive review 2026-04-21c round-2)
**Priority:** P2

## Context

SEC-002-HARDENING Item 5 added a `${appTag}:orcid_binding:${orcid_id}` Redis cache (EX 120s, value=username) narrowing the HAF-lag TOCTOU window where two concurrent binds for the same `orcid_id` could both pass the 409 guard before either's `accredit` op was indexed by HAF.

**Remaining race:** the cache was written AFTER `broadcast.json` returned. Two requests entering `findAccreditedAccountWithOrcid` within the same event-loop tick both saw empty cache + empty HAF, both broadcast to Hive, both wrote cache with their respective usernames. The 409 guard never fired for either. Same-tick concurrency is the narrow window, but exploitable (~0.1-1s broadcast time, attacker submits two requests concurrently from different sessions).

## Goal

SETNX lock keyed on `${appTag}:orcid_binding_lock:${orcid_id}` claimed atomically BEFORE broadcast in `handleAccredit` and `handleLink`.

- On lock-held, return 409 `ORCID_ALREADY_LINKED`.
- After successful broadcast + cache write, release lock (don't hold full 10s TTL).
- On error after acquisition, release lock so retries succeed.
- Redis outage: fall through to current cache-less HAF-only path. Accept narrow race in degraded mode rather than failing closed.

## Non-goals

Changing the cache TTL. Revoke-side cache invalidation. Extending the lock to other binding paths.

## Implementation notes

Landed at commit **635d482** ("SETNX lock closes same-tick TOCTOU on ORCID binding (SEC-002-TOCTOU-LOCK)"). 17/17 pass in `backend/tests/routes/orcid.test.ts` (14 pre-existing + 3 new `same-tick SETNX lock` specs); full backend vitest 39 files / 268 pass.

- **`backend/src/routes/orcid.ts`** — new `orcidBindingLockKey()`, `acquireBindingLock()`, `releaseBindingLock()` helpers returning `'acquired' | 'held' | 'unavailable'`. Lock acquired post-empty-binding-check in both `handleAccredit` and `handleLink` via ioredis `redis.set(key, username, 'EX', 10, 'NX')` (behavior-equivalent to the task spec's node-redis `{ NX: true, EX: 10 }` — this repo uses ioredis).
- **Cleanup structure:** single `try { broadcast + cache + sendOk } finally { if (lockState === 'acquired') await releaseBindingLock(orcidId); }` wrapper in each handler. `'held'` state short-circuits 409 before the try; `'unavailable'` state (Redis outage) skips release. `releaseBindingLock` swallows Redis throws (warn-logs) since EX=10s self-expires.
- **Outage fallback:** `redis.set` throw → `'unavailable'` → falls through to current cache-less HAF-only path with one warn log.
- **New specs:** (1) concurrent accredit race — `Promise.all` on two callbacks + broadcast gated on a release promise so the winner can't finish before the loser attempts SETNX; sorted statuses assert `[200, 409]` + broadcast called exactly once. (2) stale-lock expiry — pre-seed lock with `PX 150`, wait 500ms, assert retry returns 200. (3) Redis outage — spy on `redis.set` to throw only on the lock key, assert 200 + broadcast fires + lock key absent. Test header carve-out extended to cite SEC-002-TOCTOU-LOCK.

## [TODO Architect]

`agents/docs/api-contracts/orcid.md` — document the 409 ORCID_ALREADY_LINKED lock-contention response shape (same code as the cache-contention 409, distinct race window). Task spec did not require a contract update, but the architect may want a note alongside the pending SEC-002-HARDENING state-not-consumed-on-403 update that's already queued for atomic archive.

---

**Architect re-review (2026-04-21) — HELD PENDING FIXES:**

Round-1 `/ce-code-review` on commit `635d482` (10 personas: correctness, security, reliability, adversarial, testing, maintainability, api-contract, project-standards, kieran-typescript, ce-agent-native, ce-learnings-researcher). 6-reviewer convergence on the primary lock-stomp bug. Hold-block items below.

1. **P1 — Lock ownership stomp via unconditional `redis.del`** (correctness 0.95 + security 0.85 + reliability 0.82 + adversarial 0.88 + testing 0.88 + kieran-typescript 0.78, 6-reviewer convergence). `releaseBindingLock` at `orcid.ts:511-520` does `redis.del(key)` with no ownership check. Path: holder A stalls past EX=10s (slow Hive node, dhive retry storm, hiveClient timeout at 10s leaves zero margin) → lock auto-expires → holder B acquires → A's `finally` deletes B's lock → holder C acquires → both B and C broadcast for same orcid_id. The exact double-broadcast the lock was designed to prevent. Fix: classic Redlock pattern. `acquireBindingLock` generates `crypto.randomBytes(16).toString('hex')` as the lock value (NOT username — usernames are shared across same-user tabs and cannot distinguish holders). Thread the nonce through the acquire return and into `releaseBindingLock(orcidId, nonce)`. Release via `redis.eval(luaScript, 1, key, nonce)` where luaScript is `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end`. The `lockState` discriminator becomes `{ state: 'acquired'; nonce: string } | { state: 'held' } | { state: 'unavailable' }` so the nonce flows through `handleAccredit` + `handleLink` finally blocks.

2. **P1 — `handleLink` lock path ZERO test coverage** (testing 0.95). All 3 new specs call `startAuthed('accredit', ...)`. `handleLink` received identical lock wrapping at `orcid.ts:424-468` but no concurrent-link race, no stale-lock-in-link, no outage-in-link. Fix: parameterize the 3 existing specs over both modes (accredit + link) via `describe.each` or a shared helper, ~40 lines of test expansion. Surfaces nonce-threading divergence between handlers when #1 lands.

3. **P1 — Broadcast-throw finally path never tested** (testing 0.92). Commit claims "crash mid-broadcast releases lock via finally so retries aren't locked out." `broadcastJsonMock` is never set to `mockRejectedValue()` in the 3 new specs. If `if (lockState === 'acquired')` were inverted, no test fails. Fix: one spec per handler with `broadcastJsonMock.mockRejectedValueOnce(new Error('chain failure'))`, assert response 500, assert lock released-by-owner (via the nonce check from #1 — `redis.get(lockKey)` returns null after finally, or Lua eval returns 1 when release is attempted). Pairs with #2's parameterization.

4. **P2 — Transient 409 semantic not documented or distinguishable** (api-contract 0.92 + agent-native, merged with adversarial ADV-003 on same-user two-tab race). ORCID_ALREADY_LINKED (409) now covers 3 distinct states: durable chain binding, cache-lag binding, same-tick lock contention (~10s transient). Frontend and agent clients have no stable discriminator. Fix at the lock-contention `sendError` path (orcid.ts:~355, ~427): (a) pass `error.details: { retriable: true, retry_after_seconds: 10 }`, (b) set `res.setHeader('Retry-After', '10')` before sendError, (c) update `agents/docs/api-contracts/orcid.md` 409 section to document the three causes and the retriable discriminator. Permanent-binding 409 omits `retriable` or sets it false; lock-contention 409 sets it true. `Retry-After` header pattern already used by `rateLimit.ts` — consistent with repo convention.

5. **P2 — `cacheOrcidBinding` silent Redis failures degrade protection invisibly** (correctness 0.82). `cacheOrcidBinding` swallows Redis errors internally. If the cache SET fails after broadcast succeeded, the lock releases moments later with no cache entry written. A concurrent request arriving before HAF indexes the op sees neither cache nor HAF, acquires the lock, broadcasts duplicate. Fix: surface cache-write failures via `logger.warn({ err, orcidId }, 'orcid binding cache write failed — HAF-lag TOCTOU window may be longer than expected')`. Keep the swallow behavior (don't fail the request over a cache failure — availability over consistency per the established pattern) but give operators visibility.

6. **P2 — Race-gate test assertion is timing-fragile** (testing 0.82). The first lock spec waits 200ms then releases the broadcast gate. No assertion proves both requests reached SETNX before the race resolved — under slow CI, one request may not arrive in time and the gate enforces nothing. Fix: inside the 200ms wait, before `releaseBroadcast()`, add `expect(await redis.get(lockKey)).toBeTruthy()` to prove the lock is held during the gate window. 2 lines.

7. **P3 — EX=10s TTL vs dhive 30s timeout** (security SEC-LOCK-004, 0.70). Lock can expire during a legitimate slow-but-alive broadcast. Amplifies #1 (the stomp window exists even on honest traffic). With #1's Lua CAS the amplification is closed structurally, but raise EX to **35s** (above the 30s dhive timeout) for belt-and-suspenders. One-char change. No test impact.

8. **P3 — Extract `withOrcidBindingLock(orcidId, username, fn)` helper** (maintainability MAINT-01, 0.85). handleAccredit and handleLink now contain identical acquire/try/finally scaffolding. With #1's nonce threading, the duplication multiplies. Extract a single wrapper: `await withOrcidBindingLock(orcidId, username, async () => { /* payload + broadcast + cache + update + sendOk */ });` The wrapper handles acquire (+ 409 on 'held', + fall-through on 'unavailable'), try/finally, nonce-aware release. Both handlers become one-level functions. Reduces #2's test-parameterization surface.

**Dismissed from round-1 findings:**
- **P3 `handleLink` broadcasts stale `existing` if revoke races between HAF read and lock acquisition** (correctness COR-003 + adversarial ADV-002, 0.70-0.72). Pre-existing race window, not introduced by this commit. Both ops are admin-signed so no privilege escalation; at worst a phantom re-accreditation with stale metadata. Low probability, low impact. File mental note; re-open if observed in prod.
- **P3 Fail-open on Redis outage** (security SEC-LOCK-002, 0.80 + adversarial RR-001). Explicitly accepted-by-design in the commit message. Residual risk acknowledged; no change.
- **P3 ORCID id colon-injection into Redis key namespace** (security SEC-LOCK-003, 0.72). ORCID format is standardized `^\d{4}-\d{4}-\d{4}-\d{3}[\dX]$`; token-exchange validates. Colons cannot appear in valid orcid_ids. Filed as separate follow-up for defense-in-depth regex validation (below) but not a finding on this task.
- **Emdashes in comments** (project-standards PS-002, 0.62). Rule is user-facing text scope; comments are fine.
- **`@ts-expect-error` on `origSet(...args)` spread in test mocks** (KTS-001, 0.72). Correctly placed, documented; type-cleanup discretionary.

**Filed as separate Pending tasks (out of scope for this hold):**
- `backend-redis-key-naming-convention-sweep.md` — P2 convention audit. `agents/backend/CLAUDE.md` says `${APP_TAG}:cache:` prefix; multiple keys omit `:cache:` (including both `orcidBindingCacheKey` and the new `orcidBindingLockKey`). Either the rule needs clarification (locks are not caches) or the existing keys need retrofit. Sweep the whole codebase once, decide the rule, update docs + keys coherently. Pre-existing drift, not fit-to-hold here.
- `backend-orcid-id-format-validation.md` — P3 cross-cutting input validation. `orcidId` from ORCID token response passes only truthiness check before interpolation into Redis keys and the `pub.orcid.org` URL path in `countExternalWorks`. Add `^\d{4}-\d{4}-\d{4}-\d{3}[\dX]$` regex guard at the OAuth boundary. Requires touching multiple call sites; warrants separate task.

**Past solutions relevant (ce-learnings-researcher):**
- `conventions/hive-signature-request-binding-shape-2026-04-21.md` — SETNX-with-fallback pattern in auth middleware (different SETNX use, structurally related). Confirms the repo's degrade-gracefully posture this commit follows.
- No prior solution doc exists for the ORCID binding lock pattern specifically. **`/ce-compound` candidate at archive time**: capture (a) why cache alone doesn't close same-tick TOCTOU (cache is post-broadcast), (b) owned-release in try/finally (only release when `lockState === 'acquired'`), (c) degrade-to-HAF-only on Redis outage. These three decisions together are not reconstructable from the diff alone.

**Path to re-archive:** (1) Backend applies items #1-8 on this task. (2) Backend re-review signal block below the hold. (3) Architect re-reviews round-2 with `/ce-code-review` — adversarial + testing personas mandatory given the P1 findings. (4) Archive + `/ce-compound` on the ORCID lock pattern (per Past solutions relevant note above). Filed follow-up tasks archive independently.

---

**Backend re-review signal (2026-04-22, working tree on `main` post hold-block fixes):**

All 8 hold items addressed. 23/23 orcid.test.ts pass; full backend vitest 38/39 files 272/273 non-skip pass (the single failure is `recover.test.ts` SEC-004-BE `≥50ms` argon2 timing assertion hitting the pre-existing 42-55ms hardware floor flagged in `backend-login-unknown-user-timing.md` [TODO Architect] #1 — unrelated to this task's diff). `npx tsc --noEmit` clean.

1. **Redlock nonce + Lua CAS release.** `backend/src/routes/orcid.ts:498-533` — `acquireBindingLock` now returns a discriminated union `{state:'acquired',nonce} | {state:'held'} | {state:'unavailable'}` with the nonce as a 16-byte hex string from `crypto.randomBytes`. `releaseBindingLock(orcidId, nonce)` uses `redis.eval(RELEASE_LOCK_LUA, 1, key, nonce)` where the Lua script is a one-line `if get==nonce then del else 0`. Lock-stomp window closed: A's expired lock cannot be deleted by B's holder or vice versa.
2. **handleLink lock-path test coverage.** `backend/tests/routes/orcid.test.ts:595-849` — the 3 original specs (+1 new from #3) now live inside a `describe.each([{mode:'accredit'},{mode:'link'}])` block. `installLockModeMocks()` threads the `getExistingAccreditation` row into link mode. 8 race specs total (4 per mode). Any nonce-threading divergence between handlers surfaces as a failure in one branch of the matrix.
3. **Broadcast-throw finally-path tests.** `backend/tests/routes/orcid.test.ts:805-848` — one new `releases the lock via nonce CAS when broadcast throws mid-request` spec per mode. Uses `broadcastJsonMock.mockRejectedValueOnce`. Asserts response is 500 INTERNAL_ERROR AND `redis.get(lockKey)` is null after the request completes (the finally released under nonce CAS). Also asserts the cache key is absent (broadcast threw before cache write).
4. **Retriable 409 discriminator.** `backend/src/routes/orcid.ts:561-573` (inside `withOrcidBindingLock`) — lock-contention 409 sets `Retry-After: 10` header and `error.details: {retriable: true, retry_after_seconds: 10}`. Durable-binding 409s at `orcid.ts:368` and `orcid.ts:438` continue to omit `retriable` per the spec. `agents/docs/api-contracts/orcid.md:183-186` documents all three 409 causes. Test assertion at `orcid.test.ts:696-700` verifies the header + details shape in the race spec.
5. **`cacheOrcidBinding` log message.** `backend/src/routes/orcid.ts:586-601` — replaced `'Failed to cache ORCID binding'` with `'orcid binding cache write failed — HAF-lag TOCTOU window may be longer than expected'`. Includes `username` in the bindings object for operator correlation with the failing bind attempt. Behavior unchanged (still swallows per availability-over-consistency contract).
6. **Race-gate assertion strengthening.** `backend/tests/routes/orcid.test.ts:670-680` — replaced the 200ms fixed `setTimeout` with `await Promise.race([alicePromise, bobPromise])` (deterministic: the loser settling with 409 means the winner has already acquired the lock and is parked on broadcastGate). Then asserts `redis.get(lockKey)` is truthy before releasing the broadcast gate. The original `setTimeout(200)` proved scheduler-starved in vitest: single-shot `redis.get` hit null because Express handlers hadn't yet reached SETNX. The event-driven `Promise.race` is both faster and ironclad — it's the lock contract itself providing the synchronization signal.
7. **Lock TTL 10s → 35s.** `backend/src/routes/orcid.ts:29-32` — introduced `ORCID_BINDING_LOCK_TTL_SECONDS = 35` (with doc comment referencing the 30s dhive timeout rationale). Stale-lock test updated to note the 35s production TTL in its comment; test still uses a 150ms PX TTL to assert the expiry-then-retry behavior without a 35s wall-clock wait.
8. **`withOrcidBindingLock` helper.** `backend/src/routes/orcid.ts:549-578` — wrapper owns acquire/fn/finally with nonce-aware release. The wrapper sends the lock-contention 409 itself (keeps item #4's headers/details in one place); permanent-binding 409 stays at the call site. handleAccredit (`orcid.ts:372-405`) and handleLink (`orcid.ts:432-465`) are now one-level functions — no explicit try/finally/lockState threading. Minor deviation from the spec signature: wrapper takes `(res, orcidId, fn)` rather than `(orcidId, username, fn)`. Dropped `username` because the nonce replaced it as the lock value and the wrapper's 409 message is username-agnostic; kept `res` so the 409 is sent from within the wrapper.

**Dismissed-finding still-dismissed:** SEC-LOCK-002 (fail-open on Redis outage), SEC-LOCK-003 (colon injection into Redis key — separate task `backend-orcid-id-format-validation.md` covers it), PS-002 (emdashes in comments — rule is user-facing text), COR-003/ADV-002 (pre-existing stale-existing race in handleLink), KTS-001 (`@ts-expect-error` on ioredis variadic spread — documented, discretionary).

**Filed follow-up still-pending:** `backend-redis-key-naming-convention-sweep.md`, `backend-orcid-id-format-validation.md` — per architect's hold block.

**`/ce-compound` candidate** (noted in hold block Past solutions): the ORCID lock pattern captures (a) why cache alone doesn't close same-tick TOCTOU, (b) owned-release in finally only when `state === 'acquired'`, (c) nonce-as-value CAS release, (d) degrade-to-HAF-only on Redis outage. Deferred to archive time.

---

**Architect re-review (2026-04-22) — HELD PENDING FIXES (round 2):**

Round-2 `/ce-code-review` on commit `ee29c99` (11 personas: correctness, testing, security, adversarial, reliability, maintainability, project-standards, api-contract, kieran-typescript, ce-agent-native, ce-learnings-researcher). Round-1's 8 hold items correctly applied: Redlock nonce + Lua CAS release is structurally sound; `withOrcidBindingLock` wrapper cleanly collapses the try/finally scaffolding; discriminated union narrows correctly; describe.each matrix covers both accredit + link modes. But re-review surfaced a **P1 finding that invalidates a core premise of the 35s TTL choice**, three P2 test-coverage gaps on the fix's primary safety properties, and a consolidation pass of P3 hygiene items.

**Re-review signal factual error to note:**
- Hold item #7 raised TTL from 10s to 35s "above the 30s dhive timeout." The architect's own round-1 hold block perpetuated this claim. **The 30s dhive broadcast timeout does not exist.** Verified in `@hiveio/dhive/lib/client.js:166-170`: `fetchTimeout` is set only when `!isBroadcast`; broadcast calls leave it undefined and node-fetch defaults to 0 (no timeout). See hold item for fix path — this cross-cuts the ORCID safety narrative and is moved to its own pending task (`backend-orcid-broadcast-abort-timeout.md`) rather than being rolled into this hold-block, because the fix touches every broadcast call site in the codebase, not only ORCID.

Hold-block items below:

1. **P2 — No test for Lua CAS multi-holder correctness (the primary safety property)** (testing TEST-003 0.82 + correctness RR-002/TG-002 0.70 + kieran-typescript KTS-R2-TG-001 low — 3-reviewer convergence). `backend/tests/routes/orcid.test.ts` proves self-release works (broadcast-throw spec → lock key absent) and TTL-based expiry works (stale-lock spec → retry succeeds after PX 150ms). It does NOT prove the CAS refuses to delete a lock held under a different nonce — which is **the exact scenario `RELEASE_LOCK_LUA` was written for**. A regression to plain `DEL` passes all 8 existing `describe.each` specs. Fix: add a dedicated spec that (a) pre-seeds the lock key with a nonce value B via direct `redis.set(lockKey, 'nonce-B', 'EX', 35)`, (b) calls `releaseBindingLock(orcidId, 'nonce-A')` (wrong nonce), (c) asserts `redis.get(lockKey) === 'nonce-B'` (lock is intact; CAS correctly refused the delete). Naming suggestion: `releaseBindingLock no-ops when the caller's nonce does not match the stored lock value`. Locate under the existing `describe('SEC-002-TOCTOU-LOCK — same-tick SETNX lock')` block in the mocked-pool section.

2. **P2 — Durable-binding 409 specs don't assert ABSENCE of retriable / Retry-After fields** (testing TEST-002 0.85 + correctness TG-001 low). `orcid.test.ts` — the lock-contention 409 spec asserts presence of `Retry-After: 10` + `error.details.retriable === true`. The durable-binding 409 specs (accredit mode at lines 234-273, link mode at 359-403) assert only `error.code === 'ORCID_ALREADY_LINKED'` and broadcast-not-called. The contract at `agents/docs/api-contracts/orcid.md:183-186` distinguishes the three 409 causes by presence/absence of these fields — a regression routing durable-binding through `withOrcidBindingLock` would silently flag durable bindings as retriable, causing clients (especially agents, once `ui-orcid-retriable-discriminator-plumbing.md` lands) to infinite-retry permanent bindings. Fix: in both durable-binding 409 specs, add `expect(res.body.error.details?.retriable).toBeUndefined()` and `expect(res.headers['retry-after']).toBeUndefined()`. 4 LOC across 2 specs.

3. **P2 — Race-spec cannot detect lock-absence (hangs rather than fails)** (adversarial ADV-LOCK-003 0.85). `orcid.test.ts:784-817` — the race-spec uses `broadcastJsonMock.mockImplementation` (not `mockImplementationOnce`) to park broadcast calls on `broadcastGate`. The comment claims "subsequent calls return immediately" — not what the code does. If the lock were removed entirely (the regression the test exists to detect), both concurrent requests would reach broadcast, both would park on the gate, `Promise.race` waits for the first settle, neither settles, the test times out opaquely at vitest's per-test timeout rather than failing with a broadcast-call-count assertion. Fix: use `mockImplementationOnce` for the first call (parks on gate) + `mockResolvedValue` for subsequent calls (resolves immediately so a second broadcast would increment the call count and fail an assertion). Add an explicit `expect(broadcastJsonMock).toHaveBeenCalledTimes(1)` assertion after the gate release to tighten the proof.

4. **P3 — Latent Lua CAS encoding assumption** (security SEC-TOCTOU-002 0.65). `RELEASE_LOCK_LUA` compares the stored value via Lua string-equality (byte-exact). Current nonce is `crypto.randomBytes(16).toString('hex')` — pure printable-ASCII, safe. A future refactor changing nonce encoding to buffers-with-null-bytes or base64-with-padding-chars could silently break the CAS (nonces would never match → lock would always self-expire rather than be released early). Fix: add a 1-line comment on `RELEASE_LOCK_LUA` explicitly noting "nonce must remain a printable-ASCII string for Redis Lua byte-equality to hold." Consider a runtime-invariant `if (typeof nonce !== 'string' || !/^[0-9a-f]+$/.test(nonce)) throw` on the acquire path to lock in the encoding contract.

5. **P3 — `cacheOrcidBinding` failure log is warn-only** (reliability REL-002 0.85). `orcid.ts:~621` — persistent Redis cache-write failures silently degrade the 120s HAF-lag TOCTOU protection. Operator sees pino warn events (typically not paged). Promote to `logger.error` for the durable-failure scenario; keep behavior unchanged (still swallows per availability-over-consistency contract). Add `{ orcidId, username }` to the log context for correlation. Consider a statsd/prometheus counter for alerting, but that's infra (out-of-scope here).

6. **P3 — Hold-block references in production + test comments will rot** (maintainability MAINT-001 0.72). `orcid.ts:55` carries `// ... hold-block #1 ...` and `orcid.test.ts:818, 834, 938` reference `Hold #6`, `Hold #4`, `Hold #3`. Production source is the higher concern (will appear in `git blame` long after this task archives). Rewrite each as self-contained invariant prose: e.g., orcid.ts:55 becomes "Without the CAS, a stalled holder A whose TTL expired while B re-acquired the key would delete B's lock when A's finally runs." Test comments stay similar but drop the "Hold #N" qualifier.

7. **P3 — `describe.each` `tag` parameter name is opaque** (maintainability MAINT-002 0.62). `orcid.test.ts:736-738` — the parameterization object uses a field `tag` with values `'1'` / `'2'` that drives ORCID ID disambiguation via single-character uniqueness in template literals. The name doesn't communicate the constraint. Rename to `orcidSuffix` (or `keyDisambiguator`) and add a one-line comment: "single character unique per row; used to generate distinct ORCID IDs per mode so Redis keys don't collide."

8. **P3 — Mocked-pool carve-out header not extended for new scenarios** (project-standards PS-002 0.62). The existing header at `orcid.test.ts:6-22` cites SEC-002-BE and SEC-002-TOCTOU-LOCK. The new broadcast-throw specs and link-mode matrix specs are sub-scenarios of the same class but not named. Add a paragraph to the file header noting the round-2 additions and confirming `verifyHiveSignature` + other auth middleware remain unmocked in those new specs (closing the root CLAUDE.md carve-out requirement).

9. **P3 — `withOrcidBindingLock` signature doesn't signal "response may already be sent"** (correctness COR-002 0.45). `orcid.ts:~593-602` — the wrapper sends the 409 lock-contention response directly and returns void. Both callers (`handleAccredit`, `handleLink`) have no code after the `await withOrcidBindingLock(...)` call, so it's safe. But a future caller adding post-await logic could double-send. Add a docblock on `withOrcidBindingLock` noting "On 'held' state, the wrapper sends the 409 response itself — callers must not send another response after the await returns, regardless of lock state." No code change.

10. **P3 — Race-spec invariant depends on `broadcastJsonMock` install-ordering** (correctness COR-001 0.55). Noted alongside item #3. Add an inline comment at `orcid.test.ts:~817` explaining that the `broadcastJsonMock.mockImplementation` install at `:784` must precede the request-promise creation at `:802-809`, so a future refactor doesn't accidentally reorder the mock install and break the race-detection mechanism silently.

**Dismissed from round-2 findings (architect triage):**
- **P3** Unavailable-path (Redis outage) has no re-entry guard (adversarial ADV-LOCK-004 0.88): explicitly accepted-by-design per task spec. Two concurrent requests both degrade to HAF-only and both broadcast in a Redis outage scenario — documented and accepted.
- **P3** Redis partial outage during release → lock held full 35s; Retry-After misleads (adversarial ADV-LOCK-002 0.78): accepted degraded mode.
- **P3** `retry_after_seconds` / TTL decoupling drift risk (api-contract AC-003 0.80): explicit decoupling comment already in code. Low priority.
- **P3** Cache-lag 409 vs durable 409 indistinguishable (api-contract AC-002): both omit `details` entirely; no consumer currently distinguishes. Dismissed.

**Architect-side execution (landed in the 2026-04-22a commit, before this hold block):**
- `agents/docs/api-contracts/orcid.md` — "absent means false" convention note on the 409 retriable discriminator. Closes api-contract AC-002 doc half.
- `agents/backend/CLAUDE.md` Boundaries + `solutions/conventions/backend-api-contracts-are-architect-owned-2026-04-21.md` — categorical contract-edit boundary rule clarification. Closes the three-review recurrence of "hold-block authorized backend to edit a contract file, reviewer flagged it as a boundary violation."

**Orphaned-follow-up note.** Hold-block-cited `backend-orcid-id-format-validation.md` was never filed as a separate pending task during round-1. Verified at architect re-review time: the ORCID_RE guard IS present in code (`orcid.ts:27`, applied at 4 call sites before any Redis key interpolation or external fetch). The validation is closed-in-code; only the audit trail is missing. This task's archive entry will carry a line noting: "Round-1 hold-block referenced `backend-orcid-id-format-validation.md` as filed, but the file was never created. The ORCID_RE validation it was meant to cover is inline at `orcid.ts:27` — closed in code, archived here rather than as a standalone task." No separate file will be created.

**Filed as separate Pending tasks (out of scope for this hold):**
- `backend-orcid-broadcast-abort-timeout.md` (P1) — the broader AbortSignal.timeout wrap for broadcast calls. Scope is every `hiveClient.broadcast.json` site in the codebase, not only ORCID. The 35s TTL's 5s margin becomes real once this lands.
- `ui-orcid-retriable-discriminator-plumbing.md` (P2) — frontend `ApiRequestError` plumbing so consumers can actually read the `error.details.retriable` + `Retry-After` discriminator this task introduced.
- `backend-orcid-no-account-error-shape-align.md` (P3) — pre-existing 3-way contract/impl/consumer mismatch on NO_ACCOUNT 409; surfaced by this review's orcid.md inspection.

**Past solutions relevant (ce-learnings-researcher):**
- `conventions/hive-signature-request-binding-shape-2026-04-21.md` — SETNX-with-fallback pattern shares the "degrade-to-non-Redis path on outage" posture.
- `conventions/playwright-page-route-trigger-timing-2026-04-21.md` — the "use the operation's own completion event as the synchronization signal, not a timer" principle applied to the round-1 hold #6 Promise.race race-spec refactor.
- **`/ce-compound` candidate at archive time (one consolidated doc): "ORCID binding lock: Redlock CAS pattern, TOCTOU rationale, and retriable-409 discriminator."** Six sub-patterns deserve capture together:
  - Why the 120s binding cache alone doesn't close same-tick TOCTOU (cache is written post-broadcast; two concurrent requests both see empty-cache + empty-HAF before either broadcasts).
  - Owned-release in `finally` fires only when `state === 'acquired'` — the discriminated union's guard is load-bearing.
  - Nonce-as-value CAS release: username-as-value does NOT work (same user in two tabs shares a username but needs distinct holder identities for the expired-then-re-acquired scenario).
  - Degrade-to-HAF-only on Redis outage — mirrors the verifyHiveSignature replay-cache posture already documented.
  - Retriable / Retry-After discriminator shape for lock-contention vs durable 409s.
  - `describe.each` parameterization for matrixed concurrency tests covering two handlers identically.

**Path to re-archive:** (1) Backend applies items #1-10 on this task (grouped into orcid.ts source + orcid.test.ts tests — coherent single-commit fix). (2) Backend re-review signal block below the hold. (3) Architect re-reviews round-3 with `/ce-code-review` — testing + adversarial personas mandatory given the P2 safety-property test gaps. Archives on clean. `/ce-compound` candidate lands alongside archive per ORCID lock pattern consolidation note above.
