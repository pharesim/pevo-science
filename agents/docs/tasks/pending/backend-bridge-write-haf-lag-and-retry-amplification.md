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
