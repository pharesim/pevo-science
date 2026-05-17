# BACKEND-CACHE-SINGLE-FLIGHT-COALESCING — Coalesce concurrent same-key fetches in `hafCache.getOrSet`

**Owner:** Backend Agent
**Created:** 2026-05-17 (architect, surfaced by `/ce-code-review` PERF-02 on `backend-haf-walker-wall-clock-budget` round-2 commit `2494725`)
**Priority:** P2 (performance under degraded HAF)

## Why now

`backend/src/cache.ts:68-77` `QueryCache.getOrSet(key, fn)` has no in-flight deduplication. When the cache misses, every concurrent caller invokes `fn()` independently. Under normal operation the costs are bounded — the loader returns fast, callers each write back to the cache, the next round-trip serves from the warm cache. Under SUSTAINED DEGRADED HAF the math changes:

- The walker abort path (BACKEND-HAF-WALKER-WALL-CLOCK-BUDGET round-2 item 7) correctly returns `null` from `fetchPaperDetailFromHaf` / `fetchEnrichmentFromHaf` so `getOrSet` skips the cache write — preventing partial-chain poisoning.
- Concurrent requests for the same `(author, permlink)` during the degraded window each get a cache miss and each spawn their own walker call. With `pool max=3` (`backend/src/db.ts:25`) and `statement_timeout=30000ms`, each request holds a pool slot for up to `hafWalkerWallClockMs + statement_timeout` ≈ 33s at default config. N concurrent requests for the same popular paper amplify pool contention by N rather than 1.
- The amplification is self-sustaining: every request under sustained degraded HAF pays the full pool-wait + statement_timeout cost. The pool max=3 cap bounds concurrent HOLDERS to 3 but the queue behind them grows unboundedly while Express keeps sockets open.

The walker budget closes the per-request DoS amplifier (attacker-controlled chain depth). PERF-02 is a separate concurrency-amplifier — N concurrent legitimate requests for the same paper under degraded HAF. The two are orthogonal defenses.

## Threat model

- Not adversarial in this task's scope. The amplifier fires under legitimate traffic + degraded HAF; an attacker who can simultaneously trigger N requests for the same paper is a weaker variant of the chain-depth amplifier the walker budget closes.
- Concrete trigger: a popular paper viewed by N users when HAF tail latency exceeds the walker budget. Pre-fix: every user's request races for a pool slot, exhausts the budget, returns 503. Post-fix: one fetcher runs; the other N-1 callers await its result; if that one aborts, all N see the 503 simultaneously (cache stays cold; next wave can try again when HAF recovers).

## Goal

Add a `Map<string, Promise<T | null>>` single-flight layer inside `QueryCache.getOrSet` so concurrent callers for the same `key` share a single in-flight fetcher invocation. When the in-flight promise resolves:
- If non-null: cache it with the normal TTL, return it to all awaiters.
- If null: do NOT cache (existing skip-write rule from `cache.ts:73`), return null to all awaiters, drop the in-flight map entry so the next wave gets a fresh chance.

## Acceptance

### 1. Single-flight map in `QueryCache`

`backend/src/cache.ts`:
- Add a private `#inflight: Map<string, Promise<T | null>>` field (or scoped to the prefix-keyed pattern already used).
- `getOrSet(key, fn)`:
  - On cache hit: return cached.
  - On cache miss: check `#inflight.get(key)`. If present, `return await` that promise.
  - If absent: create a promise from `fn()`, store it in `#inflight`, await it, write to cache (if non-null), delete from `#inflight` (in a `finally`), return the result.
- Use `getOrSet`'s existing key prefix (`${config.appTag}:cache:<routeKey>`) as the map key shape so test assertions stay consistent.

### 2. Bypass on cache disabled

If `getOrSet`'s cache layer is disabled (Redis unavailable, in-memory fallback only), the single-flight layer must still work — it's an in-process coordination primitive independent of Redis. Verify by inspecting the existing fallback path.

### 3. Tests

`backend/tests/lib/cache.test.ts` (extend or create):
- `'coalesces N concurrent misses for the same key into 1 fetcher invocation'` — install a slow fetcher (e.g., `setTimeout(resolve, 100)`); fire 5 concurrent `getOrSet(key, fetcher)` calls; assert `fetcher` invoked exactly once and all 5 awaiters receive the same resolved value.
- `'does NOT cache null results; allows next wave to retry'` — fetcher returns null on first wave; assert no cache write; second wave's fetcher invocation is allowed (not stuck on the in-flight entry from the first wave).
- `'concurrent requests for DIFFERENT keys do not share an in-flight slot'` — fire concurrent requests for `keyA` and `keyB`; assert each fetcher invoked once independently.
- `'in-flight map entry is cleaned up on fetcher throw'` — fetcher rejects; assert the in-flight map is empty after the rejection so subsequent calls don't get stuck on a poisoned entry.

### 4. Integration validation

The walker budget tests (`canonical-root-walker.test.ts`, `continuation-author-gate.test.ts`) currently assert single-request abort behavior. Add ONE integration canary in `papers-enrichment-parity-gate.test.ts` (or equivalent) that fires N=3 concurrent `GET /api/papers/:author/:permlink` requests under a slow-HAF responder and asserts the HAF query was issued only once (probe `pgQueryMock.mock.calls` count for the walker SQL). Mutation-kill: remove the single-flight layer → fetcher count rises to N → canary fails red.

### 5. Operator surface

No new config knob. The single-flight layer is an unconditional optimization — there is no failure mode where disabling it is preferable. Briefly note the addition in the `cache.ts` module docblock or class JSDoc.

## Out of scope

- Distributed coordination across processes (PEvO is single-instance per `project_single_instance_only`; in-process Map is sufficient).
- Cache-write coordination (when two callers write the same key, last-write-wins on Redis is fine — they wrote the same value because both came from the same fetcher promise resolution under single-flight).
- Retry policy on fetcher failure (the existing retry layer at the fetcher level handles this; single-flight just dedups concurrent invocations).
- Cache invalidation API (separate concern; current TTL-based eviction is unchanged).
- Migration of `accreditationCache`, `wotVouchCache`, or other `QueryCache` instances to single-flight individually — `QueryCache` is the shared substrate, so the fix applies to all instances uniformly.

## Coordination

- **Source:** `/ce-code-review` PERF-02 on `backend-haf-walker-wall-clock-budget` round-2 commit `2494725` (architect re-review 2026-05-17). Filed at architect triage as a new task rather than bundled into the walker round-3 hold-block because the scope is new feature, not walker-task remediation.
- **Sequencing:** independent of the walker round-3 hold. Backend can pick this up at any time after the walker round-3 hold lands.
- **Convention reference:** none currently; if the single-flight + null-skip pattern is novel in PEvO's cache layer, `/ce-compound` may capture it post-archive.

## Cross-references

- `backend/src/cache.ts:68-77` — the `getOrSet` site to modify.
- `backend/src/db.ts:25` — `pool max=3` constant (context for the pool-saturation amplifier).
- `agents/docs/tasks/pending/backend-haf-walker-wall-clock-budget.md` — the walker task whose round-2 review surfaced this performance concern; this task is filed as PERF-02's dismissal target (dismissed-from-bundle → new-task).
- `feedback_pevo_logging_minimal` — does NOT require new logging on the single-flight path; coalescing is internal and operator-invisible by design.

---

## Backend re-review signal (2026-05-17, round-1)

All five acceptance items landed.

### Item 1 — Single-flight map in `QueryCache`

`backend/src/cache.ts`:
- Added `private inflight = new Map<string, Promise<unknown>>()` to `QueryCache`.
- Rewrote `getOrSet`: after the existing cache-miss check, probe `inflight.get(prefixedKey)` and await the existing promise if present. Otherwise create a self-cleaning promise that runs the fetcher, writes to cache on non-null (preserving the existing skip-on-null at `cache.ts:73`), and `delete`s the in-flight slot in `finally` across ALL terminal states (success, null-resolution, rejection — so transient nulls and throws never poison subsequent waves).
- In-flight slot key uses the full prefixed key (`${config.appTag}:cache:<routeKey>`) per spec.
- Class docblock + `getOrSet` JSDoc updated to document the coalescing semantics and the rationale for clearing the slot on null/rejection.

### Item 2 — Bypass on cache disabled (no change required)

The single-flight map is in-process state on the `QueryCache` instance itself; it works identically whether the Redis backend is reachable or the in-memory fallback is in use. Documented in the class docblock.

### Item 3 — Unit tests

`backend/tests/lib/cache.test.ts` (new file, 4 specs):
- 5 concurrent same-key misses → fetcher invoked exactly once, all 5 awaiters get the same value.
- Null first wave → no cache write AND second wave invokes a fresh fetcher (in-flight slot cleared on null).
- Different keys do not share an in-flight slot.
- Fetcher throw clears the slot so the next call retries fresh (no poisoned entries).

### Item 4 — Integration canary

`backend/tests/routes/papers-enrichment-parity-gate.test.ts`: new describe block `'GET /api/papers/:author/:permlink/enrichment — single-flight coalescing canary'`. Pattern: baseline 1 request → record SQL call count → clear cache → 3 concurrent requests under slow HAF responder → assert total SQL count equals baseline (NOT 3× baseline). Mutation-kill verified by the implementer: removing the `inflight` map produces 21 SQL calls (3× baseline of 7); restoring it produces 7. The enrichment route shares the `hafCache.getOrSet` primitive with `/api/papers/:author/:permlink`; either route's canary covers the same primitive. Enrichment was chosen because the file already had the mock-pool scaffolding.

### Item 5 — Operator surface

No new config knob. Class docblock + `getOrSet` JSDoc carry the coalescing semantics for future maintainers.

### Verification

- `npx tsc --noEmit` from `backend/`: clean.
- `npm run lint` from `backend/`: clean.
- Scoped vitest (`tests/lib/cache.test.ts` + `tests/cache.test.ts` + `tests/routes/papers-enrichment-parity-gate.test.ts`): 16/16 pass (10 existing root-level cache, 4 new single-flight unit specs, 2 enrichment-parity-gate including the new canary).
