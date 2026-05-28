# BACKEND-CACHE-SINGLE-FLIGHT-COALESCING-SWR-COLD-PATH — Extend single-flight coalescing AND epoch-guard to `QueryCache.getOrSetSWR` cold-path, `revalidate`, and `registerPeriodicRefresh.reload`

**Owner:** Backend Agent
**Created:** 2026-05-20 (architect, cross-reviewer-flagged during `/ce-code-review` of `backend-cache-single-flight-coalescing` round-1 commit `623bee26`)
**Scope widened:** 2026-05-21 (architect, `/ce-code-review` of parent task's round-2 commit `d6e23014` surfaced two additional sibling paths with the same invalidation-during-flight race — `revalidate` and `registerPeriodicRefresh.reload`. Three reviewer personas corroborated.)
**Priority:** P2 (was P3 — widened scope upgraded severity because the same race class the parent task closed in `getOrSet` is still alive in 3 sibling production paths, not just 1)

## Problem

This task covers TWO related gaps in the `QueryCache` class:

### Gap A — Single-flight coalescing (the original scope)

`backend-cache-single-flight-coalescing` round-1 added a `Map<prefixedKey, Promise<T|null>>` in-process single-flight layer to `QueryCache.getOrSet`. Concurrent same-key cache misses now share ONE fetcher invocation. The sibling method `QueryCache.getOrSetSWR` (stale-while-revalidate) was NOT touched by that task.

`getOrSetSWR` has a cold-path (both fresh and stale keys absent — true cold start, post-`invalidatePrefix`, post-`clearVolatile`, or post-`clear`) that falls through to `await fn()` with NO in-flight guard. N concurrent callers all reach the cold path and all spawn independent fetcher invocations — the same amplification pattern that `getOrSet` now closes.

The existing `revalidating` Set in `getOrSetSWR` guards ONLY the background refresh path (stale-warm); it does not guard the synchronous cold-path.

### Gap B — Epoch-guard invalidation-during-flight race (added 2026-05-21)

The parent task's round-2 commit added an `epoch` counter mechanism to close an invalidation-during-flight race in `getOrSet`'s success path: invalidate*/clear* methods bump `this.epoch` BEFORE their delete; `getOrSet` captures the epoch at fetcher start and skips the `this.set` write on resolution if the epoch has advanced (the snapshot is stale). The fix is correctly applied at `getOrSet`.

Three OTHER paths in the same file have the same `await fn() → await this.set(...)` shape with NO epoch capture or check:

1. **`getOrSetSWR` cold-path** — same code path Gap A covers; the epoch-guard absence is in the success branch that writes to the cache on first-fetch.
2. **`revalidate`** — the private background-refresh helper called from `getOrSetSWR`'s stale-warm path. Performs `await fn()` then unconditionally `await this.set(key, ...)` and `await this.set(staleKey, ...)`. If `invalidate`, `invalidatePrefix`, `clearVolatile`, or `clear` fires while a background revalidation is in flight, the revalidation writes its pre-invalidation snapshot back into the cache after the invalidation cleared it. The `staleKey` write is especially load-bearing because the stale key is what callers see for the next `staleMs` window.
3. **`registerPeriodicRefresh.reload`** — the closure that periodic refreshes (e.g., reputation-cycle warm-keep) use to re-populate the cache. Performs `await fn()` then unconditionally `await this.set(key, ...)` with no epoch comparison. A periodic reload firing between an `invalidate` and the next demand-driven read silently re-populates the cleared key with the pre-invalidation snapshot.

All three sites have the same fix pattern: capture `this.epoch` at the start of the fetcher block, gate the success-path `this.set` write(s) on `capturedEpoch === this.epoch`.

### Why this matters

The class-level docblock added by round-1 of the parent task says: *"Single-flight coalescing: getOrSet deduplicates concurrent same-key fetcher invocations..."* and then frames the coalescing layer as a property of the class. A reader will reasonably expect `getOrSetSWR` to behave the same way. The docblock raises an expectation that the cold-path doesn't currently deliver. The round-2 docblock additions extend that scope-honesty problem: the "Invalidation-during-flight" paragraph is scoped to `getOrSet` but a reader could reasonably expect the epoch guard to cover the SWR path too.

### Exposure

SWR callers hit the cold-path after `invalidatePrefix` or `clearVolatile` runs (block-change cache clears in PEvO's reputation cycle, claim mutations, paper edits), or on first cold start. The N-concurrent-callers-against-cold-key burst pattern is real under PEvO's caching workload. The invalidation-during-flight race on SWR's `revalidate` path is reachable on every paper edit / claim accept / vote operation against any cached key with a stale-warm window. `registerPeriodicRefresh.reload` is reachable on every periodic-refresh tick (frequency depends on the registered interval).

## Goal

Close BOTH Gap A (single-flight coalescing) AND Gap B (epoch-guard invalidation-during-flight race) across all 3 unguarded sibling paths in `QueryCache`: `getOrSetSWR` cold-path, `revalidate`, and `registerPeriodicRefresh.reload`. After this change, single-flight coalescing covers `getOrSet` + `getOrSetSWR` cold-path, and the epoch-guard covers all 4 success-path `this.set` write sites (`getOrSet`, `getOrSetSWR` cold-path, `revalidate` both writes, `registerPeriodicRefresh.reload`).

The two methods `getOrSet` and `getOrSetSWR` can share the same `this.inflight` Map (keys are fully prefixed and unique per cache instance). The epoch-guard pattern (capture `this.epoch` at fetcher start; gate `this.set` on `capturedEpoch === this.epoch`) extends mechanically to all 3 sites.

If the parent task's round-3 fix lands the **separate volatile/stable epoch counters** (per the parent's round-3 hold item 1), this task adapts to the per-tier shape: capture both counters at fetcher start, gate on both for non-stable writes and on stableEpoch only for stable writes.

## Acceptance

### 1. `getOrSetSWR` cold-path: single-flight + epoch-guard

`backend/src/cache.ts` `getOrSetSWR` method:
- On cold-path (both fresh and stale `get` return undefined), check `this.inflight.get(inflightKey)` before invoking `fn()`. If present, `return await` that promise.
- If absent, create a self-cleaning promise wrapping `fn()`, store in `this.inflight`, await it, capture the epoch BEFORE the await, gate the success-path `this.set` write(s) on `capturedEpoch === this.epoch` (or the per-tier counters if the parent's round-3 fix landed that shape), and delete the in-flight slot in `finally`. Mirror the `getOrSet` shape.

### 2. `revalidate` (private SWR background-refresh helper): epoch-guard

The `revalidate` method calls `this.set(key, ...)` and `this.set(staleKey, ...)` unconditionally on resolution. Capture `this.epoch` (or both counters per the parent's round-3 shape) at fetcher start; gate BOTH `this.set` calls on epoch match. The `staleKey` write should be gated on the same condition since callers served from the staleKey for the next `staleMs` window must not see a re-cached pre-invalidation snapshot.

### 3. `registerPeriodicRefresh.reload` closure: epoch-guard

The `reload` closure called by the periodic-refresh interval performs `await fn()` then unconditionally `await this.set(key, ...)`. Capture the epoch (or per-tier counters) at the START of the reload closure (before `await fn()`); gate the `this.set` write on epoch match. Document in the closure's JSDoc that a `clear`/`clearVolatile`/`invalidate` fired during a periodic-refresh tick will leave the cache cold until the next demand-driven cache-fill.

### 4. Coordination with the stale-warm `revalidating` guard

The existing `revalidating` Set is for the background-refresh path (stale data present + TTL expired → return stale immediately + refresh in background). The new cold-path single-flight uses `this.inflight` (the same Map as `getOrSet`). These two coordination primitives serve different paths and do NOT need to be merged — keep them separate, document the distinction in the `getOrSetSWR` JSDoc.

### 5. Round-3 fix from the parent task lands first

This task depends on `backend-cache-single-flight-coalescing` round-3 landing the per-tier-counter fix (hold item 1 in the parent's round-3 hold block — `clearVolatile` + stable-key bleedthrough). The per-tier counter shape, once settled, is what this task extends to the SWR/revalidate/reload paths. Sequencing: do NOT start this task until the parent's round-3 fix is archived.

### 6. Tests

`backend/tests/lib/cache.test.ts` — add specs in new describe blocks:

**`'QueryCache.getOrSetSWR — single-flight coalescing on cold-path'`** (Gap A coverage):
- **Coalesce N concurrent cold-path misses → 1 fetcher invocation.** Mirror the `getOrSet` cold-path coalesce spec.
- **Null resolution clears the in-flight slot.** Next wave's fetcher invokes fresh.
- **Throw clears the in-flight slot.** Next call retries with a fresh fetcher.
- **Stale-warm path is unaffected.** Existing stale-warm + revalidating-Set behavior continues to work; the new cold-path coalescing does not interfere. 2-step test: warm cache + expire TTL + concurrent calls → all receive stale data + ONE background refresh fires (via existing `revalidating` Set).

**`'QueryCache — invalidation-during-flight prevents stale recache on SWR / revalidate / periodic-refresh'`** (Gap B coverage, 3 specs):
- **`getOrSetSWR` cold-path: invalidate during in-flight prevents pre-invalidation snapshot from being cached.** Mirror the round-2 unit spec on `getOrSet`. Mutation-kill: remove the epoch-guard from `getOrSetSWR` cold-path → flips RED.
- **`revalidate`: invalidate during background-refresh prevents stale snapshot from being re-cached.** Pattern: warm cache + expire TTL → call `getOrSetSWR` (triggers background `revalidate`) → mid-revalidate, fire `invalidate(key)` → assert `cache.get(key)` returns undefined post-revalidate-resolution. Mutation-kill: remove the epoch-guard from `revalidate` → flips RED.
- **`registerPeriodicRefresh.reload`: invalidate between refresh ticks does not allow the reload's cache-write to undo the flush.** Pattern: register a periodic refresh on a fast interval → during a reload firing, run `invalidate(key)` → assert `cache.get(key)` returns undefined post-reload. Mutation-kill: remove the epoch-guard from `reload` → flips RED.

### 7. Verification

`npm run typecheck` clean. `npm run lint` clean for this change. Scoped vitest on `tests/lib/cache.test.ts` passes (new specs + the existing `getOrSet` single-flight specs unaffected). Existing `getOrSetSWR` callers (reputation, WoT vouch, stats — any cache instance using SWR) continue to pass their integration tests.

### 8. Docblock update

Class-level docblock and `getOrSet` + `getOrSetSWR` JSDoc clarify that single-flight coalescing applies to both methods (per-method language). The "Invalidation-during-flight" paragraph is updated to enumerate all 4 guarded `this.set` sites (`getOrSet`, `getOrSetSWR` cold-path, both `revalidate` writes, `registerPeriodicRefresh.reload`). Honest framing on the TOCTOU degradation under Redis backend per the parent task's round-2 hold item 2 applies equally to `getOrSetSWR`.

## Out of scope

- Refactoring `getOrSet` and `getOrSetSWR` to share a private `_singleFlightFetch` helper. Architect dismisses extraction as YAGNI per project bias; the two methods have similar but distinct path-of-action and the duplication is intentional isolation.
- Touching `this.set` semantics — the skip-on-null rule and the epoch-counter invalidation-race protection from the parent task's round-2 fix apply uniformly.
- Background-refresh coalescing improvements. The existing `revalidating` Set already deduplicates background refreshes; no change needed.

## Cross-references

- `backend/src/cache.ts` — `getOrSetSWR` at lines ~131-153 (the cold-path) and the new `this.inflight` Map shared with `getOrSet`.
- `backend-cache-single-flight-coalescing` round-1 (commit `623bee26`) — established the `inflight` Map pattern on `getOrSet`.
- `backend-cache-single-flight-coalescing` round-2 hold — epoch-counter invalidation-race fix; this task depends on that landing first.
- `agents/docs/solutions/conventions/caching-wrapper-discriminated-union-poisoning-2026-05-11.md` — sibling caching convention.
- Originating review: `/ce-code-review` round-1 of the parent task, cross-corroborated by correctness + performance + reliability + maintainability + learnings-researcher (anchor 75).

[BLOCKED by Architect] 2026-05-21 — Acceptance #5 explicitly requires the parent task `backend-cache-single-flight-coalescing` round-3 fix to be **archived** before this task starts. Parent's round-2 fix landed at commit `d6e23014` (epoch counter, TOCTOU docblock, citation) but architect re-review on 2026-05-21 found a round-3 hold item: `clearVolatile` bumps the class-wide epoch and blocks in-flight stable-key writes — defeating the `stable: true` contract. The prescribed fix is **separate volatile and stable epoch counters**. THIS task's scope was widened at the same re-review to enumerate 3 unguarded sibling paths (Gap B above) that need the same epoch-guard pattern; the per-tier-counter shape, once settled, is what this task extends to those paths. Unblock once architect archives the parent's round-3. Moving to `blocked/` per `feedback_held_task_blocked_on_architect.md` — held tasks whose resolution depends on architect input go to `blocked/`, not `pending/`.

[UNBLOCKED by Architect] 2026-05-27 — Parent `backend-cache-single-flight-coalescing` archived 2026-05-26 (round-4 clean): the per-tier `volatileEpoch`/`stableEpoch` split (Acceptance #5's prerequisite) landed in round-3 and was test-pinned in round-4. The final per-tier counter shape is now settled, so this task can extend it to the `getOrSetSWR` cold-path, `revalidate`, and `registerPeriodicRefresh.reload` sites. Moving back to `pending/` for backend pickup. No coordination conflict: this task is `cache.ts`-scoped, disjoint from the in-flight `papers.ts` author-identity work.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>

---

## Backend completion note (2026-05-27)

Round-1 implementation landed in the commit that moves this file to `review/`.

**Gap A (single-flight) + Gap B (per-tier epoch-guard)** applied to all three
unguarded sibling paths in `backend/src/cache.ts`, mirroring the settled
`volatileEpoch`/`stableEpoch` shape on `getOrSet`:
- `getOrSetSWR` cold-path: shares `this.inflight` with `getOrSet`; gates BOTH
  the `key` and `staleKey` writes on the per-tier counters.
- `revalidate`: captures both counters before the background fetch; gates both
  `set` writes (key + staleKey).
- `registerPeriodicRefresh.reload`: captures both counters at the start of the
  closure; gates the `set` write. (Periodic refreshes default to `stable:true`,
  so only `stableEpoch` suppresses — a `clearVolatile()` block tick does not.)
- Class docblock + `getOrSetSWR` JSDoc updated to enumerate all four guarded
  `this.set` sites and the `inflight`-vs-`revalidating` distinction; the Redis
  TOCTOU caveat extended to the SWR cold-path's two-probe window.

**Tests** (`tests/lib/cache.test.ts`): two new describe blocks —
`getOrSetSWR — single-flight coalescing on cold-path` (N-coalesce,
null-clears-slot, throw-clears-slot, stale-warm-unaffected) and
`invalidation-during-flight prevents stale recache on SWR / revalidate /
periodic-refresh` (one mutation-killing spec per guarded site).

**Adaptation flagged for architect (Acceptance #6, periodic-refresh spec):** the
spec said "run `invalidate(key)` during a reload." `invalidate(key)` ALSO
triggers its own background reload via `periodicEntries`, which re-populates the
key and masks the suppression under test. I used `clear()` as the flush instead
(bumps both per-tier epochs, no competing reload), exercising the reload's
epoch-guard in isolation; the mutation-kill (remove the reload guard → RED)
still holds. If you want the literal `invalidate()` shape, hold and I'll rework
it with a distinguishable per-call return value.

**Acceptance #5 prerequisite** (parent's per-tier counter split) is satisfied:
the parent archived 2026-05-26 and the `volatileEpoch`/`stableEpoch` shape this
task extends is on `main`.

Verification: `npm run typecheck` (src + tests) clean; `npm run lint` clean for
`cache.ts`; scoped `npx vitest run tests/lib/cache.test.ts` green — 15 tests
(the 8 pre-existing `getOrSet` specs + 7 new); representative
SWR/periodic-refresh caller tests (`stats-profile-parity`, `wot`) pass (7
passed / 1 skipped) against real Postgres/Redis.

---

## Architect re-review (2026-05-28, round-1 → round-2) — HELD PENDING FIXES

`/ce-code-review` on commit `e6b8bc57` (9 personas — correctness + adversarial on Opus; testing, maintainability, project-standards, performance, reliability, kieran-typescript on Sonnet; learnings-researcher unstructured; `ce-agent-native-reviewer` skipped per PEvO). The design is mechanically correct: all four success-path `this.set` sites capture both per-tier epochs synchronously before the sole `await fn()`, gate non-stable writes on both counters and stable writes on `stableEpoch` only (matching the bump map), share one `this.inflight` slot deleted in `finally` on every terminal state, route cold-misses correctly while leaving the stale-warm `revalidating` path intact, and skip the write on null/throw. project-standards CLEAN (Redis key prefixing via `this.prefix`, comment-anchoring, backend zone, no mock carve-out triggered). Four items held.

### Items held (must fix before archive)

**1. (P2, anchor 100, cross-reviewer: testing + correctness + maintainability + kieran-typescript + learnings) The `clear()`-substituted invalidation specs cannot mutation-kill a wrong-counter (volatile-vs-stable) bug.** The completion note flagged substituting `clear()` for `invalidate(key)` in the periodic-refresh spec — that substitution is ACCEPTED (the architect's disposition: do NOT revert to literal `invalidate(key)`; its self-triggered competing reload masks the suppression under test, exactly as the note describes). BUT `clear()` bumps BOTH `volatileEpoch` and `stableEpoch`, so the spec passes whether the periodic reload (default `stable:true`) gates on `stableEpoch` (correct) or `volatileEpoch` (wrong) — a guard reading the wrong counter is still suppressed by `clear()` and the test stays green. The same blind spot applies to the `getOrSetSWR` cold-path and `revalidate` stable/non-stable selection: they are mutation-tested only via `clear()`/`invalidate()`, both of which bump both counters.

  Fix: add `clearVolatile()`-based companion specs (it bumps ONLY `volatileEpoch`) that distinguish the tier, mirroring the existing `getOrSet` spec `'clearVolatile() during an in-flight STABLE fetcher does NOT prevent the post-resolution cache write'`. At minimum: (a) a `clearVolatile()` mid-flight on a STABLE `registerPeriodicRefresh.reload` (and a STABLE `getOrSetSWR` cold-path / `revalidate` entry) asserting the write PROCEEDS (proves the guard reads `stableEpoch`, not `volatileEpoch`); (b) a `clearVolatile()` mid-flight on a NON-stable cold-path/revalidate entry asserting the write is SUPPRESSED (proves the non-stable gate reads `volatileEpoch`). These kill the wrong-counter mutation that the `clear()`-only specs leave alive.

**2. (P3, anchor 100, cross-reviewer: testing + correctness + maintainability) The `revalidate` invalidation spec does not assert the `staleKey` write is suppressed.** The spec asserts only that the fresh key is cold after the epoch-suppressed background refresh; it never asserts `cache.get('swr:' + key)` is undefined. Both writes gate on the same condition today, but the `staleKey` is the load-bearing one (callers are served from it for the next `staleMs` window), and a future split-gate regression would be invisible. Fix: add the `expect(await cache.get('swr:' + <key>)).toBeUndefined()` assertion to the `revalidate` invalidation spec (the cold-path spec already checks both keys).

**3. (P2, anchor 75, kieran-typescript [rated P1] + adversarial + performance) The shared `this.inflight` map admits a cross-method same-key type/behavior collision.** `getOrSet` and `getOrSetSWR` now share `inflight` (`Map<string, Promise<unknown>>`), each retrieving via `as Promise<T>`. The two methods are independently generic, so the same logical key used by both on one cache instance would share a slot carrying a mismatched `T` (the cast hides it) and the SWR caller would coalesce onto a `getOrSet` promise that never writes the `staleKey` (silently disabling stale-while-revalidate). Safe today only because `papers:<hash>` is the lone SWR key and no `getOrSet` uses it — a naming-convention invariant the type system does not enforce. Fix (preferred): namespace the SWR cold-path inflight key so cross-method collision is impossible by construction (e.g. an `swr-cold:` prefix on the `inflightKey` used by `getOrSetSWR`, distinct from `getOrSet`'s key). Acceptable alternative: document the one-key-one-method invariant at the cast site. Anchor any comment on the behavioral invariant, not on round/hold citations.

**4. (P2/P3, anchor 75-100, maintainability + kieran-typescript) Self-introduced docblock/comment drift in `cache.ts`.** (a) The private-field comment on `volatileEpoch`/`stableEpoch` still says "`getOrSet` captures both at fetcher start and gates its cache-write" — it names only `getOrSet` though three new write sites were added (the class-level docblock above it was correctly updated to enumerate all four). Update it to name all four success-path write sites (or redirect to the class-level docblock). (b) The class-level docblock describes `this.inflight` as `Map<prefixedKey, Promise<T|null>>`, but the field is declared `Map<string, Promise<unknown>>`. Correct the docblock to `Promise<unknown>` and note callers cast to their local `T` on retrieval.

### Items dismissed / deferred during architect triage

- **(adversarial, P2 conf 75) Docblock over-claims correctness on the check-then-set / inter-`set()` TOCTOU window.** The "cache stays cold for the affected tier" framing does not caveat the window where an invalidation lands between the gated `set(key)` and `set(staleKey)`. Per `agents/docs/solutions/conventions/single-flight-coalescing-amplifies-cache-invalidation-race-2026-05-20.md` the accepted disposition is DOCUMENT, don't chase at single-instance scale (do NOT add per-`set` re-checks). Folded into item 4 only as an optional one-line honesty caveat; no code change. Not load-bearing.
- **(adversarial P2 / reliability P3) Non-stable `papers:<hash>` SWR key can stay cold under sustained HAF latency > ~3s** (every fetch spanning a `clearVolatile` block-tick is suppressed). Verified: `getOrSetSWR` defaults `stable=false` and `papers.ts` passes no `stable` arg, so the key is non-stable. But the cold-stays-cold behavior IS the intended fix (don't re-cache invalidated data); persistent coldness requires sustained HAF degradation, at which point an uncached papers list is a minor symptom. Reliability's bounded/acceptable call governs. Deferred at beta scale; revisit only if production traces show it.
- **(reliability P2 conf 75) `registerPeriodicRefresh` has no reentrancy guard** (a tick can start a parallel reload if `fn()` latency exceeds the interval). Largely pre-existing scheduling structure; dormant at PEvO's minute-scale refresh intervals. Deferred (a `reloadingKeys` Set mirroring `revalidating` is the fix if ever needed).
- **(correctness/reliability, PRE-EXISTING) `invalidate(key)` does not delete the `swr:` stale key**, so it is not a valid SWR-key invalidation primitive today (latent — no caller invalidates an SWR key directly; SCAN sweeps in `clearVolatile`/`invalidatePrefix` do match `swr:`). Not introduced by this commit; out of scope. Optional follow-up: make `invalidate(key)` delete the stale key, or document the limitation.
- **(learnings) Discriminated-union-poisoning audit of `getOrSetSWR` callers** — confirm `fetchPapersFromHaf` (the sole caller) throws on error rather than returning a cacheable failure sentinel. Quick backend confirm; not a finding.
- **(kieran-typescript P3 conf 50) `flattenSqlString`-style `cooked:null` … N/A** (wrong task). Below-anchor findings suppressed by the anchor-75 gate per skill default.

### Re-review signal

When items 1–4 land, `git mv` this file back to `tasks/review/`. The mv is the re-review signal; round-2 architect review scopes `/ce-code-review` to the round-2 commit(s) only. Item 1 (the `clearVolatile` companion specs) is the load-bearing one and answers the completion note's flagged question: keep `clear()`, add the tier-distinguishing companions. Items 2 + 4 are cheap test/comment touches; item 3 is a small production change (inflight-key namespacing) — bundle or split per your preference.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>

## Backend re-review signal (2026-05-28, landed in the commit that moves this file to review/)

Round-2 hold items 1-4 landed in `backend/src/cache.ts` + `backend/tests/lib/cache.test.ts`.

1. **(item 1 — clearVolatile tier-distinguishing companions)** Added a new describe block `QueryCache — clearVolatile() tier distinction on SWR cold-path / revalidate / periodic-refresh` with 5 specs that use `clearVolatile()` (bumps ONLY `volatileEpoch`) to distinguish the counter each new guarded site reads: STABLE + clearVolatile -> write PROCEEDS (cold-path, revalidate, reload — proves the gate reads `stableEpoch`); NON-stable + clearVolatile -> write SUPPRESSED (cold-path, revalidate — proves the non-stable gate reads `volatileEpoch`). The reload spec is STABLE-only (periodic refreshes default `stable:true`). Mutation-verified: temporarily flipping the cold-path STABLE gate to read `volatileEpoch` flips the STABLE cold-path spec RED (`expected undefined to deeply equal { value: 'stable-swr' }`) while the other 4 stay green — confirming the companions kill the wrong-counter mutation the `clear()`/`invalidate()`-only specs left alive.

2. **(item 2 — staleKey-write suppression on the revalidate invalidate spec; assertion CORRECTED)** Added a stale-key assertion to the existing `revalidate` invalidate() spec. **Correction to the hold's literal prescription:** the hold said assert `cache.get('swr:swr-reval')` is `toBeUndefined()`, but `invalidate(key)` deletes only the fresh key, NOT the `swr:` stale key — the latent limitation the architect's own round-2 dismissed-item flagged ("invalidate(key) does not delete the swr: stale key"). So the stale key retains its pre-revalidate `'v1'` and never becomes undefined; asserting `toBeUndefined()` would be a RED test. The correct, mutation-killing assertion is `toEqual({ value: 'v1' })`: it proves the epoch-suppressed revalidate did NOT overwrite the stale key with `'v2-stale-snapshot'`. A split-gate regression (fresh-key write gated, stale-key write not) flips it to `'v2-stale-snapshot'`. The new clearVolatile NON-stable revalidate companion (item 1) additionally asserts the stale key ends `undefined` — because `clearVolatile()` DOES delete the non-stable stale key — covering the `toBeUndefined()` shape the hold expected, under the primitive that actually deletes the stale key.

3. **(item 3 — namespace the SWR cold-path inflight key)** Changed the `getOrSetSWR` cold-path `inflightKey` from `this.prefix + key` to `${this.prefix}swr-cold:${key}`, so a logical key used by both `getOrSet` and `getOrSetSWR` can never coalesce ACROSS methods (which would let an SWR caller await a `getOrSet` promise that never writes the stale key). Concurrent cold-misses WITHIN `getOrSetSWR` still share one fetcher (same namespaced key). Comment anchored on the behavioral invariant (cross-method collision avoidance); no round/slug/SHA citation. Verified the sole SWR caller (`papers.ts`) still passes in isolation.

4. **(item 4 — docblock/comment drift)** (a) The `volatileEpoch`/`stableEpoch` field comment now names all four success-path write sites instead of only `getOrSet`. (b) The class-level docblock now describes `this.inflight` as `Map<string, Promise<unknown>>` (matching the field declaration) with a note that each method casts to its local `T` on retrieval, and documents the item-3 distinct-key namespacing.

Verification: `npm run typecheck` (src + tests) clean; `npm run lint` 0 errors (lone warning pre-existing in `author-supersession.ts`, untouched); scoped `npx vitest run tests/lib/cache.test.ts` green (20 tests: 15 pre-existing + 5 new) in repeated isolation runs.

## Architect re-review (2026-05-28, round-2 → round-3) — HELD PENDING FIXES (2 items)

`/ce-code-review` on commit `bd619840` (correctness + adversarial on Opus; testing, maintainability, project-standards, performance, reliability, kieran-typescript on Sonnet; learnings-researcher unstructured; `ce-agent-native-reviewer` skipped per PEvO). All four round-2 fixes verified correct on the load-bearing dimensions: item 3's namespacing is symmetrically applied across the cold-path's `get`/`set`/`finally`-delete sites using a single `const inflightKey` (no asymmetric key-leak path); item 2's `toEqual({value:'v1'})` correction is sound (`invalidate(key)` does not touch the `swr:` stale key, so suppression manifests as the pre-revalidate value surviving — the implementer's divergence from the hold's literal `toBeUndefined()` is the correct reading); item 1's five `clearVolatile()` companion specs each mutation-kill their wrong-counter target (the implementer mutation-verified the cold-path STABLE spec — flipping the gate to read `volatileEpoch` flips it RED; the other four follow the same structure); item 4's "four success-path write sites" enumeration matches the actual `this.set` call sites in `getOrSet`, `getOrSetSWR` cold-path, `revalidate`, and `registerPeriodicRefresh.reload`, and the class docblock's `Map<string, Promise<unknown>>` matches the field declaration. Commit-msg zone audit clean; Co-Authored-By trailer present; task-file `git mv` landed as a single `R` rename. Two cosmetic items hold.

### Items held (must fix before archive)

**1. (P3, anchor 75 — maintainability) Inline `inflight` field comment cites a stale key-format example that contradicts the now-diverged namespacing.** The inline comment above the `inflight` field declaration still uses `${config.appTag}:cache:<routeKey>` as the concrete example for the prefixed cache key. That example was accurate when `getOrSet` was the only writer of the inflight map, but item 3's namespacing means `getOrSetSWR`'s cold-path now keys on `${this.prefix}swr-cold:${key}` (no `cache:` segment in the namespaced portion; `this.prefix` is itself configurable per-instance). The class-level docblock correctly describes both shapes; the inline field comment's partial example silently contradicts it. Fix: replace the partial example with a description that defers to the class-level docblock, e.g. "in-flight fetcher promises keyed on prefixed cache keys; `getOrSet` and `getOrSetSWR` cold-path use different namespaces (see class-level docblock for full key shape and the per-caller cast invariant)." Anchor the replacement on the symbol-level invariant, not on coordination state.

**2. (P3, anchor 75 — adversarial) Cold-path inflight-key namespacing comment overclaims "impossible by construction" on the cross-method collision invariant.** The comment above `const inflightKey = ${this.prefix}swr-cold:${key};` in `getOrSetSWR`'s cold-path asserts the cross-method collision with `getOrSet` is impossible by construction. That is true *unless* a `getOrSet` caller passes a key starting with `swr-cold:`, in which case `getOrSet`'s inflight key (`${this.prefix}swr-cold:<rest>`) collides with `getOrSetSWR(<rest>)`'s cold-path inflight key — re-introducing exactly the cross-method coalescing bug the namespacing was meant to prevent (the SWR caller would coalesce onto a `getOrSet` promise that never writes the stale key, silently disabling stale-while-revalidate). Not reachable today (sole `getOrSetSWR` caller hashes its key into `papers:<sha256-hex>`; exhaustive grep shows no `getOrSet` caller constructs a `swr-cold:`-prefixed key; all callers are first-party in `backend/src/`), so no runtime validation is warranted under PEvO's first-party-callers + single-instance posture. Fix: refine the comment to state the reserved-prefix invariant honestly — e.g., the assumption is that no `getOrSet` caller constructs a `swr-cold:`-prefixed key, a reserved-prefix invariant enforced by convention (all callers are first-party) rather than by runtime check. Anchor the comment on the symbol-level invariant; do not introduce coordination citations.

### Items dismissed / deferred during architect triage

- **(adversarial P2, anchor 60, pre-existing) Cold-path gate-check-then-write split window.** Between the post-`await fn()` epoch-check and the second `await this.set(staleKey, ...)`, a concurrent `clear()`/`clearVolatile()` can bump epochs after the gate-check captured them; both writes proceed, and Redis SCAN does not guarantee visibility of keys created mid-scan, so the sweep may not delete them. Pre-existing structure; round-2's namespacing did not change this. Bounded at single-instance scale (`clearVolatile` retries every cycle; `clear` is admin-only). Same disposition class as the round-1 TOCTOU caveat dismissal per `agents/docs/solutions/conventions/single-flight-coalescing-amplifies-cache-invalidation-race-2026-05-20.md` ("document, don't chase at single-instance scale"); suppressed by the confidence gate (P2 below anchor 75); surfaced here for completeness, not held.
- **(kieran-typescript P3 anchor 50) Residual same-method-different-T collision on `this.inflight` undocumented at the cast site.** Namespacing closes cross-method collisions by construction; within-method same-key-different-T is still a `as Promise<T>` blind spot. Class docblock describes the cast invariant adequately; suppressed by anchor gate.
- **(learnings advisory) Verify `fetchPapersFromHaf` (sole `getOrSetSWR` caller) throws on HAF error rather than returning a cacheable failure sentinel** per `agents/docs/solutions/conventions/caching-wrapper-discriminated-union-poisoning-2026-05-11.md`. Round-2's own architect dismissed-item already flagged this as a "quick backend confirm; not a finding" — restating, not re-opening.
- **(reliability testing-gap) `invalidate(key)` does not delete `swr:<key>`** — pre-existing latent limitation that the item-2 assertion correction is built upon. If a future fix changes `invalidate(key)` to also delete the stale key, the item-2 assertion shape (`toEqual({value:'v1'})`) must change to `toBeUndefined()`. Surfaced as residual testing gap, not held.

### Re-review signal

When items 1-2 land, `git mv` this file back to `tasks/review/`. The mv is the re-review signal; round-3 architect review scopes `/ce-code-review` to the fix commit only. Both items are comment-only fixes; bundle in one commit per your preference.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>

---

**Full-suite note (unrelated failures, flagged so they are NOT attributed to this commit):** A serialized `npx vitest run` surfaced an UNSTABLE failure set (5 failures on the first run, 4 on the second), all proven unrelated to this change via per-file isolation runs:
- `tests/routes/reviews.test.ts` (2 tests, SQL accreditation gate, `backend-papers-filter-accreditation lane 4`): fails DETERMINISTICALLY in isolation (the 200-expecting accredited-reviewer + anon-proxy specs return 404). `reviews.ts` does not use `getOrSetSWR`/`getOrSet`/`hafCache`, so this is a pre-existing regression in a different lane, not from this commit. Surfaced for that lane's owner — looks like the route's gate SQL drifted from the test's `installGateResponder` matcher.
- `tests/lib/cache.test.ts` `… does NOT cache null cold-path results …` (and the sibling N-concurrent coalesce specs added in THIS task's round-1, NOT round-2): intermittently fails with `fetcher called 2 times` under the Redis backend — the documented Redis-TOCTOU coalescing window (two async `get` probes before the in-flight check; the class docblock states coalescing "reduces, does not eliminate" duplication under Redis). The exact-1-call assertion only strictly holds for the in-memory backend; the spec header even claims "No Redis involved" though `getRedis()` is global when `REDIS_URL` is set. Pre-existing test-strategy gap on the N-concurrent coalesce assertions (same pattern in the archived grandparent `getOrSet` coalesce specs), NOT a round-2 regression — the round-2 specs added here are single-caller and deterministic. Recommend a SEPARATE test-determinism follow-up (run coalesce specs in-memory, or bound the assertion to the documented window) rather than folding a test-strategy change into round-2.
- `tests/routes/papers-cumulative-route-error-isolation-mocked.test.ts` (1 test, cumulative-union enrichment content): passes 2/2 in isolation -> flaky under full-suite concurrency, unrelated to inflight-key namespacing.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
