# BACKEND-REDIS-COMMAND-TIMEOUT — Add commandTimeout to the ioredis client constructor

**Owner:** Backend Agent
**Created:** 2026-05-21 (architect, surfaced by `/ce-code-review` of commit `d6e0e528` redis-script-evalsha optimization)
**Priority:** P2 (reliability)

## Why now

`/ce-code-review` of the BACKEND-REDIS-SCRIPT-EVALSHA-OPTIMIZATION task surfaced a reliability gap that pre-dates that commit but became visible while reviewing the new helper's NOSCRIPT recovery path. Reliability reviewer at conf 75:

> The NOSCRIPT recovery path inside `evalScript` is awaited on the HTTP request path for accreditation `/verify`. A Redis server that accepts the connection but stalls on a `SCRIPT LOAD` command (e.g. Lua cache pressure under OOM) will hang that request indefinitely. `maxRetriesPerRequest: 3` governs connection-level retry, not per-command timeout, so it does not bound this hang.

The gap is broader than NOSCRIPT recovery: every `ioredis` command in PEvO inherits the absence of a per-command timeout. The accreditation cap-enforcement INCR, the reputation-batch lock acquire/release, the SWR cache reads — all hang indefinitely against a stalled-but-connected Redis. At PEvO's single-instance scale this manifests as a slow degradation rather than a cascade, but the upstream HTTP request never sees a bounded failure response.

## Goal

Set a `commandTimeout` on the ioredis client in `backend/src/redis.ts` so every command has a bounded per-call latency ceiling. Failing commands surface as `MaxRetriesPerRequestError` (or the timeout equivalent) and route through existing catch handlers, returning bounded errors to callers instead of hanging indefinitely.

## Acceptance criteria

### 1. Add `commandTimeout` to the ioredis constructor in `backend/src/redis.ts`

The current shape:

```ts
const client = new Redis(config.redisUrl, {
  maxRetriesPerRequest: 3,
  lazyConnect: true,
  retryStrategy(times) { ... },
});
```

Add a `commandTimeout` value. Suggested starting point: 5000ms (5 seconds). The accreditation verify endpoint and the reputation-batch lock acquire/release are both well under 100ms at steady state; 5000ms is generous enough to avoid false-positive timeouts on Redis hiccups while bounding the worst case. Implementer can survey current 99th-percentile Redis-command durations from logs to pick a more informed value — 1000ms / 2000ms / 5000ms are all defensible.

### 2. Verify no regression at the warm-path call sites

The two production call sites that use the EVALSHA helper are:

- `backend/src/routes/accreditation.ts incrementBroadcastAttempts` (per-request, hot path)
- `backend/src/reputation-batch.ts runBatchComputation` (lock release in the finally block, daily)

Verify against a real Redis that both call paths complete well under the chosen `commandTimeout`. The accreditation route's existing 503 SERVICE_UNAVAILABLE catch handles non-NOSCRIPT errors; verify a synthetic timeout (e.g., `vi.spyOn(redis, 'evalsha').mockImplementation(() => new Promise(...))`) routes through that catch.

### 3. Tests

Targeted carve-out clause-(c) coverage:

- A test that mocks `redis.evalsha` to reject with a `ETIMEDOUT`-equivalent error and asserts the accreditation route returns 503 SERVICE_UNAVAILABLE (mirrors the existing OOM-rejection spec, just for the timeout class).
- Optionally: a SQL-shape canary asserting that `redis.ts` constructor passes `commandTimeout` in the options object. Subject to the architect's preference; per the existing `createApp()` regression test pattern, a similar `new Redis(...)` config inspection at module load is defensible.

The bulk of the existing tests use real Redis (via Docker) and should be unaffected at a 5000ms ceiling.

### 4. Documentation

Brief inline comment at the ioredis constructor explaining what `commandTimeout` bounds (per-command latency, not connection retry) and pointing at why it matters (NOSCRIPT recovery hangs, OOM stalls, network half-open).

## Out of scope

- Adjusting other ioredis options (`enableOfflineQueue`, `keepAlive`, etc.) — single-knob change.
- Per-call-site overrides via `client.duplicate({ commandTimeout: ... })`. If one site needs a different ceiling later, address per-site.
- Replacing ioredis with a different client. Not on the table.

## Source

- `/ce-code-review` reliability R2 (conf 75) on commit `d6e0e528`. Filed as separate task per the architect's round-1 hold disposition for the redis-script-evalsha task.

## Cross-references

- `backend/src/redis.ts` — current ioredis client constructor.
- `backend/src/lib/redis-scripts.ts evalScript` — NOSCRIPT recovery path that surfaces the issue most acutely.
- `backend/src/routes/accreditation.ts` — accreditation verify hot path.
- `backend/src/reputation-batch.ts` — reputation cycle lock acquire/release.
- ioredis docs: `commandTimeout` semantics.

## Architect re-review (2026-05-25) — HELD PENDING FIXES:

Round-1 hold from `/ce-code-review` fan-out (6 personas — adversarial and kieran-typescript dropped for the smaller 15-line source surface):

1. **Test header labels carve-out as `clause-(c)` but content is `clause-(a)`.** Per root `CLAUDE.md`'s three-clause test-mock carve-out framework: clause-(a) is the impractical-real-path justification, clause-(c) is the real-path-companion citation. The current header conflates them under a single `clause-(c)` label. Relabel the justification block to `clause-(a)`, then add a separate `Real-path companion (clause-(c)):` sentence citing the accreditation pre-INCR `redis.eval` rejection spec by function description (do not cite by line number — anchor-stability rule).

2. **`REDIS_COMMAND_TIMEOUT_MS` docblock is disproportionately large for a configuration constant.** It currently enumerates failure modes (Lua-cache OOM, half-open socket, NOSCRIPT recovery), hot-path latency comparisons (accreditation `/verify`, reputation-batch lock), and route names — most of which belongs in the commit message or a `solutions/` entry. Trim to two non-obvious facts: `commandTimeout` bounds per-command latency (distinct from `maxRetriesPerRequest` which governs connection-level retry); timed-out commands reject rather than hang.

3. **Test docblock duplicates production-comment failure-mode theory verbatim.** Lines covering Lua-cache OOM / half-open sockets / NOSCRIPT recovery appear in both `backend/src/redis.ts` and the test header. Two copies of the same prose drift on the first future edit to either side. Remove the failure-mode preamble from the test docblock; keep the carve-out justification and companion citation (those are test-specific). The trim in item 2 narrows the source-side surface too, leaving less to drift against.

4. **`afterEach` teardown disconnects a different module instance than `beforeEach` constructed.** The hook dynamically re-imports the module after `beforeEach` already called `vi.resetModules()`. Result: `disconnectRedis()` runs on a fresh module instance with no client, while the one the test actually built leaks. The canary doesn't reach a state where this matters today, but the teardown is structurally wrong and the next test that adds command-dispatch coverage will inherit the leak. Either (a) store the module reference from the test-body import in a shared variable and have `afterEach` call `disconnectRedis` on that reference, or (b) move `vi.resetModules()` to `afterEach` after teardown, not `beforeEach`.

Suppressed (anchor 50, did not survive gate): `REDIS_URL`-absent guard advisory (testing); literal `5000` backoff-cap coincidence with `commandTimeout` value (maintainability, pre-existing). Residual_risks recorded but not held: `commandTimeout` vs `MaxRetriesPerRequestError` class confusion in caller catch handlers; NOSCRIPT recovery's two-budget ~10s worst-case; offline-queued commands timing out at 5s mid-reconnect. All are documented behavior and don't block this commit.
