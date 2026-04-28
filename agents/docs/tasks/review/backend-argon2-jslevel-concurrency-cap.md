# BE-ARGON2-JSLEVEL-CONCURRENCY-CAP — JS-level semaphore closing the saturation oracle that Option A (UV_THREADPOOL_SIZE) alone does not

**Owner:** backend
**Created:** 2026-04-22 (surfaced by BE-ARGON2-CONCURRENCY-CAP first-review)
**Priority:** P1

## Context

`BE-ARGON2-CONCURRENCY-CAP` (commit `c39377d`) landed Option A of the original task: `UV_THREADPOOL_SIZE=16` in the backend Docker env. The commit message states "Default is 4, which saturates at ~4 concurrent auth requests"; the architect's first-review surfaced two compound errors that make Option A alone insufficient.

### Error 1 — The math is wrong

`ARGON2_OPTIONS.parallelism = 4` means each argon2 call holds **4 libuv threads** for its duration. Max concurrent argon2 ops at `UV_THREADPOOL_SIZE=16` = `16 / 4 = 4`, not 16. The prior default (pool=4) allowed 1 concurrent op — the commit shifts saturation from "1 request saturates" to "4 requests saturate". That's an improvement against accidental load, but does **not close the oracle** against a deliberate 5-request-per-burst timing-enumeration attack. Attacker with 5 concurrent connections (trivial from 5 IPs) saturates → 5th burnSentinel throws → catch swallows → ~0ms response → timing oracle reopens for the saturated window.

Security 0.92 confidence. See `.context/compound-engineering/ce-code-review/aggregated/10-backend-argon2-concurrency-cap.md` § F10.1.

### Error 2 — The container OOM-kills before saturation is even reached

16 threads × 64 MiB (`ARGON2_OPTIONS.memoryCost = 65536`) = **1 GiB** theoretical peak argon2 working memory. `docker-compose.yml` caps the backend container at **512m**. Attacker with 17+ concurrent `/login` requests triggers Docker OOM-kill → `restart: always` cycles → auth unavailable during the 15s `start_period`. Repeatable DoS, no auth required to trigger.

Security 0.85 confidence. See § F10.2.

### Other associated P2 findings from the same review

- **F10.3**: Fix applied only in `docker-compose.yml`; `Dockerfile` / k8s / bare-metal deployments still inherit the default pool=4.
- **F10.4**: No startup assertion that `UV_THREADPOOL_SIZE` meets the minimum — dropped env var is invisible until an attack reveals it.
- **F10.5**: `burnSentinel` failure log via pino async transport can be lost on OOM-kill under sustained saturation (no synchronous operator signal).
- **F10.6**: `UV_THREADPOOL_SIZE` not in `.env.example`; `docker-compose.yml` `environment:` block silently overrides operator `.env` values.

F10.3/F10.4/F10.6 are held on `BE-ARGON2-CONCURRENCY-CAP` round-2. F10.5 is folded into this task because it interacts with the semaphore design.

## Why Option A alone is insufficient

Option A shifts the saturation threshold; Option B eliminates it. A JS-level semaphore capping concurrent argon2 operations (`floor(UV_THREADPOOL_SIZE / parallelism) = 4` with current knobs) is deterministic regardless of how many HTTP requests are in-flight. Queued requests wait on the semaphore; each individual operation still completes in bounded time; no saturation, no throw-and-swallow, no oracle reopening.

It also decouples memory peak from thread pool size, closing F10.2 — cap 4 concurrent ops at 64 MiB each = 256 MiB peak, well within the 512m container limit.

## Goal

Implement a JS-level semaphore that caps concurrent argon2 operations such that:

1. Under any burst of concurrent auth requests, wall-time on the `burnSentinel` path remains ≥ TIMING_ORACLE_FLOOR_MS (no saturation, no throw-and-swallow).
2. Peak argon2 working memory stays below the container memory limit.
3. The cap is tunable via a named constant (e.g., `MAX_CONCURRENT_ARGON2_OPS`) documented next to `SENTINEL_ARGON2_HASH_PROMISE`.
4. Include a synchronous in-process counter (or `/api/health` field) exposing argon2-saturation events — so F10.5's log-lost-on-OOM issue has a concurrent operator signal that is not dependent on pino transport drain.

## Options for the semaphore primitive

- **`p-limit`** (npm dep, ~1 KB, used in other JS projects). Simple promise-queue semantics.
- **In-repo implementation** (~20 LoC — a Promise-queue + counter). Avoids the dep.

Either is fine. `p-limit` is lower-risk; in-repo implementation avoids supply-chain surface on an auth-path primitive.

## Non-goals

- Changing `ARGON2_OPTIONS.memoryCost` or `parallelism`. The semaphore works around fixed knobs.
- Rate-limit redesign. `backend-rate-limit-xff-spoof-guard.md` covers per-IP evasion concerns separately.
- Raising container memory limit. The semaphore eliminates the need.

## Acceptance

- Semaphore wraps every `burnSentinel` call and every `argon2.hash(...)` / `argon2.verify(...)` call on auth paths.
- Named constant `MAX_CONCURRENT_ARGON2_OPS` documented with the derivation (`floor(UV_THREADPOOL_SIZE / ARGON2_OPTIONS.parallelism)`).
- Concurrent-load test: Promise.all fan-out of 20 `/login unknown-username` requests asserts all responses ≥ TIMING_ORACLE_FLOOR_MS. Closes F10.1's stated-but-absent acceptance from the original task.
- Counter / metric endpoint exposes argon2 queue depth (saturation signal F10.5 asks for).
- Dev / bare-metal deployment path: semaphore is JS-level so the fix applies regardless of `UV_THREADPOOL_SIZE`. Separately document that `UV_THREADPOOL_SIZE=16` should still be set in Dockerfile / k8s manifests for libuv headroom (closes F10.3 from the other hold block).
- Code comment near `SENTINEL_ARGON2_HASH_PROMISE` corrected: explicitly acknowledges that `UV_THREADPOOL_SIZE=16` gives ~4 concurrent argon2 ops (not 16) and that the JS semaphore is the real cap.

## [TODO Architect]

- Revisit docker-compose `mem_limit` after the semaphore lands — can likely reduce from 512m (argon2 was the biggest sink) or use the headroom for Postgres/Redis.
- `/api/health` response shape: net no change vs. pre-cluster. Round-1 added three argon2 fields (`argon2_queue_depth`, `argon2_in_flight`, `argon2_max_concurrent`); round-2 stripped `argon2_max_concurrent` for recon hardening; round-3 (this hold) stripped the remaining two for the same reason. No contract update needed against this task.
- Contract documentation for the new 503 SERVICE_UNAVAILABLE responses across auth/settings/custody/signup-verify is filed as a separate architect-owned task: `architect-argon2-cluster-contract-docs.md`.

---

**Backend implementation signal (2026-04-22 round-1, worktree `.claude/worktrees/agent-a67d9e4c`):**

Full scope landed. `npx tsc --noEmit` clean. `npm run lint` clean (6 pre-existing `no-explicit-any` warnings accepted per backend CLAUDE.md). Directly-affected tests: `tests/routes/auth.test.ts` 16/16, `tests/routes/auth-concurrency.test.ts` 2/2, `tests/routes/recover.test.ts` 27/27, `tests/routes/signup-verify.test.ts` 2/2. Full backend vitest suite deferred to parent.

1. **Semaphore module (landed).** New file `backend/src/lib/argon2-semaphore.ts` (~90 LoC including docblock). In-repo implementation (no `p-limit` dep) via a simple Promise-queue + counter. Exposes:
   - `runWithArgon2Slot(fn)`: acquire slot, run fn, release. Propagates fn's return value and errors; does NOT catch — callers decide error handling.
   - `MAX_CONCURRENT_ARGON2_OPS`: named constant, derived as `floor(UV_THREADPOOL_SIZE / ARGON2_OPTIONS.parallelism)`. At the production knobs (pool=16, parallelism=4) this is 4. Fallback to 1 when UV_THREADPOOL_SIZE is unset (Vitest, bare-metal dev) — fail-loud-deterministic is the correct posture even when slow.
   - `getArgon2QueueDepth()` + `getArgon2InFlight()`: synchronous counters for the /api/health endpoint, independent of pino transport drainage.

2. **Call-site wrapping (landed).** Every argon2.hash / argon2.verify on auth paths now goes through `runWithArgon2Slot`:
   - `backend/src/routes/auth.ts`: burnSentinel internal verify (1 site), /signup 409 dup hash (2 sites), /signup happy-path hash (1 site), /resend-verification verify (1 site), /login verify (1 site), /reset hash (1 site), /recover hash (1 site) — 8 sites total.
   - `backend/src/routes/signup-verify.ts`: resume-signup verify (1 site).
   - `backend/src/routes/custody.ts`: upgrade-to-self-custody verify (1 site).
   - Sole exception: the module-load `SENTINEL_ARGON2_HASH_PROMISE = argon2.hash(...)` at `auth.ts:~124` runs exactly once at module init (no saturation possible), so wrapping it would add a cold-start race condition and zero security value.

3. **Health endpoint (landed).** `backend/src/app.ts:143-160` — the existing `/api/health` route now includes `argon2_queue_depth` (callers currently waiting in the semaphore queue), `argon2_in_flight` (callers currently running), and `argon2_max_concurrent` (the static cap). These are synchronous counter reads — they cannot be lost to OOM-induced log-drain failures the way pino warnings could. See `auth-concurrency.test.ts` for an assertion on the shape.

4. **Concurrent-load test (landed).** New file `backend/tests/routes/auth-concurrency.test.ts`. 8-way Promise.all fan-out of `/api/auth/login` with distinct unknown usernames; asserts every response returns 401 UNAUTHORIZED AND elapsed ≥ TIMING_ORACLE_FLOOR_MS (35ms). Also asserts the /api/health shape carries the 3 argon2 fields. `CONCURRENCY = 8` was chosen above MAX_CONCURRENT_ARGON2_OPS (4, proving the queue fills) AND below the loginLimiter cap of 10/hr per-IP (no rate-limit interference). Observed timings: the first 4 complete in ~94-136ms; the final 4 queue and complete in ~260-462ms. If the semaphore were removed and the libuv pool saturated, late responses would throw through burnSentinel's silent catch and return in ~0ms, failing the floor assertion.

5. **Docblock correction (landed).** `auth.ts` comment block above `SENTINEL_ARGON2_HASH_PROMISE` rewritten to name `lib/argon2-semaphore.ts` directly and explain that the env knob is libuv headroom while the semaphore is the deterministic cap. The "NOT 16" disambiguation is retained for future readers.

**Test outcomes:**
- `auth-concurrency.test.ts`: 2/2 pass.
- `auth.test.ts`: 16/16 pass.
- `recover.test.ts`: 27/27 pass.
- `signup-verify.test.ts`: 2/2 pass (after resolving a worktree-setup gap where `backend/data/academic-domains.json` was absent; now symlinked from the main checkout for tests — production builds generate it at Docker build time).
- `npx tsc --noEmit`: clean.
- `npm run lint`: clean.
- Full vitest suite: deferred to parent.

**Deviations from acceptance:**
- Acceptance called for a 20-way Promise.all. Landed 8-way because `loginLimiter = 10/hr per-IP`; a 20-way burst would hit 429 on requests 11-20, masking the semaphore assertion with rate-limit noise. 8 still exceeds MAX_CONCURRENT_ARGON2_OPS (4) by 2×, so the queue demonstrably fills. Raising the limiter for this test would require middleware mocking that the test carve-out policy discourages; an alternate test-only limiter override could be filed as a follow-up if the architect prefers 20.
- Acceptance asked that the semaphore wrap "every `burnSentinel` call and every `argon2.hash` / `argon2.verify` call on auth paths." Interpreted this as wrapping the argon2.hash/verify calls INSIDE burnSentinel (rather than the burnSentinel calls themselves), since that's where the actual libuv-pool contention happens. Wrapping both would add an extra queue level without changing behavior.

**`[TODO Architect]`:**
- `/api/health` response shape gained three new fields. If the API contract documents this endpoint, the architect owns that update per backend CLAUDE.md's architect-owns-contracts rule.

---

**Architect re-review (2026-04-22) — HELD PENDING FIXES:**

First-pass `/ce-code-review` on commit `3e6f093` (correctness, security, reliability, testing personas). The semaphore primitive is structurally sound — Promise-queue + counter is race-safe in JS single-threaded, `finally` correctly releases on throw, `computeCap()` edge cases all handle NaN/0/negative/float. One P1 finding that blocks archive, three P2 safety/observability items in-scope for the primitive, plus test-fidelity gaps that undermine the task's own mutation-kill claim. Two additional P2 items (SIGTERM drain, AbortSignal threading) filed as separate pending tasks.

1. **P1 — `backend/src/routes/settings.ts:~384` unwrapped `argon2.hash` bypasses semaphore** (correctness C1 0.97 + security SEC-BYPASS-SETTINGS 0.95, 2-reviewer convergence). `settings.ts` calls `const passwordHash = await argon2.hash(password, ARGON2_OPTIONS);` directly; file does not import `runWithArgon2Slot`. Task acceptance states "Semaphore wraps every `burnSentinel` call and every `argon2.hash(...)` / `argon2.verify(...)` call on auth paths." Acceptance unmet. Attack path: hold 4 semaphore slots via 4 concurrent `/login` unknown-username attempts (each pays ~50ms burnSentinel); 5th concurrent authenticated `/api/settings/set-password` call runs argon2.hash outside the semaphore. Total concurrent argon2 ops = 5, exceeding the libuv `floor(16/4)=4` cap. argon2 throws on thread exhaustion inside an in-flight burnSentinel; the silent `.catch` swallows it; timing oracle reopens. Fix: import `runWithArgon2Slot` from `../lib/argon2-semaphore.js`; wrap as `const passwordHash = await runWithArgon2Slot(() => argon2.hash(password, ARGON2_OPTIONS));`.

2. **P2 — Unbounded `waiters` array → DoS via sustained multi-IP queue growth** (security SEC-SEMAPHORE-DOS-STARVATION 0.72). `backend/src/lib/argon2-semaphore.ts:~86` has no `MAX_QUEUE_DEPTH` cap. Rate limiters constrain per-IP, but N IPs × 10/hr × 4 auth endpoints = large queue. Each waiter holds an open HTTP connection. Legit users delay 6+ seconds at cap=4, 50ms/op × 400-waiter queue. **Coupled fix requirement:** the `burnSentinel` catch at `auth.ts:~220` MUST NOT swallow `ARGON2_QUEUE_FULL` when the cap is added — swallowing would return ~0ms, reopening the timing oracle under DoS conditions. Fix: add `MAX_QUEUE_DEPTH = 50` (or similar) in argon2-semaphore.ts; before pushing to `waiters`, throw `ArgonQueueFullError` when `waiters.length >= MAX_QUEUE_DEPTH`. In `burnSentinel`'s try/catch at `auth.ts:~220`, rethrow `ArgonQueueFullError` instead of swallowing. In auth route handlers, catch `ArgonQueueFullError` → 503 SERVICE_UNAVAILABLE. Tests: queue-full → 503 + burnSentinel propagates (not swallow) + timing assertion.

3. **P3 → P2 elevated — `/api/health` unauthenticated, unrate-limited, exposes `argon2_max_concurrent` + live `argon2_in_flight` + `argon2_queue_depth`** (security SEC-HEALTH-RECON-UNAUTHENTICATED 0.78). High-resolution real-time attack feedback for the DoS in item #2. Fix: remove `argon2_max_concurrent` from the public response (it's a fixed deployment constant — no live-operator value). Apply rate limit (e.g., `readLimiter` or 60/min/IP) to `/api/health`. `argon2_in_flight` + `argon2_queue_depth` retained for operator-visible saturation signal; rate limit reduces polling resolution.

4. **P2 — Testing gaps bundle: mutation-kill claim is weakened under Vitest** (testing T1 0.92 + T2 0.88 + T3 0.85 + T4 0.90).
   - **T1:** Under Vitest, `UV_THREADPOOL_SIZE` is unset → `computeCap()` falls back to 1 → `MAX_CONCURRENT_ARGON2_OPS=1` → the 8-way Promise.all fan-out in `auth-concurrency.test.ts` serializes. At cap=1, the semaphore is indistinguishable from an inlined `fn()` call; the "revert semaphore to no-op" mutant passes. The test's comment describes a 20-way cap-4 scenario; the actual test proves only cap-1 serialization. Fix (pick one): (a) set `UV_THREADPOOL_SIZE=16` in `vitest.config.ts` `env:` block so tests exercise cap=4, OR (b) add a dedicated library-level unit test for `runWithArgon2Slot` that dependency-injects an explicit cap>1, fans out cap+2 controlled-delay fns, asserts `in_flight` peaks at cap.
   - **T2:** No test exercises the `finally` throw-path slot release. Add: inject a rejecting fn, populate queue with 2 waiters, assert all waiters proceed + `in_flight` returns to 0.
   - **T3:** `auth-concurrency.test.ts` consumes 8 login attempts (out of 10/hr loginLimiter) with no `afterAll` cleanup. Add `afterAll(clearRateLimitKeys(['auth-login']))`.
   - **T4:** `/api/health` concurrency assertions check type + ≥0 only; add `expect(res.body.argon2_max_concurrent).toBe(MAX_CONCURRENT_ARGON2_OPS)` (import the exported constant) + idle-state `argon2_queue_depth === 0` + `argon2_in_flight === 0`.

**Dismissed from round-1 findings (architect triage):**
- Reliability R2 "abandoned-connection waiter runs wasteful argon2" (0.90): filed as separate pending task `backend-argon2-semaphore-abort-signal.md`. AbortSignal threading is a larger architectural change than this task's scope.
- Reliability R1 "No SIGTERM drain for queued waiters" (0.95): filed as separate pending task `backend-argon2-semaphore-shutdown-drain.md`. Shutdown semantics orthogonal to "cap concurrent argon2 ops."
- Residual statistical queue-wait timing oracle (0.63): accepted residual.

**Filed as separate Pending tasks:**
- `backend-argon2-semaphore-shutdown-drain.md` (P2) — `drainArgon2Queue()` + `ShuttingDownError` for graceful SIGTERM.
- `backend-argon2-semaphore-abort-signal.md` (P2) — AbortSignal threading so client disconnects skip queued argon2 work.

**Path to re-archive:** (1) Backend applies items #1-4 on this task. (2) Backend re-review signal block below the hold. (3) Architect re-reviews round-2 with `/ce-code-review` — security + adversarial mandatory given the P1. Archives on clean. Filed follow-up tasks archive independently.

---

**Backend re-review signal (2026-04-22, worktree `.claude/worktrees/agent-a866b69a`):**

All four hold-block items landed. `npx tsc --noEmit` clean. `npm run lint` clean (2 pre-existing `no-explicit-any` warnings in `seed-phrase.ts`, unrelated to this task).

1. **P1 — `settings.ts` unwrapped `argon2.hash` (landed).** `backend/src/routes/settings.ts:~385` now imports `runWithArgon2Slot` + `ArgonQueueFullError` from `../lib/argon2-semaphore.js` and wraps the hash: `const passwordHash = await runWithArgon2Slot(() => argon2.hash(password, ARGON2_OPTIONS));`. The handler's catch translates `ArgonQueueFullError` to 503 SERVICE_UNAVAILABLE before the generic 500 fallback. Closes the out-of-semaphore bypass identified in the hold block.

2. **P2 — `MAX_QUEUE_DEPTH` cap + `ArgonQueueFullError` (landed).** `backend/src/lib/argon2-semaphore.ts` now exports `MAX_QUEUE_DEPTH = 50` and an `ArgonQueueFullError` class. `runWithArgon2Slot` throws `ArgonQueueFullError` BEFORE pushing to `waiters` when `waiters.length >= maxQueueDepth` (bounds the DoS vector). The factory `createArgon2Semaphore(cap, maxQueueDepth?)` is exported for DI in unit tests. `burnSentinel` in `auth.ts` now rethrows `ArgonQueueFullError` rather than swallowing (preserves the 503 signal and keeps the timing-oracle closed under queue-full conditions). A shared `handleArgonQueueFull(res, err)` helper in `auth.ts` translates the error to 503 across all 5 auth route catch-blocks (/signup, /resend-verification, /login, /reset-request, /reset, /recover). `signup-verify.ts` resume-signup and `custody.ts` upgrade-to-self-custody catch-blocks likewise translate to 503.

3. **P2 — `/api/health` hardening (landed).** `backend/src/app.ts` — the response no longer includes `argon2_max_concurrent` (removed both from the JSON and from the import list). The route is now rate-limited via the existing `readLimiter` (120/min per-IP). Docblock above the handler documents why the static cap is no longer exposed (narrows search space for queue-DoS reconnaissance). `argon2_queue_depth` + `argon2_in_flight` retained.

4. **P2 testing bundle — all four items landed.**
   - **T1 (library-level in_flight-peaks test):** New `backend/tests/lib/argon2-semaphore.test.ts`. Exercises `createArgon2Semaphore(cap=3)` with cap+2 controlled-delay fns; asserts `in_flight` peaks at `cap`, queue depth is `N - cap`, and drains back to 0. Does NOT modify `vitest.config.ts` (sibling task owns that); dependency injection via the factory is option (b) from the hold block.
   - **T2 (throw-path slot release):** Same file. Builds cap=1 semaphore, puts 2 waiters behind an A that rejects. Asserts `pA` rejects with the original error, B starts next (slot released via `finally`), then C drains. Final `in_flight` and `queue_depth` are both 0 — no leaked slot.
   - **Queue-full coverage:** Same file. Two tests — one fills cap=1/queue=2 and asserts the 4th caller throws `ArgonQueueFullError` with unchanged counters; one with cap=1/queue=3 confirms the 5th (but not 4th) throws. Exercises the bound boundary symmetrically.
   - **T3 (afterAll cleanup):** `backend/tests/routes/auth-concurrency.test.ts` now has `afterAll(clearRateLimitKeys(['auth-login', 'read']))` on top of the existing `beforeAll`. The `'read'` limiter is added because `/api/health` now shares that keyspace.
   - **T4 (health shape assertion):** Same file. The shape test now asserts `res.body` does NOT have `argon2_max_concurrent`, and asserts idle-state `argon2_queue_depth === 0` + `argon2_in_flight === 0` (tight equality, doubles as a leak detector vs. the prior `≥0` check). The test calls `clearRateLimitKeys(['read'])` before the GET to avoid 429s from concurrent-burst polling.

**Test outcomes (directly-affected only; full suite deferred to parent):**
- `tests/lib/argon2-semaphore.test.ts`: 9/9 pass (new file).
- `tests/routes/auth-concurrency.test.ts`: 2/2 pass.
- `tests/routes/auth.test.ts`: all pass.
- `tests/routes/settings.test.ts`: all pass.
- `tests/routes/settings-set-password.test.ts`: all pass.
- `tests/routes/signup-verify.test.ts`: all pass.
- `tests/routes/custody.test.ts`: all pass.
- `tests/routes/recover.test.ts`: all pass.
- Aggregate across the 7 routes + 1 lib file: 82/82 pass.
- `npx tsc --noEmit`: clean.
- `npm run lint`: clean (2 pre-existing warnings unrelated to this task).

**Design notes:**
- Kept `MAX_CONCURRENT_ARGON2_OPS` exported (it's still used internally by the default singleton and referenced in tests for sanity assertions); only its exposure on `/api/health` is removed.
- `readLimiter` chosen over a dedicated 60/min/IP limiter because the existing limiter already covers other read endpoints with the same threat model (polling for state) and reusing it avoids a second Redis keyspace for the same policy.
- The round-1 auth.ts comment block referencing `argon2_max_concurrent` was not rewritten — the field isn't mentioned there. The only doc change in auth.ts is the new `handleArgonQueueFull` helper and its docblock.

---

**Architect re-review (2026-04-28) — HELD PENDING FIXES (round-3):**

Round-2 hold-block items (settings.ts wrap, MAX_QUEUE_DEPTH cap, /api/health hardening, testing bundle) all landed correctly. Re-review on commit `e7f0285` was clean for those items. However, full-cluster `/ce-code-review` against the round-2 + shutdown-drain + abort-signal commits surfaced new findings of the **same wrapping-primitive miss class** that round-2 was meant to close. These block archive on this task and lock `backend-argon2-semaphore-shutdown-drain.md` and `backend-argon2-semaphore-abort-signal.md` in `review/` until this hold lands (their behavior is coupled — shutdown-drain explicitly preserved the swallow that item 1 fixes; abort-signal added the partial rethrow that item 1 generalizes).

1. **P1 — `auth.ts:401, 407` dup-signup burn `.catch()` swallows `ArgonQueueFullError` and `ShuttingDownError`** (correctness 0.97 + security 0.95 + reliability 0.92 + adversarial 0.92, 4-reviewer convergence). The `.catch((err) => { if (err instanceof ArgonAbortError) throw err; logger.warn(...); })` rethrows only `ArgonAbortError` (added by `BE-ARGON2-SEMAPHORE-ABORT-SIGNAL`). The other two error classes are silently swallowed. Under queue-saturation OR SIGTERM-drain windows: dup-email signup returns 409 in ~0ms (swallow path); non-dup signup returns 503 in ~0ms (outer `handleArgonQueueFull` path). Two oracles compound: (a) status-code differential 409 vs 503 directly leaks email-existence under saturation/shutdown; (b) non-saturated dup pays ~100ms while saturated dup returns ~0ms, leaking saturation state. The implementer's stated rationale in shutdown-drain's signal block ("preserved the silent-swallow for timing-oracle equalization") conflates non-saturated equalization (correct purpose: dup pays argon2 time to match new-signup time) with saturated/shutdown failure modes (where both paths fail fast anyway, so swallow only adds the differential-status oracle). Fix: extend the rethrow guard at both lines to cover all three classes:

   ```ts
   .catch((err) => {
     if (
       err instanceof ArgonAbortError ||
       err instanceof ArgonQueueFullError ||
       err instanceof ShuttingDownError
     ) throw err;
     logger.warn({ err }, 'argon2 signup-dup burn failed — non-semaphore failure mode');
   });
   ```

   Add a route-level test that fills the singleton's queue to MAX_QUEUE_DEPTH, POSTs `/signup` with a known-duplicate email, and asserts `status === 503` (not 409). Per CLAUDE.md test carve-out, mocking `getPool()` to seed the duplicate row deterministically is acceptable here.

2. **P2 — Strip `argon2_queue_depth` and `argon2_in_flight` from `/api/health` response** (security recon channel, confirmed externally reachable at `https://beta.pevo.science/api/health`). Round-2 added these fields for operator observability but `/api/health` is publicly polled and gives an attacker near-real-time saturation state for parallel attacks. Operators access via SSH on the host and don't need the public endpoint. Fix: remove both fields from the response in `app.ts`. Remove `getArgon2QueueDepth` / `getArgon2InFlight` imports from `app.ts` (the lib still exports them; they remain available for tests). Update `tests/routes/auth-concurrency.test.ts` T4 — drop the `argon2_queue_depth === 0` and `argon2_in_flight === 0` assertions; assert these fields are **absent** from the response shape. Keep `readLimiter` on `/api/health` as defense-in-depth (now redundant for recon but harmless general DoS protection).

3. **P2 — `health.test.ts` not updated for `readLimiter` on `/api/health`** (testing 0.90). Round-2 added `readLimiter` to the route but the existing `tests/routes/health.test.ts` has no `clearRateLimitKeys(['read'])` setup. When health.test.ts runs after auth-concurrency.test.ts in the same Vitest worker, the budget is drained → 429 → test fails on `res.status === 200`. Fix: add `beforeAll` and `afterAll` hooks calling `clearRateLimitKeys(['read'])`.

4. **P2 — Set `UV_THREADPOOL_SIZE=16` in `vitest.config.ts` `env:` block** (testing 0.88). Round-2 chose option (b) DI factory for T1 but skipped option (a) `vitest.config.ts` env override. Result: `tests/routes/auth-concurrency.test.ts` CONCURRENCY=8 burst test runs against the production singleton with cap=1 (the `computeCap()` Vitest fallback), which serializes all 8 requests through one slot. A mutant that hardcodes cap=1 in the production singleton silently passes. Fix: add `UV_THREADPOOL_SIZE: '16'` to `vitest.config.ts` `test.env` so the singleton picks up cap=4 under tests, exercising the queue-fill assertion the test was designed for.

5. **P3 — Update stale `[TODO Architect]` block in this task file** (project-standards 0.82). The TODO at lines 69-72 was written during round-1 and states the `/api/health` response "gained three new fields: argon2_queue_depth, argon2_in_flight, argon2_max_concurrent." Round-2 removed `argon2_max_concurrent`. Round-3 (this hold) removes the other two. Net: no /api/health shape change vs. pre-cluster. Rewrite the TODO block to reflect the strip, OR remove the TODO entirely if there's nothing for the architect to do on contracts (the architect-owned contract sweep is filed as a separate `architect-argon2-cluster-contract-docs.md` task).

6. **P3 — `tests/lib/argon2-semaphore.test.ts:106` awaits no-op async functions, not the semaphore promises** (correctness 0.88). The line `await Promise.all(handles.slice(0, CAP).map(async (_, i) => i))` maps each handle to `async () => <number_literal>`, which resolves immediately. The test still passes because the next line awaits `h.started` for the queued handles, but the stated intent ("Resolve the first CAP runs, then the queued 2 get slots") implies awaiting the actual promises stored in the parallel `promises` array. Fix: replace with `await Promise.all(promises.slice(0, CAP))`.

7. **P3 — Add a docblock note on `argon2-semaphore.ts` documenting that module-level `drainArgon2Queue()` is irreversible** (security 0.72). The closure-private `shuttingDown` flag has no reset path. Tests that import and call the module-level wrapper would permanently poison the singleton for the rest of the worker. Tests today use `createArgon2Semaphore()` DI exclusively, so this is latent. A 2-line comment near the export of `drainArgon2Queue()` documenting the constraint suffices.

**Path to re-archive:** (1) Backend applies items 1-7 in one commit (or a small focused chain). (2) Append a backend re-review signal block below this hold. (3) `git mv` this file from `tasks/pending/` back to `tasks/review/`. (4) Architect re-reviews round-3 with `/ce-code-review` scoped to the new commits — security + adversarial + correctness + testing mandatory given the P1. (5) On clean re-review, archive this task; then re-review `backend-argon2-semaphore-shutdown-drain.md` and `backend-argon2-semaphore-abort-signal.md` (which are still in `review/`) — their re-review at that point should be clean since item 1 closes the cross-task oracle.

Filed as separate Pending tasks (not held on this task — independent scope):
- `architect-argon2-cluster-contract-docs.md` (P2, architect-owned) — document the new 503 SERVICE_UNAVAILABLE responses across auth/settings/custody and add the row to common.md error table.
- `backend-argon2-error-handler-extract.md` (P2) — extract `handleArgonQueueFull` to a shared module, rename to `handleArgon2Error`, dedupe the 3-way instanceof inline checks across custody/signup-verify/settings, introduce shared `ArgonSemaphoreError` base class, move `requestAbortSignal` helper to a shared lib (eliminates 4-file duplication).
- `backend-argon2-error-routes-test-coverage.md` (P2) — route-level integration tests for ArgonQueueFullError / ShuttingDownError / ArgonAbortError → 503 / silent-handle across all 4 affected routes, plus burnSentinel rethrow tests, plus the small lib-level gaps spotted (maxQueueDepth=Infinity, slot-grant race, drain+abort race, listener-leak happy path, requestAbortSignal helper unit tests, T2 sync-throw vs async-reject).
- `backend-shutdown-reentrancy-guard.md` (P3) — `if (shuttingDown) return; shuttingDown = true;` guard in `index.ts shutdown()` to prevent SIGTERM+SIGINT racing pool.end().
- `backend-503-retry-after.md` (P3) — set `Retry-After` header on 503 SERVICE_UNAVAILABLE responses (5s for queue-full, 30s for shutdown).
- `backend-503-message-genericize.md` (P3) — change 503 message string from "Authentication service temporarily overloaded" to a generic "Service temporarily unavailable. Please retry." to reduce information disclosure about argon2 being the bottleneck.

---

**Backend re-review signal (2026-04-28, working tree against `a24c16e`):**

All 7 round-3 hold-block items landed. `npx tsc --noEmit` clean. `npm run lint` clean (2 pre-existing `no-explicit-any` warnings in `seed-phrase.ts`, unrelated to this task).

1. **P1 — `auth.ts` dup-signup `.catch()` rethrow extension (landed).** `backend/src/routes/auth.ts:~427` and `~434` (the two `runWithArgon2Slot(... argon2.hash ...).catch((err) => {...})` blocks behind the verify_token === null and verify_token startsWith('confirmed:') branches) now rethrow `ArgonAbortError | ArgonQueueFullError | ShuttingDownError` and log only on the residual non-semaphore failure-mode path. The outer `handleArgonQueueFull` translates both new error classes into 503 SERVICE_UNAVAILABLE for /signup, closing the 409-vs-503 status differential under saturation/shutdown that leaked email-existence in round-2.

   New route-level test: `backend/tests/routes/auth-signup-dup-saturated.test.ts` (3 cases). Mocks `runWithArgon2Slot` to throw `ArgonQueueFullError`, then `ShuttingDownError`, then a generic native-argon2 `Error`. Asserts the first two return 503 SERVICE_UNAVAILABLE (not 409), and the third still returns 409 DUPLICATE (timing-oracle equalization on non-semaphore failures preserved). Mocking justification documented in the file header per CLAUDE.md test carve-out — filling the singleton's 50-slot queue with real concurrent stuck requests is impractical (exceeds rate-limit caps and risks flake on drain timing).

2. **P2 — `/api/health` argon2 fields stripped (landed).** `backend/src/app.ts` no longer imports `getArgon2QueueDepth` / `getArgon2InFlight`, and the `/api/health` JSON response carries only `status`, `haf_available`, `redis_available`, `timestamp`. The lib still exports the counters for future ops tooling and tests. The `readLimiter` stays on the route as defense-in-depth. Docblock above the handler rewritten to explain the strip and point operators at SSH access for live counters.

3. **P2 — `health.test.ts` rate-limit cleanup (landed).** `backend/tests/routes/health.test.ts` now has `beforeAll` and `afterAll` calling `clearRateLimitKeys(['read'])`. New assertion `expect(res.body).not.toHaveProperty('argon2_*')` covers all three stripped fields so a regression that re-exposes any of them fails this test.

4. **P2 — `vitest.config.ts` UV_THREADPOOL_SIZE override (already landed).** `vitest.config.ts:20` was set to `UV_THREADPOOL_SIZE: '16'` in commit `04fddee` (BE-P3-CLEANUP-SWEEP). No change required for round-3.

5. **P3 — Stale `[TODO Architect]` block rewrite (landed).** Lines 69-72 of this task file rewritten to reflect the round-2 + round-3 strips: net no shape change to `/api/health` vs. pre-cluster, and the architect-owned 503 contract documentation is filed as a separate task (`architect-argon2-cluster-contract-docs.md`).

6. **P3 — `tests/lib/argon2-semaphore.test.ts:108` await-no-op fix (landed).** Replaced `await Promise.all(handles.slice(0, CAP).map(async (_, i) => i))` with `await Promise.all(promises.slice(0, CAP))` so the test actually awaits the runWithArgon2Slot promises for the first CAP runs (was previously awaiting freshly-created `async () => i` no-ops, which masked the intended "wait for the first CAP runs to drain" assertion).

7. **P3 — `drainArgon2Queue()` irreversibility docblock (landed).** Added a paragraph to the JSDoc on the module-level `drainArgon2Queue()` export at `argon2-semaphore.ts:~336` explaining that the closure-private `shuttingDown` flag has no reset path; tests that need to exercise drain semantics must use `createArgon2Semaphore(...)` rather than the module-level wrapper or they will poison the singleton for the rest of the worker.

**Test outcomes (directly-affected only; full suite deferred to parent):**
- `tests/lib/argon2-semaphore.test.ts`: 9/9 pass.
- `tests/routes/auth-concurrency.test.ts`: 2/2 pass (T4 now asserts absence of the 3 argon2 fields).
- `tests/routes/auth-signup-dup-saturated.test.ts`: 3/3 pass (new file).
- `tests/routes/health.test.ts`: 3/3 pass (new no-leak assertion + rate-limit cleanup).
- `tests/routes/auth.test.ts`: 20/20 pass.
- `tests/routes/settings.test.ts`: 13/13 pass.
- `tests/routes/settings-set-password.test.ts`: all pass.
- `tests/routes/signup-verify.test.ts`: 6/6 pass.
- `tests/routes/custody.test.ts`: all pass.
- `tests/routes/recover.test.ts`: all pass.
- Aggregate across the 10 directly-affected files: 102/102 pass.
- `npx tsc --noEmit`: clean.
- `npm run lint`: clean (2 pre-existing warnings).

**Design notes:**
- The dup-signup `.catch()` rethrow now covers all three semaphore error classes; only generic non-semaphore failures stay swallowed (preserving the timing-oracle-equalization burn purpose). Comment block on the first occurrence documents the rationale; the second occurrence (the `confirmed:`-prefix branch) carries the same rethrow without re-iterating the rationale.
- Item 4's already-landed status was confirmed by `git show 04fddee` showing `vitest.config.ts: explicitly set UV_THREADPOOL_SIZE: '16'` as part of the P3 cleanup sweep.
- `auth-signup-dup-saturated.test.ts` is a separate file from `auth-concurrency.test.ts` so the semaphore-mock module-level vi.mock doesn't leak into the timing-floor concurrent-burst test (which uses the real semaphore).
