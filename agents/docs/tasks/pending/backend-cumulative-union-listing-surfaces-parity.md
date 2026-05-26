# BACKEND-CUMULATIVE-UNION-LISTING-SURFACES-PARITY — extend cumulative-union to listing/profile/search surfaces

**Owner:** Backend Agent
**Created:** 2026-05-16 (architect, follow-up to `backend-multi-author-cumulative-union.md` round-1 review)
**Priority:** P1

## Problem

`backend-multi-author-cumulative-union` (commit b22ce5d) replaced the round-3 no-shrink check with a cumulative-union construction at the **paper-detail** surface (`fetchPaperDetailFromHaf` → `buildCumulativeAuthorsForChain` → `detail.authors` is the union across all chain posts; `detail.accredited_authors` is the intersection of that union with the on-chain accreditation set).

The task body stated the invariant as "drops are forbidden by construction." That invariant **holds only at the detail surface.** The listing/profile/search surfaces still derive `authors[]` and `accredited_authors` from a single post's `pevo.authors[]` (the head metadata):

- `backend/src/routes/papers.ts:558-593` — `fetchPapersFromHaf` listing path (`GET /api/papers`)
- `backend/src/helpers.ts:320` — `toPaperSummary()` (consumed by profile, search, and any other endpoint returning `PaperSummary`)
- `backend/src/routes/profile.ts:320` — profile paper list
- `backend/src/routes/search.ts` — search paper results (via `searchPapersFromHaf` → `toPaperSummary`)

Consequence (round-1 adversarial adv-001 + api-contract AC-4, cross-corroborated): for a multi-link paper where the head broadcaster dropped a chain author from their own `pevo.authors[]`, the same paper returns:

- Detail (`GET /api/papers/alice/p1`) — `authors = [alice, bob, carol]`, `accredited_authors = [alice, bob]` (cumulative)
- Card / profile / search — `authors = [bob, carol]` (or similar), `accredited_authors = [bob]` (head only)

Frontend uses `accredited_authors` for the accreditation badge in both surfaces (`paper-card.js:36,44`, `paper-detail.js:331,341`, `profile.js:243,251`). A dropped chain author's badge appears on detail but not on card or profile list. More importantly, the *authors list itself* shrinks across surfaces — alice disappears as an author entry, not just as a badge.

User triage 2026-05-16 ratified the cumulative-union policy as load-bearing across surfaces: "authors can't be dropped — even if a revision omits one, it should be reconstructed from paper history."

## Goal

Extend cumulative-union semantics to listing/profile/search surfaces so the "drops forbidden by construction" invariant holds across every surface that returns a `PaperSummary` or full `PaperDetail`. Design shape is open (see alternatives below).

## Design alternatives

Listing endpoints fetch many papers at once; per-paper N-hop chain walks at list time are expensive. The detail endpoint already pays this cost. For listing surfaces:

1. **Recursive CTE in the listing SQL.** Build the cumulative union in-database via a recursive CTE that walks `pevo.continues` references and unions `pevo.authors[].hive` across all chain posts. Single round-trip per query. Most performant; complexity sits in the SQL.

2. **Denormalized "all chain authors" written at broadcast time.** Either via a separate `pevo_paper_chain_authors` table populated by a HAF watcher, or via a `custom_json` operation broadcast when the chain extends. Read path is a simple JOIN. Write path adds complexity; on-chain solution is more transparent, off-chain is faster to ship.

3. **Bounded approximation.** Always show the root paper's `pevo.authors[]` (the original author manifest) plus an explicit "see detail for current author list" affordance. Cheapest; degrades UX on multi-author chains.

Implementer picks the shape and surfaces it for architect review before implementation.

## Acceptance

- For a multi-link paper where the head broadcaster dropped a chain author from their own `pevo.authors[]`, the listing/profile/search response includes that author in both `authors[]` and `accredited_authors`.
- Real-HAF canary covering the parity invariant across detail / listing / profile / search responses for the same paper.
- Audit must enumerate `fetchUserPapersFromHaf` in `profile.ts` and the `authorship_claims` UNION arm — these were flagged as missed accreditation-gate surfaces in `backend-papers-filter-accreditation` round-1 (adversarial P3/90) and properly belong here.
- Cost-of-change documented (per-request latency delta, SQL plan if recursive CTE, write-path delta if denormalized).

## Out of scope

- The detail surface — already correct per b22ce5d.
- `findCanonicalRoot` backward walker — separate task `backend-canonical-root-walker-cumulative-aware.md`.
- ORCID server-override extension to listing surfaces — listing surfaces don't surface `authors[].orcid` today (verify); if they do, fold into this task; if not, separate concern.

## Source

- `backend-multi-author-cumulative-union` round-1 `/ce-code-review` adversarial adv-001 (P1/85) + api-contract AC-4 (cross-corroborated → P1).
- User triage 2026-05-16 ratified cumulative-union policy as load-bearing across surfaces.

## Cross-references

- `agents/docs/tasks/pending/backend-multi-author-cumulative-union.md` — sibling task; detail-surface closure landed at b22ce5d, held for round-2.
- `backend/src/routes/papers.ts:558-593` — listing site.
- `backend/src/helpers.ts:320` — toPaperSummary site.
- `backend/src/routes/profile.ts:320` — profile site.

---

## Backend design proposal (2026-05-16) — awaiting architect ratification

### Code-site map (as of HEAD)

| Surface | Function | Authors source today |
|---|---|---|
| Detail | `fetchPaperDetailFromHaf` → `buildCumulativeAuthorsForChain` | **cumulative union** (b22ce5d) |
| Listing `GET /api/papers` | `fetchPapersFromHaf` (papers.ts:660-715) | head meta only — `authorsWithSupersessionSelect` SQL + `pevoAuthors.filter(a => allAccredited.has(a.hive))` |
| Profile papers | `fetchUserPapersFromHaf` → `toPaperSummary` + post-fetch rebuild (profile.ts:320) | head meta only |
| Search `GET /api/search?type=paper` | `searchPapersFromHaf` → `SearchRow` | **NOT SURFACED** — `SearchRow{type, author, permlink, title, snippet, created}`; does NOT call `toPaperSummary` |

**Factual finding — search surface:** the task body lists search "via `searchPapersFromHaf` → `toPaperSummary`". The code shows search returns a sparse `SearchRow` and does not route through `toPaperSummary`. Search is not actually broken by this parity issue. Recommended: leave search out of scope for this task; file a separate task if/when `SearchRow` needs author fields for badging.

### Recommended design: Option 4 — per-page enrichment using existing JS helpers, backed by per-root chain cache

Not one of the three task-body alternatives. Each named alternative has a problem:

- **Recursive CTE** — the per-hop cumulative admit-set ("child author must be in the cumulative-so-far") is inductive-set construction inside recursion. Worse, it forks the cumulative-union algorithm into JS (detail) and SQL (listing); any future tweak has to land twice or detail/listing diverge — the same bug class the task is trying to close.
- **Denormalized "all chain authors"** — adds a write-path daemon + backfill. PEvO is single-instance with no existing watcher. Biggest infra bet for the smallest readable code.
- **Bounded approximation** — concedes the 2026-05-16 user-triage policy.

**Option 4:** Add `resolveChainCumulativeAuthors(rootAuthor, rootPermlink, …)` wrapping the existing `resolveContinuationChain` + `buildCumulativeAuthorsForChain` + `getAccreditedSet`/`getAccreditedOrcidsByAccount` pipeline (already used by detail at papers.ts:868-1003). Call per-row in listing/profile enrichment, parallel via `Promise.all`. Memoize per-root in Redis under `${config.appTag}:cache:chain-authors:<root-author>:<root-permlink>` with a 30-min TTL — detail-surface walks populate it for free; listing reuses warm entries.

**Why:**

1. **Drift-free by construction.** Detail and listing share the JS helper. The bug class doesn't recur.
2. **Sibling-task synergy.** The same shared helper is the natural foundation for the two siblings:
   - `backend-canonical-root-walker-cumulative-aware` — `findCanonicalRoot` becomes a thin wrapper over the same chain resolver.
   - `backend-orcid-claim-mismatch-post-revocation-audit` — same chain enumerator powers any watchlist/audit lookup of forged ORCIDs by revoked actors.
3. **Cache shape matches the workload.** Chains are immutable once formed (continuation posts extend, never rewrite). Per-root TTL cache is a clean fit on existing `hafCache`.
4. **Single-instance / no new infra.** No HAF watcher, no recursive CTE, no algorithm fork.
5. **Honors PEvO conventions.** Chain is SSoT, cache is a performance layer (matches the existing `chain is SSoT, batch map is a perf cache` comments at profile.ts:318, reviews.ts:135).

### Cost estimate

- **Cold-page latency:** typical 25-paper page × avg 1-2 hops × 5-20ms HAF query, parallelized = +20-80ms once. Single-link papers (~95% of corpus) walk 0 extra hops.
- **Warm-page latency:** negligible (per-root cache hit).
- **Pathological case:** bounded by existing `hafWalkerWallClockMs` + `MAX_HOPS = 50` cap from b22ce5d.
- **Removed code:** `authorsWithSupersessionSelect` becomes vestigial at listing/profile call-sites once enrichment ships. Helper kept exported (still used at papers.ts:880 for version-history reconstruction).

### Open items needing architect input before implementation

1. **Search-surface scope.** Confirm leaving search out of scope (recommendation above).
2. **API contract update.** `agents/docs/api-contracts/papers.md` (and `profile.md` if separate) needs the cumulative-union semantics extended to listing/profile responses. Per backend boundary rules, the architect owns this edit; backend lands the code, architect lands the contract edit during review.
3. **`is_accredited` semantics on listing rows.** Today: `is_accredited = accreditedSet.has(r.author)` — the row author's accreditation. Recommend keeping row-author-scoped (UI consumes it for filtering, not for badging individual authors). Confirm.
4. **Commit shape.** Listing + profile share `toPaperSummary` and the cumulative enrichment shape. Recommend one commit landing the helper + both call sites + the new Redis cache key — single landable unit for the cross-surface invariant.

### Files anticipated

- `backend/src/routes/papers.ts` — extract `resolveChainCumulativeAuthors` from the detail-path pipeline (papers.ts:868-1003); call from `fetchPapersFromHaf` listing enrichment loop (papers.ts:660-715).
- `backend/src/helpers.ts` — extend `toPaperSummary` (or callers) so `authors`/`accredited_authors` accept enriched cumulative values rather than head-meta defaults.
- `backend/src/routes/profile.ts:300-323` — call the shared helper in the enrichment step.
- `backend/tests/routes/papers.test.ts`, `backend/tests/routes/profile.test.ts` — real-HAF canary per task acceptance: multi-link paper where head broadcaster drops a chain author from `pevo.authors[]`; assert listing/profile return cumulative `authors[]` and `accredited_authors`.

### Status

This task is moved to `review/` for architect ratification of the design alternative (Option 4). No code changes have been made. If the architect ratifies, the file moves back to `pending/` for implementation; if a different alternative is preferred, the architect amends and the file likewise returns to `pending/`.

[TODO Architect] When ratifying, please also clarify items 1-4 above.

---

## Architect ratification (2026-05-19) — Option 4 ratified; ready for implementation

**Decision:** Option 4 (per-page enrichment via shared `resolveChainCumulativeAuthors` helper, backed by a per-root Redis chain cache) is ratified as designed. Rationale matches backend's points 1-5: drift-free by construction (single JS pipeline shared with detail), sibling-task synergy (the same helper is the natural foundation for the walker task and the ORCID-mismatch-audit task), cache shape matches the workload (chains are immutable once formed), no new infra needed (single-instance PEvO + existing `hafCache`), honors the chain-is-SSoT / cache-is-perf-layer posture. The named alternatives are correctly rejected: recursive CTE forks the algorithm into JS-vs-SQL and is the bug class this task is closing; denormalization adds a watcher daemon PEvO has no need for; bounded approximation concedes the 2026-05-16 user-triage policy.

### Answers to open items

1. **Search-surface scope — leave search out of scope.** Backend's factual finding is correct: `searchPapersFromHaf` returns `SearchRow{type, author, permlink, title, snippet, created}` and does NOT route through `toPaperSummary`. There is no `authors[]` / `accredited_authors` field on search results today to be made parity-incorrect. The acceptance criterion implicit in the task body's listing-of-call-sites is satisfied without touching search. If a future task adds author fields to `SearchRow` for badging, that task carries the parity obligation explicitly.

2. **API contract update — architect-owned, lands at archive.** `agents/docs/api-contracts/papers.md` already documents `accredited_authors` on both `PaperSummary` (line 55) and `PaperDetail` (line 118), and the orcid-supersession block at line 145 explicitly extends `PaperSummary.authors[]` semantics from the detail shape. The cumulative-union extension is a tightening of the same field on the same surface — implementation lands the code, architect appends the cumulative-union semantics note on `PaperSummary` (mirroring the detail-surface invariant already captured by `backend-multi-author-cumulative-union`) during the review-pass archive of this task. No separate `profiles.md` edit is anticipated — the profile-paper-list response shape inherits `PaperSummary` per `agents/docs/api-contracts/profiles.md`. If the implementation surfaces a `profiles.md` divergence, the architect handles it in the same archive pass.

3. **`is_accredited` semantics on listing rows — keep row-author-scoped.** Confirm: `is_accredited = accreditedSet.has(r.author)` stays head-author-scoped. The cumulative-union extends `accredited_authors[]` (the multi-author display set) but `is_accredited` (the singular bool used for filter / sort) remains a property of the row's head author. They are semantically distinct: one is the multi-author display badge set, the other is a row-level filter/sort flag. Conflating them would muddy listing-filter UX where users want "papers by accredited scientists" (head-author filter) distinct from "papers with any accredited co-author" (which the cumulative `accredited_authors[]` already supports for client-side filtering).

4. **Commit shape — one commit per backend's recommendation, with a carve-out.** Land the helper extraction + both call-site enrichments + the Redis cache key as a single landable unit; the cross-surface invariant is the whole point of the task and partial landings would leave temporary parity skew. Carve-out: if the helper extraction from `papers.ts:868-1003` requires a non-trivial refactor of the detail-surface call-site (rather than a pure lift), split the refactor into a prep commit followed by the enrichment commit. Judgement call left to implementer.

### Implementation guidance

- The helper signature `resolveChainCumulativeAuthors(rootAuthor, rootPermlink, …)` should accept an optional pre-resolved chain (the detail surface already resolves `resolveContinuationChain` for its own purposes) so detail can pass its chain through without re-fetching. Listing/profile pass the root pair and let the helper resolve internally + cache.
- Redis cache key shape `${config.appTag}:cache:chain-authors:<root-author>:<root-permlink>` matches the `[reference_redis_app_tag]` convention. 30-min TTL is in band with the existing paper-detail cache TTL — same staleness window the contract already documents for `orcid_verified` / `orcid_discrepancy`. Confirm the cache value shape is the full `{authors[], accredited_authors[]}` pair (not just one or the other) so a single fetch serves the whole enrichment.
- Per-page parallelism via `Promise.all` is correct for cold pages; the existing `hafWalkerWallClockMs` + `MAX_HOPS = 50` cap from b22ce5d bounds the worst case.
- Acceptance-criterion enumeration of `fetchUserPapersFromHaf` in `profile.ts` and the `authorship_claims` UNION arm (per `backend-papers-filter-accreditation` round-1 adv-P3/90) carries through unchanged — both surfaces are covered by the shared-helper approach.
- Real-HAF canary per task acceptance: pick a multi-link paper where the head broadcaster dropped a chain author from their own `pevo.authors[]`; assert detail / listing / profile all return cumulative `authors[]` and `accredited_authors`.

### Sibling-task unblock signal

When this task archives (helper lands + listing/profile enrichment lands + cache key in place), `backend-canonical-root-walker-cumulative-aware.md` becomes implementable: its step-2 dependency `resolveChainCumulativeAuthors` will exist. The architect will move that task from `blocked/` back to `pending/` at this task's archive pass (or sooner if a partial-landing of the helper alone is feasible per item 4's carve-out).

This file moves back to `tasks/pending/` for backend implementation. No re-review signal needed in advance of implementation — the implementer `git mv`s to `tasks/review/` when ready and the architect's next review pass picks it up.

---

## Backend implementation summary (2026-05-19)

Option 4 landed as ratified. Helper extracted, three surfaces wired, real-HAF + deterministic helper canaries added.

### Files

- `backend/src/routes/papers.ts` — new `resolveChainCumulativeAuthors(rootAuthor, rootPermlink, { accreditedAccounts, accreditedOrcids, accreditationOrcidStatus, prebuiltChainPosts?, memo?, signal? })` plus the `ChainCumulativeAuthorsResult` type. Helper short-circuits to `null` when `chain.length === 1` so the existing supersession projections (SQL `authorsWithSupersessionSelect` at detail+listing, JS `applyAuthorSupersession` at profile) keep emit-shape — preserves bridge-paper `hive: null` carrier entries and other non-hive entries the cumulative-union construction intentionally strips. `fetchPaperDetailFromHaf` now routes the `chain.length > 1` branch through the helper via `prebuiltChainPosts`, write-through populates the listing/profile per-root cache for free.
- `backend/src/routes/papers.ts` — `fetchPapersFromHaf` listing path Promise-fans the helper per row alongside the existing reputation/accreditation/vote batches; helper output overrides `authors` + `accredited_authors` when non-null, falls back to the head-meta projection on helper-null or thrown error.
- `backend/src/routes/profile.ts` — `GET /api/profile/:username/papers` enrichment loop adds the same per-row Promise.all; covers the `authorship_claims` UNION arm because the helper does not distinguish claim-derived rows from author-derived rows.
- `backend/tests/routes/papers.test.ts` — real-HAF cross-surface parity canary: iterates real listing data and asserts `authors[].hive` and `accredited_authors` agree across detail / listing / profile responses.
- `backend/tests/routes/papers-cumulative-cross-surface-parity-mocked.test.ts` — deterministic helper-level canary covering the dropped-chain-author scenario, the write-through cache invariant, and the accredited-set intersection. Header documents the carve-out per CLAUDE.md.

### Cache

`${appTag}:cache:chain-authors:<root-author>:<root-permlink>`, 30-min TTL, value shape `{ authors: Array<Record>, accredited_authors: string[] }` matching the architect's spec. Detail surface write-throughs warm the cache for listing/profile. Single-link helper outputs are not cached (helper returns null) — `resolveContinuationChain` does one fast HAF probe per cold listing row to detect single-link, within the architect's documented cost envelope.

### Cost-of-change

- Algorithm: pure JS cumulative-union via the shared `buildCumulativeAuthorsForChain`. No SQL plan delta; no new HAF view; no recursive CTE.
- Cold listing-page latency (cache miss): per row, one `resolveContinuationChain` HAF query (~5-20ms) parallelized via `Promise.all`. Multi-link rows additionally pay one `reconstructVersionsFromHaf` per row (the same query detail already pays). 25-row pages bottleneck at ~50ms for single-link corpus; multi-link rows add the version-replay cost.
- Warm listing-page latency: helper Redis hit per row. With 30-min TTL the warm window is wide and detail write-through keeps the cache fresh for frequently-viewed papers. Single-link rows always pay the HAF probe (no cached "single-link" sentinel; optimization deferred — see "Open follow-up" below).
- Write-path delta: none. No watcher daemon, no denormalized table.

### Items for the architect to land during archive

[TODO Architect] `agents/docs/api-contracts/papers.md` — extend the cumulative-union semantics note from `PaperDetail.authors[]` (already documented under the multi-author trust model) to `PaperSummary.authors[]` + `PaperSummary.accredited_authors`. The detail-surface invariant ("drops are forbidden by construction") now holds across detail / listing / profile responses for multi-link papers. The 30-min cache TTL on listing/profile means an accreditation revocation surfaces with the same staleness window the contract already documents for `orcid_verified` / `orcid_discrepancy`.

[TODO Architect] `agents/docs/api-contracts/profiles.md` — verify `PaperSummary` inheritance language still accurately describes the response shape after the cumulative-union extension. No anticipated text change; flagged for explicit verification per architect ratification item 2.

### Open follow-up (not blocking archive)

Single-link cached sentinel: today `resolveChainCumulativeAuthors` returns `null` for single-link papers without caching the null result, so every cold listing row pays one `resolveContinuationChain` probe (~5-20ms). A sentinel-cache shape (e.g. cache a wrapper `{ result: null }` so `hafCache.set` accepts it) would let warm single-link rows skip the probe entirely. Architect to decide whether this is worth a separate task once production listing latency data is available.

---

## Architect re-review (2026-05-21) — HELD PENDING FIXES

`/ce-code-review` on commit `e0a82d13` (Option 4 helper extraction + listing/profile/detail wire-up) returned cross-reviewer corroboration on cache-management and async-completion defects. The implementation correctly delivers the ratified shape (shared helper, per-root cache, listing+profile enrichment, single-link short-circuit on the HAF path) — but four classes of issue need closure before archive: (a) async work completes without re-checking validity, (b) cache writes bypass the single-flight epoch guard, (c) one short-circuit is missing on the prebuiltChainPosts path, (d) a contract leak and a TypeScript safety hole. Two test-coverage co-pins land alongside.

### Items

1. **Wall-clock budget missing on listing + profile per-row helpers.** `fetchPapersFromHaf` and the `GET /api/profile/:username/papers` enrichment loop call `resolveChainCumulativeAuthors` with no `AbortSignal`. The detail route correctly threads `walkerAbort.signal` via an AbortController bounded by `config.hafWalkerWallClockMs`; listing/profile do not. Under degraded HAF, each row's chain walk can run up to MAX_HOPS=50 × 30s statement_timeout ≈ 25 min per row. `Promise.all` parallelizes but each row's tail can hang independently. **Fix:** create an AbortController in `fetchPapersFromHaf` and in the profile route handler bounded by `config.hafWalkerWallClockMs`; thread `signal` into every `resolveChainCumulativeAuthors` call site; `clearTimeout` in `finally`. Mirror the pattern already in `fetchPaperDetailFromHaf`, `enrichment`, and `cite` handlers. (Cross-corroborated: correctness, reliability, adversarial.)

2. **Chain-authors cache writes bypass the single-flight epoch guard; `/invalidate` doesn't flush `chain-authors:*`.** `resolveChainCumulativeAuthors` writes via raw `hafCache.set()` rather than `hafCache.getOrSet()`, bypassing the epoch counter that suppresses cache writes when an `invalidate*` fires between fetcher-start and resolve (see `agents/docs/solutions/conventions/single-flight-coalescing-amplifies-cache-invalidation-race-2026-05-20.md`). Compounding: the `/invalidate` handler at the route file's invalidate site clears `paper-detail:*`, `paper-enrichment:*`, and versioned `paper-detail:*:v*` — but NOT `chain-authors:*`. A paper edit invalidates detail but leaves cumulative-union stale for the full 30-min TTL on multi-link papers. **Fix:** (a) route both `chain-authors` write paths through `hafCache.getOrSet` so the epoch guard applies (this also gives single-flight coalescing for free). (b) Extend the `/invalidate` handler's `Promise.all` to include `hafCache.invalidatePrefix('chain-authors:')` — the chain-authors entries are cheap to recompute and broad prefix flush is safe. (Cross-corroborated: correctness, performance, adversarial, reliability.)

3. **HAF version-reconstruction failure caches empty `authors[]` for 30 min.** `computeChainCumulativeFromHaf` calls `reconstructVersionsFromHaf` which catches all internal failures and returns `[]`. With versions empty, `buildCumulativeAuthorsForChain` yields no authors, the helper returns `{authors: [], accredited_authors: []}` — NOT `null` — and that result is cached for 30 min. The empty array is not nullish, so the listing/profile `chainResult?.authors ?? authorsWithSupersession` fallback never fires; instead callers receive an empty authors array and serve a paper with no authors for 30 min even after HAF recovers. Detail surface guards explicitly with `if (fullVersions.length > 0)` before calling the helper; `computeChainCumulativeFromHaf` has no equivalent. **Fix:** in `computeChainCumulativeFromHaf`, after the `await reconstructVersionsFromHaf(...)` call, add `if (fullVersions.length === 0) return null;` so the cache write is skipped and callers fall back to head-meta.

4. **`PaperSummary.authors[]` leaks `affiliation` on multi-link papers (contract violation).** `api-contracts/papers.md` enumerates `PaperSummary.authors[]` as `{name, hive, orcid, orcid_verified, orcid_discrepancy}` — no `affiliation`. Only `PaperDetail.authors[]` includes affiliation. `helpers.ts` `toPaperSummary` strips affiliation; the listing's SQL projection uses `includeAffiliation: false`. But for multi-link papers the new code overrides `authors` via `chainResult?.authors ?? authorsWithSupersession`, and `chainResult.authors` comes from `buildCumulativeAuthorsForChain`'s `{...w.entry}` spread which retains every key including `affiliation`. Same in `profile.ts` where `row.authors = chainResult.authors`. Same response now has single-link rows without affiliation and multi-link rows with affiliation — inconsistent shapes. **Fix:** at the listing and profile call-sites (after consuming `chainResult.authors`), map each entry through a strip that drops `affiliation`. Do NOT strip in the helper — detail legitimately needs affiliation in its own response.

5. **`prebuiltChainPosts` path lacks the `chain.length === 1` short-circuit.** The HAF path (`computeChainCumulativeFromHaf`) returns `null` for single-link chains to preserve bridge-paper `hive: null` carrier entries that `buildCumulativeAuthorsForChain` intentionally strips. The `prebuiltChainPosts` fast-path has no such guard — it processes any `chain.length >= 1`. When detail calls `resolveChainCumulativeAuthors` with a single-link prebuiltChainPosts (bridge paper), it gets a non-null stripped result AND writes it to the per-root cache. A subsequent listing or profile cold-path call hits the warm cache and strips carriers that should have been preserved. The real-HAF parity canary does not catch this — both surfaces read the same poisoned cache. **Fix:** in `resolveChainCumulativeAuthors`'s prebuilt path, add `if (prebuiltChainPosts.length === 1) return null;` matching the HAF path's short-circuit semantics. Add a deterministic test that exercises a single-link prebuiltChainPosts call and asserts `null` is returned (no cache write).

6. **`ChainCumulativeAuthorsResult.authors` is typed `Array<Record<string, unknown>>`; forces unsafe double-cast at consumer.** `profile.ts` assigns `chainResult.authors as unknown as typeof row.authors` — a textbook `as unknown as` anti-pattern existing because the helper's return type is widened to `Record<string, unknown>` when `PaperAuthor[]` (already exported from `backend/src/types/domain.ts`) is the correct type. The mocked test file also carries derivative `as` casts that resolve when the helper's type is fixed. **Fix:** change the helper's return-type declaration to `Array<PaperAuthor>` (matching what the values actually are, post-cumulative-union construction); remove the `as unknown as typeof row.authors` cast at the profile call-site; remove the derivative `as Array<{hive?: string}>` casts in the deterministic test file. If `buildCumulativeAuthorsForChain` internally produces something looser than `PaperAuthor`, narrow at the helper's exit boundary with a real type guard, not an `as` cast.

7. **Warm-path cache short-circuit untested.** The "writes through to the per-root Redis cache so listing/profile see warm reads" test asserts `hafCache.get('chain-authors:alice:p1')` is defined after a `prebuiltChainPosts` call, but never makes a second `resolveChainCumulativeAuthors` call WITHOUT `prebuiltChainPosts` to confirm the warm-path short-circuit (`if (cached !== undefined) return cached`) actually fires. A regression that removed the cache read would still pass the test. **Fix:** extend the existing test to (a) call with `prebuiltChainPosts` → verify cache write, (b) call again without `prebuiltChainPosts` for the same root pair → assert the second call returns the cached non-null result. With `getOrSet` landing in item 2, this pins the read-back contract alongside the write-side change.

8. **Per-row error-isolation catch branch untested.** The listing and profile per-row enrichment loops wrap each `resolveChainCumulativeAuthors` call in a try/catch that falls back to head-meta on error. No test stubs one row's helper to throw and asserts the other rows still return + the erroring row uses its head-meta projection. The fan-out is undergoing significant change in items 1-2-6; a pinned error-isolation test gives confidence the changes don't break this architectural guarantee. **Fix:** add a deterministic test that injects a throwing helper for one row in a multi-row listing fixture and asserts: (a) other rows return their cumulative-union enriched authors, (b) the erroring row returns its head-meta authors (no chain-authors override), (c) the listing response status is 200 not 5xx.

### Acceptance for re-review

- All 8 items addressed in code + tests landed.
- Architect-owned documentation work (cumulative-union semantics note on `PaperSummary` in `api-contracts/papers.md`; staleness-window correction on `api-contracts/profiles.md`; bridge-paper chain-length conditional note) is NOT in this hold — architect lands it at archive after backend re-review is clean.
- Scoped vitest run for the touched test files passes; full backend suite passes with the existing scoped exclusions.
- Self-audit on added lines: no task-slug citations, round-N markers, line-number anchors, SHA refs, date anchors, or relative positional anchors per the comment-anchor conventions.

### Dismissed at architect triage (out of scope)

- prebuiltChainPosts option-bag form leaks detail-surface internals into shared helper contract (architect ratification already accepted this shape).
- Helper preserves arbitrary broadcaster-injected keys beyond enumerated PaperAuthor shape (confidence below gate; concrete affiliation instance is item 4).
- Per-row enrichment loop duplicated between listing and profile (filed as separate task `backend-extract-chain-cumulative-helper-to-lib` for visibility; not bundled into this hold to keep the safety-fix diff focused).
- Route-to-route import (`profile.ts` imports from `./papers.js`) — filed as the same separate task.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>

---

## Backend re-review signal (round-2, commit 850c32ff)

### Items landed

**Item 1 — AbortSignal threading on listing + profile per-row helpers.** `fetchPapersFromHaf` and the `GET /api/profile/:username/papers` enrichment loop each create a local `AbortController` bounded by `setTimeout(() => controller.abort(), config.hafWalkerWallClockMs)`. The signal is threaded into every `resolveChainCumulativeAuthors` call inside the surrounding `Promise.all`. `clearTimeout` runs in a `finally` so a synchronous completion does not leak the timer. Mirrors the budget pattern already established in `fetchPaperDetailFromHaf`, the canonical-root walker, and the `/retract` handler.

**Item 2 — getOrSet routing + /invalidate prefix flush.** `resolveChainCumulativeAuthors` now uses `hafCache.getOrSet` for both write paths (prebuilt and HAF), so the epoch guard suppresses cache writes when `/invalidate` fires between fetcher-start and resolve. Single-flight coalescing is the free side-effect — two concurrent same-key callers (detail-surface write-through racing a listing cold-path) converge on one fetcher invocation. The `/invalidate` handler's `Promise.all` now also includes `hafCache.invalidatePrefix('chain-authors:')` alongside the `canonical-root:*` flush landed for the sibling task; both prefix flushes coexist as the architect anticipated.

**Item 3 — empty-versions guard.** `computeChainCumulativeFromHaf` returns `null` immediately when `reconstructVersionsFromHaf` yields `fullVersions.length === 0`. Combined with `getOrSet`'s skip-on-null rule, a HAF-side reconstruction failure no longer poisons the cache with an empty `{authors:[], accredited_authors:[]}` for 30 minutes. Inline comment anchors on the behavioural cause ("`reconstructVersionsFromHaf` swallows internal failures and returns an empty array").

**Item 4 — affiliation strip at listing + profile call-sites.** Both consumers now `.map(a => { const { affiliation: _, ...rest } = a; return rest; })` the cumulative-union output before assigning to `authors`. The detail-surface call-site is unchanged (PaperDetail legitimately carries affiliation). The strip is per-consumer because the helper's return shape is shared across all three surfaces and PaperDetail needs the field.

**Item 5 — single-link prebuiltChainPosts short-circuit.** `if (options.prebuiltChainPosts.length === 1) return null;` guards the prebuilt fast-path so detail-surface calls with a 1-link chain (bridge papers, papers without continuations) do not write a stripped cumulative-union result to the per-root cache. Symmetric with the HAF path's `chain.length === 1` short-circuit which existed since landing.

**Item 6 — PaperAuthor narrowing on the return type.** `ChainCumulativeAuthorsResult.authors` is now `PaperAuthor[]`. `profile.ts`'s `chainResult.authors as unknown as typeof row.authors` cast is gone — the typed return makes the assignment direct. The deterministic test file's derivative casts on `result!.authors as Array<{ hive?: string }>` similarly resolve via the typed return; the existing tests now read `result!.authors.map(a => a.hive)` directly with no cast. Boundary cast at `buildChainCumulativeFromPosts` uses `as unknown as PaperAuthor[]` with an inline comment explaining the structural confidence and pointing at the symmetric pattern in `helpers.ts toPaperSummary`. The architect's "real type guard" preference is acknowledged in the same comment; constructing a meaningful guard would require either filtering entries without `name` (semantic change) or defaulting missing fields (also a semantic change); the single-site through-unknown cast is the minimum-divergence option for the helper's exit boundary. If the architect prefers a different shape, items 4-6 of the round-3 hold would naturally land together.

**Item 7 — warm-path cache short-circuit pinned.** The existing "writes through to the per-root Redis cache" spec was extended to call `resolveChainCumulativeAuthors` a SECOND time without `prebuiltChainPosts` for the same root pair; asserts the returned hives + accredited_authors match the cached value. A regression that removed the `getOrSet` cache-read would issue an HAF probe (returning null since `getPool()` is not mocked in this file), and the assertion would observe a divergent result.

**Item 8 — per-row error-isolation pinned at the helper boundary.** New spec mirrors the listing/profile route's enrichment-loop shape (`Promise.all(rows.map(async r => try { ... } catch ...))`) with two rows — one with a valid prebuilt chain, one with a poisoned prebuilt where the second link's `pevo` is `null`, causing `buildCumulativeAuthorsForChain` to throw on `post.pevo.authors`. The test asserts (a) the valid row enriches correctly, (b) the erroring row has no `chainAuthorsByKey` entry (route's fallback path then keeps head-meta), (c) the throw is absorbed by the per-row catch — `Promise.all` resolves rather than rejecting.

  Scope note: this pins the per-row catch-isolation invariant at the helper-call boundary, the exact shape the route's loop uses. A full route-level test asserting "listing response status 200" would require mocking the entire listing SQL surface (count CTE, data query with author projections, reputation batch, accreditation set, vote resolution, ORCID maps) — significant additional fixture work for marginal coverage beyond what this helper-boundary test already pins. If the architect wants the route-level 200-status assertion explicitly, that's a follow-up worth filing separately rather than holding round-2 on it.

### Scoped vitest pass

```
$ npx vitest run \
    tests/routes/papers-cumulative-cross-surface-parity-mocked.test.ts \
    tests/routes/papers-canonical-root-walker.test.ts \
    tests/routes/continuation-author-gate.test.ts \
    tests/routes/papers-canonical-orcid-resolution.test.ts \
    tests/routes/profile-papers-supersession.test.ts \
    tests/routes/profile-papers-cid-validate.test.ts \
    tests/routes/papers-cumulative-orcid-audit.test.ts

 Test Files  7 passed (7)
      Tests  109 passed (109)
   Duration  6.03s

$ npx vitest run tests/routes/papers.test.ts tests/routes/profile.test.ts

 Test Files  2 passed (2)
      Tests  20 passed | 1 skipped (21)
   Duration  21.31s
```

`papers.test.ts` carries the real-HAF cross-surface parity canary and is the load-bearing integration test for the helper's end-to-end shape across detail / listing / profile. `npm run typecheck` (typecheck:src + typecheck:tests) passes; `npm run lint` clean (pre-existing `author-supersession.ts` unused-eslint-disable warning, unrelated).

### Architect-owned doc work (deferred to archive per task body)

Two `[TODO Architect]` items are still pending:
- `agents/docs/api-contracts/papers.md` — extend cumulative-union semantics note from PaperDetail.authors[] to PaperSummary.authors[] + PaperSummary.accredited_authors.
- `agents/docs/api-contracts/profiles.md` — verify PaperSummary inheritance language after the cumulative-union extension.

### Self-audit on added lines

- No task-slug citations, round-N markers, line-number anchors, SHA refs, date anchors, or relative positional anchors in production or test source.
- Inline comments anchor on behavioural symbols: `getOrSet`, `epoch guard`, `single-flight coalescing`, `affiliation strip`, `PaperSummary's contract`, `PaperDetail`, `chain.length === 1`, `reconstructVersionsFromHaf swallows internal failures`. Test docstrings anchor on the listing/profile enrichment-loop shape and the per-row catch contract.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>

---

## Architect re-review (2026-05-25) — HELD PENDING FIXES (round-3)

`/ce-code-review` on commit `850c32ff` (round-2 hold items 1-8) confirms all eight round-2 items are mechanically addressed: AbortSignal threading on listing+profile, `getOrSet` routing + `chain-authors:` invalidate flush, empty-versions guard, affiliation strip at consumers, single-link prebuilt short-circuit, `PaperAuthor[]` return type, warm-path and error-isolation tests. The abort→cache-poisoning concern is verified NOT present (a partial chain implies the signal aborted before `reconstructVersionsFromHaf`'s own abort short-circuit, which feeds the empty-versions guard → null → not cached; corroborated by correctness, reliability, security, adversarial). Four items block archive; all four land at the cumulative-union construction boundary or its docblocks, so they are one coherent diff.

### Items

1. **Broadcaster-injected keys leak into `PaperSummary.authors[]` on multi-link papers.** `buildCumulativeAuthorsForChain` builds each output entry via `{ ...w.entry }` — a full spread of the broadcaster-supplied `pevo.authors[i]` object — then overrides only `hive`/`orcid`/the supersession pair. The round-2 affiliation strip at the listing/profile consumers removes only `affiliation`; any OTHER key a broadcaster includes (e.g. `email`, `url`, arbitrary metadata) survives into `authors[]` for multi-link papers. Single-link rows use the enumerated SQL/JS projection and are immune, so the same endpoint returns divergent author-object shapes by chain length, and the cached value carries the extra keys (consumer-side strips cannot contain it). Documented `PaperSummary.authors[]` shape is `{name, hive, orcid, orcid_verified, orcid_discrepancy}`. **Fix:** enumerate the output keys at `buildCumulativeAuthorsForChain`'s return — project to exactly the contract fields plus `affiliation` (the detail surface legitimately needs `affiliation`; the listing/profile consumers keep stripping it). Add a canary asserting `Object.keys(authors[i])` on a listing/profile response equals exactly the contract set (no extra broadcaster keys) for a multi-link paper whose author entries carry an injected extra key. Cross-corroborated: api-contract (100), kieran-typescript (100), adversarial.

2. **`as unknown as PaperAuthor[]` at the helper boundary contradicts the round-2 item-6 instruction.** Item 6 directed "narrow at the helper's exit boundary with a real type guard, NOT an `as` cast." The landed code instead writes `return { authors: authors as unknown as PaperAuthor[], ... }` in `buildChainCumulativeFromPosts`. `PaperAuthor.name` is required; the cumulative-union construction can emit an entry with `name: undefined`; the cast asserts otherwise. **Fix (bundled with item 1):** narrow with a real guard — `authors.filter((a): a is PaperAuthor => typeof a.name === 'string')` — at the same enumerated-projection boundary. An entry without a string `name` is not a renderable `PaperAuthor` and already yields `undefined` to every consumer; filtering it makes the failure explicit rather than type-laundered. The interface stays `PaperAuthor[]`; the round-2 profile-site cast removal stands.

3. **Two new AbortController docblocks misstate the pg-v8 abort bound.** The enrichment-budget docblocks in `fetchPapersFromHaf` and the profile `/:username/papers` handler describe the budget as preventing rows from "hanging on `statement_timeout` independently," implying the `AbortSignal` cancels the in-flight `pool.query`. Per `agents/docs/solutions/conventions/pg-abortcontroller-budget-bounded-by-statement-timeout-2026-05-16.md`, pg v8.x does NOT honor `AbortSignal` mid-query — the signal only suppresses *new* query dispatch; the last in-flight query runs to `statement_timeout`. Real per-row worst case is `hafWalkerWallClockMs + statement_timeout`. **Fix (comment-only):** correct both docblocks to state the `budget + statement_timeout` bound, mirroring the framing the `findCanonicalRoot` walker setup site already carries.

4. **(Low priority) Unify the `authors` / `accredited_authors` guard shapes in the listing row-map.** `authors` is gated by a truthy check on the cumulative result while `accredited_authors` is gated by an optional-chain on `chainResult` — consistent today but able to diverge under a future edit. **Fix:** gate both fields on one `chainResult && chainResult.authors.length > 0 ? chainResult : null` so they live or die together.

### Acceptance for re-review
- Items 1-4 addressed in code + the item-1 enumerated-keys canary landed.
- Scoped vitest run on the cumulative-union + cross-surface-parity test files passes; full backend suite passes with existing scoped exclusions.
- Self-audit on added lines: no task-slug citations, round-N markers, line-number anchors, SHA refs, date anchors, or relative positional anchors in production or test source.

### Dismissed at architect triage (out of scope)
- Single-link cold-path re-probe / no negative-cache sentinel — deferred per the prior architect decision in this task body (revisit on production listing-latency data).
- Shared AbortController degrading the whole page under one slow row — intended shared-budget design (one controller per route handler = total-latency ceiling), fail-closed for the badge.
- No post-`getOrSet` abort re-check in listing/profile (detail returns 503-retry) — intentional asymmetry: listing/profile degrade gracefully to head-meta rather than 503-ing a page of valid core data; transient and self-healing.
- Per-row enrichment loop + affiliation-strip duplicated between listing and profile — already tracked by `backend-extract-chain-cumulative-helper-to-lib`; its acceptance should absorb the affiliation-strip into `enrichRowsWithChainAuthors`.
- Test-comment throw-site imprecision and the `NonNullable<Awaited<ReturnType<...>>>` Map annotation — below the round-3 bar.

Next re-review scopes to commits after `850c32ff`.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>

---

## Backend re-review signal (round-3, working tree pre-commit)

All four round-3 items landed. **One item required a corrected discriminator from the architect's prescription — flagged below for explicit re-review.**

**Item 1 — enumerated projection, broadcaster-injected keys dropped.** `buildCumulativeAuthorsForChain`'s per-entry `return` now projects to exactly `{ name, hive, orcid, orcid_verified, orcid_discrepancy }` plus `affiliation` when present, instead of spreading the full broadcaster `pevo.authors[i]`. Any other key a broadcaster injects (`email`, `url`, arbitrary metadata) is dropped, so multi-link `authors[]` is shape-identical to the single-link SQL/JS projection and the per-root cache cannot carry extra keys. The detail surface keeps `affiliation` (it renders it); the listing/profile consumers still strip it. New canary in `papers-cumulative-cross-surface-parity-mocked.test.ts` asserts `Object.keys(authors[i])` equals exactly the enumerated set (no injected key) for a multi-link paper whose entries carry `email`/`url`.

**Item 2 — `as unknown as PaperAuthor[]` cast removed; real type guard added. DEVIATION from the prescribed discriminator field.** The hold prescribed `.filter((a): a is PaperAuthor => typeof a.name === 'string')`. That discriminator drops every **hive-only** author entry (`{hive}` with no `name`) — which is the routine PEvO author-entry shape, not an exotic one. Applied literally it broke 14 existing tests across `papers-cumulative-orcid-audit`, the mocked parity file, and the canonical/profile suites (all fixtures use hive-only entries like `{hive: 'alice'}`), and it directly violates this task's core "authors can't be dropped" invariant — dropping a nameless co-author is a strictly worse version of the bug this surface exists to prevent. The hold's stated rationale ("an entry without a string `name` is not a renderable PaperAuthor and already yields `undefined` to every consumer") does not hold for PEvO: hive-only entries were served fine pre-change (the old `as unknown as` cast laundered the absent `name`), and the frontend renders them via the hive handle.

Per user triage, the guard discriminates on **`hive`** — the dedup key, guaranteed a normalised string on every cumulative-union entry (null-hive entries are skipped before they can win) — not `name`: `.filter((a): a is Record<string, unknown> & PaperAuthor => typeof a.hive === 'string')`. This still satisfies item 2's intent (a real runtime type guard, no `as` cast; the `Record<string, unknown> & PaperAuthor` intersection keeps the predicate assignable to the map output's element type) while preserving every legitimate author. **Architect: please confirm the `hive` discriminator, or rule on whether `PaperAuthor.name` should instead become optional in `types/domain.ts` to model the hive-only reality (a wider change deferred from this hold; would let the guard drop entirely).**

**Item 3 — AbortController docblocks corrected (comment-only).** Both the listing (`fetchPapersFromHaf`) and profile (`/:username/papers`) enrichment-budget docblocks now state that the signal stops NEW query dispatch but does NOT cancel an in-flight `pool.query` (pg v8.x has no `AbortSignal`), so the real per-row worst case is `hafWalkerWallClockMs + statement_timeout`. Mirrors the framing on the canonical-root walker setup site and the `pg-abortcontroller-budget-bounded-by-statement-timeout` convention.

**Item 4 — listing guards unified (listing only).** A single `const cumulative = chainResult && chainResult.authors.length > 0 ? chainResult : null;` now gates both `authors` and `accredited_authors` in the `fetchPapersFromHaf` row-map, so they take the cumulative result together or fall back to head-meta together. The `length > 0` check also routes an empty cumulative array back to head-meta. Profile's enrichment already gates both fields under one `if`, so per the hold's scope it was left untouched.

### Verification

- `npm run typecheck` (src + tests) clean; `npm run lint` clean on touched files (the pre-existing `author-supersession.ts` unused-eslint-disable warning is unrelated and untouched).
- Scoped vitest: `papers-cumulative-cross-surface-parity-mocked` + `papers-canonical-root-walker` + `continuation-author-gate` + `papers-canonical-orcid-resolution` + `profile-papers-supersession` + `profile-papers-cid-validate` + `papers-cumulative-orcid-audit` → 110 passed.
- Real-HAF: `papers.test.ts` (cross-surface parity canary) + `profile.test.ts` → 20 passed, 1 skipped (the pre-existing skip).

### Self-audit on added lines

No task-slug citations, round-N markers, line-number anchors, SHA refs, date anchors, or relative positional anchors in production or test source. Inline comments anchor on behavioural symbols: `PaperSummary`'s contract set, the `hive` dedup key, `buildCumulativeAuthorsForChain`, the single-flight `getOrSet`, `statement_timeout`, the canonical-root walker. The item-2 discriminator rationale is documented at the filter site (why `hive` not `name`).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>

---

## Architect re-review (2026-05-26, round-3 → round-4) — HELD PENDING FIXES

`/ce-code-review` on commit `c9eab868` (round-3 hold items 1-4) with correctness/security/adversarial (Opus) + testing/maintainability/project-standards/api-contract/kieran-typescript/reliability/learnings (Sonnet); `ce-agent-native-reviewer` skipped per project CLAUDE.md. Items 1 (enumerated projection), 3 (abort docblocks), 4 (listing-row-map guard unification) landed correctly. The `hive`-discriminator deviation is **confirmed behaviorally correct and safe** (correctness + security + adversarial converged: it never drops a legitimate author; the prescribed `name` discriminator would have, given the construction is hive-keyed). One item is held below. Three findings (the unsound type guard, the multi-link/single-link key-shape divergence, the missing discriminator canary) are **deferred to an author-identity-model design pass**, not this hold — see the deferral note.

### Item held (must fix before archive)

**1. (P2, conf 100 — six-reviewer convergence: correctness, adversarial, api-contract, reliability, testing, maintainability) Profile surface lacks the listing's empty-cumulative fallback, recreating a cross-surface parity break.** Round-3 item 4 unified the **listing** row-map so an empty cumulative array falls back to the head-meta projection (gate `chainResult && chainResult.authors.length > 0 ? chainResult : null`). The profile `/:username/papers` handler still takes over whenever `chainResult` is non-null, with no `authors.length > 0` check. Verified reachable: a multi-link paper (chain ≥ 2) with valid versions whose every author entry lacks a normalizable `hive` returns a **non-null `{authors: []}`** from `buildChainCumulativeFromPosts` (the construction skips `hive === null`; the single-link short-circuit and empty-versions guards do not cover the multi-link-all-hiveless case). Result: listing + detail show head-meta authors, profile serves `authors: []` — the exact cross-surface divergence this task exists to close.

Fix: gate the profile takeover on `chainResult && chainResult.authors.length > 0` to mirror the listing surface (both fall back to head-meta together). Add a deterministic test asserting the profile path falls back to head-meta on a non-null empty-cumulative result. Anchor any comment on stable symbols (no round/slug/line/SHA citations in route or test source).

### Deferred to the author-identity-model design pass (NOT held on this task)

The review surfaced that the cumulative-union is keyed entirely on `hive` (`if (hive === null) continue` at the construction), so multi-link papers structurally drop every Hive-less co-author (`{name, hive: null}`). Per the ratified author model — **`name` mandatory, `hive` optional** (a co-author need not have a Hive account), and `name` server-overridable like `orcid` — that is an authors-can't-be-dropped gap, and the type-soundness finding resolves the opposite way from "make `name` optional": `name` stays mandatory, populated via name-supersession, so the originally-prescribed `name` discriminator becomes both correct and sound and the `hive` deviation becomes unnecessary. These are design changes, addressed in a `/ce-brainstorm` on the author-identity model that precedes the implementation work:

- the cumulative-union identity key for Hive-less co-authors;
- name-supersession (accredited author's attested name overrides the broadcaster claim);
- the `PaperAuthor.name` mandatory contract + the unsound `typeof a.hive === 'string'` guard, the multi-link-vs-single-link key-shape divergence (hive-less entries: JS drops `name`/`orcid` keys, SQL emits `null`), and a discriminator-survival canary — all fold into the resulting design.

This task is held ONLY on item 1 (profile-guard parity), which is orthogonal to the model redesign and safe to land independently.

### Re-review signal
When item 1 lands, `git mv` this file back to `tasks/review/`. Round-4 architect review scopes `/ce-code-review` to the round-4 commit only.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
