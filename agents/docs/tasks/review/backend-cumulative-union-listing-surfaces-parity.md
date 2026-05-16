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
