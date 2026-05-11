# BACKEND-BRIDGE-LOCK-REAL-REDIS-COMPANION — Add a real-Redis SETNX-contention integration spec to satisfy carve-out clause C for `bridge-haf-lag-locks.test.ts`

**Owner:** backend
**Created:** 2026-05-11 (surfaced by `backend-bridge-write-haf-lag-and-retry-amplification` round-1 review, project-standards reviewer PS-001 anchor 75)
**Priority:** P2

## Context

`backend/tests/routes/bridge-haf-lag-locks.test.ts` uses a `FakeRedis` stub for the SETNX contention specs. Per root `CLAUDE.md` "Running Tests" / test mock carve-out clause C, the mocked test path requires EITHER the same risk class to be covered by a real-path test elsewhere OR a follow-up task filed to add such coverage.

The file's header currently cites `bridge.test.ts`'s unlocked-degrade branch as the real-path companion, but that companion exercises Redis-unavailable fallback (a distinct failure mode — `acquireBridgeLock` returns `'unavailable'` and the route skips locking entirely) rather than SETNX lock contention (the actual risk class of this file's specs: "Redis is available; concurrent writers serialize on SETNX; loser gets 409 retriable"). The carve-out clause is therefore not satisfied as-cited.

This task either adds the missing real-Redis integration spec OR confirms the orcid suite already provides the equivalent coverage and the test-file header should cite that instead (architect intake check: orcid runs against real Redis per the broader test infrastructure note in root CLAUDE.md, but the SETNX-specific assertion shape needs verification).

## Acceptance

1. Investigate whether `backend/tests/routes/orcid.test.ts` (or another existing test file) already exercises SETNX lock contention against a real Redis instance. If yes:
   - Update the carve-out header in `backend/tests/routes/bridge-haf-lag-locks.test.ts` to cite the orcid test (or other companion) with file:line specificity, and document the equivalence: both exercise SET NX EX with a deterministic key, observe winner-vs-loser semantics, and verify Lua CAS release.
   - Close this task with that single header-edit landing.

2. If no existing real-Redis SETNX contention spec exists, add one:
   - File location: `backend/tests/routes/bridge-haf-lag-locks-real-redis.test.ts` OR extend `bridge.test.ts` with a `describe('real-Redis SETNX contention')` block. Pick whichever fits the project's existing real-Redis test discovery pattern.
   - Real-Redis acquisition pattern: the test runs against the live Redis container per the project's test-infra setup (see root CLAUDE.md "Running Tests" for the docker-network-IP-discovery pattern). Use a unique test-prefix for the lock key to avoid collisions with other tests running in parallel (e.g. prefix with `vitest:<process.pid>:<random>:`).
   - Coverage: at minimum (a) two concurrent /register-equivalent SETNX attempts on the same key — exactly one succeeds, the other returns null per SETNX semantics; (b) Lua CAS release returns 1 on holder's release and 0 on a non-holder's release attempt; (c) TTL expires and a sibling can re-acquire under a new nonce.
   - This is integration coverage, not full route coverage. The mocked specs in `bridge-haf-lag-locks.test.ts` continue to cover the route-level wiring; this companion covers the Redis-level primitive.

3. Update the carve-out header in `bridge-haf-lag-locks.test.ts` to cite the new (or existing) companion with file:line specificity.

## Tests

The new test file IS the deliverable; no further tests needed.

If the integration test needs a deterministic Redis instance, the project's test-infra docs apply (per root `CLAUDE.md` Docker-network-IP-discovery for Redis URL). Document any new test-runner requirements in the test file header.

## Coordination

- Cross-references `backend-bridge-write-haf-lag-and-retry-amplification` round-2 hold item 5 (which asks the implementer to update the carve-out header citing whichever companion this task identifies or creates). The round-2 hold may complete this task's deliverable if the implementer chooses option (1) (existing companion) — confirm with the architect during round-2 review.
- May overlap with EVALSHA migration (`backend-redis-script-evalsha-optimization` in `tasks/review/`) — if the migration includes its own real-Redis test that exercises NOSCRIPT-fallback against the actual script registry, that test could double as this task's companion.

## Out of scope

- Migrating the existing FakeRedis-based bridge-haf-lag-locks specs to real Redis. The mocked specs remain — they exercise the route-level wiring under deterministic conditions. The real-Redis companion exercises the Redis-primitive behavior.
- Adding real-Redis coverage to other lock sites (orcid binding lock, accreditation broadcast lock). Out of this task's scope.

## Priority rationale

P2 because the carve-out clause C requires the companion. The mocked specs are good coverage for the route-level wiring, but the carve-out exists precisely because mocked SETNX can diverge from real Redis (TTL behavior, EX/PX semantics, Lua CAS engine differences). The companion's value compounds with the EVALSHA migration's real-Redis story.
