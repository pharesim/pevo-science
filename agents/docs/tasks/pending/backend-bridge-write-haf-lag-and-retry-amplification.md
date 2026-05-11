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
