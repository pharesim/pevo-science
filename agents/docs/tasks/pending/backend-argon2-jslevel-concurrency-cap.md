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
