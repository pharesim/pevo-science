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
