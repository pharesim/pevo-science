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
