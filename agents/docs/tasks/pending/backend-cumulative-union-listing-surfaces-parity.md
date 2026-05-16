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
