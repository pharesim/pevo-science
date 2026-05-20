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

---

## Architect re-review (2026-05-20) — HELD PENDING FIXES

`/ce-code-review` ran on round-1 commit `623bee26` with 9 reviewer personas (correctness on Opus; performance, reliability, testing, maintainability, project-standards, kieran-typescript on Sonnet; adversarial on Opus; learnings-researcher on Sonnet; `ce-agent-native-reviewer` skipped per PEvO CLAUDE.md). Single-flight `inflight` map lands structurally in `QueryCache.getOrSet`; 4 unit specs + integration canary all pass. Cluster review surfaced one P1 adversarial correctness defect (invalidation race), one P2 TOCTOU window under Redis backend, and one P2 citation rot. One follow-up task filed for the `getOrSetSWR` parity gap.

Cluster-wide findings: 6 findings (12 sub-points) surfaced across the persona fleet; 3 dismissed at architect triage (IIFE ordering readability, discriminated-union poisoning audit pre-existing, wire-shape mutation-blind test preemptive); 1 filed as new follow-up task (`getOrSetSWR` cold-path); 3 held for round-2.

### Items to address (bundle into one round-2 commit)

**1. (P1, anchor 100, adversarial) `invalidate()` / `invalidatePrefix()` / `clearVolatile()` / `clear()` do not consult `this.inflight`, so a single-flight fetcher resolves AFTER an invalidation runs and writes its pre-invalidation snapshot back via `this.set`, silently undoing the flush.** `backend/src/cache.ts` (the four invalidation methods + `getOrSet`'s success-path `this.set` call). Scenario:

   1. Concurrent readers A, B, C trigger a single-flight fetcher F for key K. F is in flight against HAF.
   2. A paper-edit mutation calls `hafCache.invalidate(K)` (e.g., from `papers.ts:3187-3194`). The cache is cleared.
   3. F resolves with its pre-invalidation snapshot. F's promise body executes `if (data !== null && data !== undefined) await this.set(key, data, ttlMs, stable)`. The pre-invalidation snapshot is now in the cache under key K with full TTL (up to 30 min for `stable: true` entries like paper detail; 2 min for claim-accept entries).
   4. All readers A, B, C receive the pre-invalidation snapshot from F's resolution. Subsequent readers cache-hit on the stale snapshot for the remaining TTL.

   Pre-fix behavior: each concurrent reader did its own fetch. At most one fetcher's snapshot would race with the invalidate; later readers' fetchers fired AFTER the invalidate and picked up fresh data. Single-flight amplifies the existing race from per-fetcher to per-key-wave (one stale write outlives many readers).

   Fix shape B (architect-prescribed): epoch counter. Add `private epoch = 0` to `QueryCache`. `invalidate*`/`clear*` methods bump `this.epoch`. `getOrSet`'s fetcher promise captures the epoch at start (`const capturedEpoch = this.epoch`); on resolution, skip the `cache.set` write if `capturedEpoch !== this.epoch`. In-flight callers still receive the resolved value (so the request that triggered the fetcher gets data), but the cache stays cold so the next caller picks up fresh post-invalidation data. ~15 LOC of additional logic. Unit spec: invalidate-during-flight test asserting cache.get returns undefined after invalidate-then-fetcher-resolves sequence. Worst-case repros at `papers.ts:3187-3194` (paper edit) and `claims.ts:229/325/359` (claim accept/revoke) — both `stable: true` entries with multi-minute TTL pins.

**2. (P2, anchor 75, correctness) TOCTOU window between `await this.get(key)` and the inflight check degrades single-flight from "one fetcher" to "few fetchers" under Redis backend.** `backend/src/cache.ts:93-101`. Two concurrent callers both `await this.get(key)` (Redis network roundtrip ~1-5ms in production), both miss, both find `inflight.get` empty (because neither has reached `inflight.set` yet), both create separate fetcher promises. The second `inflight.set` silently overwrites the first; both fetchers run. Correctness preserved (both return data); the single-flight invariant degrades from "eliminates duplication" to "reduces duplication." Unit spec #1 doesn't catch this because vi.fn() with setTimeout(50) registers inflight synchronously before the first awaited tick.

   Fix shape C (architect-prescribed): docblock honesty. Update the class-level docblock and `getOrSet` JSDoc to honestly frame what the primitive does: *"eliminates duplication within an event-loop tick; reduces duplication under Redis backend during concurrent cache-miss probes."* ~3 LOC comment update. (Alternative Fix A — synchronous in-memory `peek()` probe before async `get()` — would tighten the window but adds ~10 LOC of state-management complexity; not pursued.) The current behavior is still a major improvement over pre-fix N-way amplification; the fix is to set correct expectations in the docblock, not to chase the asymptote.

**3. (P2, anchor 90, project-standards) Clause-(c) companion citation in test header is factually wrong — quoted test name doesn't match any describe or it block.** `backend/tests/lib/cache.test.ts:13-19`. Header cites *"the integration canary in `papers-enrichment-parity-gate.test.ts` (`'single-flight: 3 concurrent /enrichment calls collapse to 1 HAF fetcher'`)"*. The quoted string does NOT match any describe or it block in that file. Actual describe: `'GET /api/papers/:author/:permlink/enrichment — single-flight coalescing canary'`. Actual it: `'3 concurrent requests for the same (author, permlink) issue HAF queries only ONCE (mutation-kill: remove single-flight → 3x SQL volume)'`. Per `comment-sweep-expansion-must-audit-added-clause-behavioral-accuracy-2026-05-20.md` and `docblock-anchor-stable-symbols-not-line-numbers-2026-05-15.md`. Same shape as the project-standards finding on `backend-register-rate-limit-byip-skipfailed` (round-2 hold item 3).

   Fix: replace the quoted parenthetical with the actual describe-block name. ~1 LOC.

### Items dismissed during architect triage

- **(maintainability P3, conf 75 IIFE-then-inflight.set ordering readability)** Current shape is structurally correct under Node's single-threaded execution (no `await` between IIFE construction and `inflight.set`). Sibling pattern (`revalidating.add` before `await fn()`) is valid alternative. Per `synchronous-flag-before-await-idempotency-guard-2026-05-16.md` both shapes are acceptable. Below action threshold.
- **(learnings-flagged informational discriminated-union poisoning audit)** Pre-existing cross-cutting concern per `caching-wrapper-discriminated-union-poisoning-2026-05-11.md`; not introduced or worsened by this commit. Per memory `feedback_dismiss_preemptive_test_hardening`, audit-driven preemptive sweeps default to dismiss unless an observed call-site issue exists.
- **(learnings-flagged informational wire-shape mutation-blind test)** The mutation it pins (`inflight` Map removed but fetcher synchronously cached) is highly contrived; no sensible refactor produces it. Per memory `feedback_dismiss_preemptive_test_hardening`, preemptive test-hardening dismissable.

### Items filed as new follow-up tasks (not in this task's round-2 scope)

- **(P3, anchor 75, cross-reviewer correctness + performance + reliability + maintainability + learnings)** `getOrSetSWR` cold-path has no single-flight protection. Filed as new task `backend-cache-single-flight-coalescing-swr-cold-path.md` in `tasks/pending/`. The class-level docblock added by round-1 raises the expectation that coalescing is a property of the class, which is currently not delivered on `getOrSetSWR`. Different state machine (stale/fresh/revalidating) deserves its own scope and tests.

### Re-review signal

When items 1-3 land in a single round-2 commit, `git mv` this file back to `tasks/review/`. The mv itself is the re-review signal. Round-2 architect review scopes `/ce-code-review` to the round-2 commit only. Item 1 is the load-bearing correctness fix; items 2-3 are mechanical text rewrites.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>

---

## Backend re-review signal (2026-05-20, round-2)

All three round-2 hold-block items landed in a single commit.

### Item 1 — Invalidation-during-flight race (epoch counter)

`backend/src/cache.ts`:
- Added `private epoch = 0` field to `QueryCache`.
- `invalidate()`, `invalidatePrefix()`, `clearVolatile()`, and `clear()` each bump `this.epoch` BEFORE the actual Redis/memory delete operation (ordering rationale documented in the `invalidate` body: a bump-after-delete leaves a window where a fetcher resolves with the captured-old epoch and writes its snapshot back between the delete and the bump).
- `getOrSet` captures `const capturedEpoch = this.epoch` at fetcher start; the success-path cache write now requires `data !== null && data !== undefined && capturedEpoch === this.epoch`. In-flight callers still receive the resolved value; only the `this.set(...)` write is gated.
- Class-level docblock and `getOrSet` JSDoc describe the invalidation-during-flight contract.

### Item 2 — TOCTOU docblock honesty

`backend/src/cache.ts`:
- Class-level docblock added a "Coalescing strength" paragraph stating that the primitive eliminates duplication within an event-loop tick and *reduces* (does not eliminate) duplication during the Redis-probe window. Specifically calls out that two callers can both miss on `await this.get(key)`, both find the in-flight map empty, and both create fetchers; the second `inflight.set` overwrites the first; correctness preserved in both regimes.
- `getOrSet` JSDoc updated to point at the class-level docblock for the strength claim, framing single-flight as "concurrent callers for the same `key` that arrive synchronously (same event-loop tick) share ONE fetcher invocation" rather than the previous unconditional "share ONE fetcher invocation."
- No code-shape change (Fix A — synchronous in-memory `peek()` probe — explicitly not pursued per the hold-block direction).

### Item 3 — Clause-(c) citation rot

`backend/tests/lib/cache.test.ts`:
- Header citation updated from the inaccurate `'single-flight: 3 concurrent /enrichment calls collapse to 1 HAF fetcher'` to the actual describe-block name `'GET /api/papers/:author/:permlink/enrichment — single-flight coalescing canary'` (verified by `grep -n describe backend/tests/routes/papers-enrichment-parity-gate.test.ts`).

### New unit spec

`backend/tests/lib/cache.test.ts`: added `'invalidate() during an in-flight fetcher prevents the pre-invalidation snapshot from being cached'`. Pattern: slow fetcher (50ms setTimeout) starts; 10ms later (after the in-flight slot is registered) `cache.invalidate('race-key')` runs; fetcher resolves with its pre-invalidation snapshot; the in-flight caller receives `{ value: 'pre-invalidation-snapshot' }` but `cache.get('race-key')` returns `undefined`. Mutation-kill verified: removing the `capturedEpoch === this.epoch` guard flips the assertion RED with `expected { value: 'pre-invalidation-snapshot' } to be undefined` — exactly the silent-recache failure mode the guard is meant to prevent.

### Verification

- `npm run typecheck` from `backend/`: clean (no new errors; the pre-existing `argon2-error-mocks.ts:178` error noted in the hold block did not appear, likely already remediated by a sibling task between hold-filing and round-2 implementation).
- `npm run lint` from `backend/`: clean for changed files (only pre-existing warning in `author-supersession.ts` outside this task's zone).
- Scoped vitest `tests/lib/cache.test.ts`: 5/5 pass (4 existing single-flight specs + 1 new invalidation-race spec). Mutation-kill of the epoch guard reproduced the expected RED before restore.
