# Accreditation filter invariant — papers/comments tests + reviews hard-gate enforcement

**Owner:** Backend Agent
**Created:** 2026-04-28
**Updated:** 2026-04-28 (architect resolution — see "Architect resolution" block below; scope expanded from tests-only to small code change + ARCHITECTURE.md edit + tests for the reviews surface)

## Problem

PEvO's trust layer is the accreditation filter: posts, comments, and reviews authored by non-accredited Hive accounts are excluded from listings by default (`accredited_only=true`, `backend/src/routes/papers.ts:210, 260-263`; mirrored in comments and reviews routes). This is the platform's filter-vs-gate invariant — anyone can post on Hive, PEvO decides what to surface.

Existing tests already exercise the `accredited_only=false` opt-out path (`backend/tests/routes/papers.test.ts:28`, `comments.test.ts:21,47`) but no test asserts that the **default-on filter actually excludes** an unaccredited author's `APP_TAG` content. A regression that quietly drops the filter would not be caught today.

## Acceptance criteria

Add real-HAF integration tests (no `getPool()` mocking — see root `CLAUDE.md` "Running Tests") covering each of the three list surfaces:

1. **`papers.test.ts`** — seed or pick an existing `APP_TAG` post authored by a Hive account that is NOT in `active_accreditations`. Assert:
   - `GET /api/papers` (default) does NOT include that post.
   - `GET /api/papers?accredited_only=false` DOES include it.
   - Bridge-paper carve-out (`papers.ts:263`) — a `bridge_paper` typed post from an unaccredited author IS included even with default filter. If no fixture exists, document the gap.

2. **`comments.test.ts`** — for a paper that has comments from both accredited and unaccredited authors, assert `GET /api/papers/:author/:permlink/comments` (default) excludes the unaccredited-author comments, opt-out includes them.

3. **Reviews hard gate** (code change + tests) — see "Architect resolution" block below for the full design rationale. Two surfaces, both always-on with no opt-out:

   3a. **Single-doc fetch** (`backend/src/routes/reviews.ts:91`, `GET /api/reviews/:author/:permlink`) — extend `fetchReviewFromHaf`'s WHERE clause to admit only `active_accreditations.account` ∪ `config.hiveAnonAccount`. The existing `accredCte` is already in scope; add `AND (c.author IN (SELECT account FROM active_accreditations) OR c.author = $N)` and append `config.hiveAnonAccount || ''` to the params list. SQL filter (not enrichment-layer filter) because:
     - Defense-in-depth: the gate sits at the data layer; future refactors of `enrichReviewDetail` cannot leak unaccredited reviews.
     - Consistency with paper-detail's `reviews: []` array filter (`papers.ts:1133` uses `c.author = ANY($6::text[])`).
     - 404-path performance: SQL filter saves the parent-title roundtrip and the reputation lookup on rejected requests.
     - Happy-path performance: identical to enrichment filter (HAF roundtrip dominates either way).
   3b. **Paper-detail reviews array** (`backend/src/routes/papers.ts:1133`, `GET /api/papers/:author/:permlink`) — already always-on filtered. No code change needed; only verify with a test that it stays that way.

   Test assertions:
   - `reviews.test.ts` — `GET /api/reviews/:author/:permlink` for an unaccredited author returns 404. Same endpoint for an accredited author returns 200 with the review body. Same endpoint for a `hiveAnonAccount` review returns 200 with `is_accredited: false` (anon-proxy distinguished from direct-accredited).
   - `papers.test.ts` (or a new section in `reviews.test.ts` exercising the paper-detail endpoint) — for a paper that has reviews from both accredited and unaccredited authors, assert `GET /api/papers/:author/:permlink`'s `reviews: []` array contains only the accredited (and `hiveAnonAccount`) reviewers.
   - There is no `accredited_only=false` opt-out path to test for either reviews surface — accreditation is a hard gate. Do not introduce one.

Use real HAF (`pevo_app_test` routing under `./deploy.sh test-up`). If no suitable fixture exists in the test database for one of the surfaces, file a follow-up rather than mocking.

**Implementation order suggestion** (each can be its own commit):
1. Land #1 (papers tests) and #2 (comments tests) first — pure additive tests, low risk.
2. Land #3a (reviews single-doc SQL gate) + the #3 tests as a single commit. The architect has already updated `ARCHITECTURE.md:90` to reflect the hard-gate stance, so no doc edit is needed from this lane unless an `api-contracts/*.md` file documents the single-doc reviews endpoint (check before committing — if it does, update it to drop any opt-out wording and note the 404 path).

## Why now

The display-filter invariant has no canary. We brainstormed E2E coverage and concluded this belongs at the backend integration tier, not Playwright — the assertion is query-shape, not user-journey. See session 2026-04-28.

## Out of scope

- UI-side affordance / banner behavior on `publish.js`/`review.js`/`edit.js` (separate UI task).
- Researchers directory (`/api/accreditations`) is implicitly accredited-only because its source table is `active_accreditations`; no separate test needed unless the implementation drifts.

---

## Architect resolution (2026-04-28)

Backend's block flagged a real ambiguity in the original #3 — the literal endpoint cited (`GET /api/reviews/:author/:permlink`) is a single-doc fetch with no opt-out, and the actual reviews-listing filter is hardcoded inside paper-detail with no opt-out either. Reviewing the architecture and use cases, **there is no documented use for surfacing unaccredited reviews anywhere in PEvO**: they don't count toward ratings (filtered in the rating computation), they don't appear in the canonical paper-detail `reviews: []` array, and no listing surface ever hands the UI an unaccredited reviewer's `(author, permlink)` to look up. The single-doc endpoint returning them with `is_accredited: false` was incidental code, not a designed affordance.

**Resolution: option (d) — harden the always-on filter across all reviews surfaces. No asymmetry, no opt-out, hard gate.**

Concretely:
1. **Code change (single-doc):** `fetchReviewFromHaf` in `backend/src/routes/reviews.ts:43-76` adds an accredited-or-anon WHERE-clause gate. Implementation guidance is captured inline in acceptance criterion 3a above (SQL filter, not enrichment-layer filter — see rationale there).
2. **No code change (paper-detail):** `papers.ts:1133` already filters; only verify with tests.
3. **Doc edit (landed by architect in this same commit):** `agents/docs/ARCHITECTURE.md:90` rewritten to make the hard-gate stance explicit and distinguish reviews from papers/comments which retain their opt-out. Backend should not re-edit this line.
4. **`is_accredited` field semantics:** unchanged. After the gate, the field is `true` for direct-accredited reviewers and `false` for `hiveAnonAccount` reviews — that's still informative for the UI (anon vs. direct badge) and worth keeping. Do not remove it.

Why not (a) "always-on filter on paper-detail only, leave single-doc returning everything":
- Inconsistent: two reviews surfaces with different gates is exactly the kind of incidental asymmetry that motivated this task as a canary in the first place.
- Defense-in-depth gap: a future code path (e.g., a new "show review by URL" feature) would inherit the leak.

Why not (b) "add opt-out to paper-detail reviews array for symmetry with papers/comments":
- No documented use case for unaccredited reviews. Adding the opt-out manufactures a surface that has no consumer.
- Expands API surface and `api-contracts/*.md` without motivation.

Why not (c) "single-doc behavior change but a different shape (e.g., return with badge, no 404)":
- A 200 with `is_accredited: false` for an unaccredited reviewer would still leak an entry that no listing surface produces. The 404 closes the leak completely.

This task moves back to `tasks/pending/`. Backend, please implement #1 and #2 first as additive tests, then #3a (SQL gate) + tests as a separate commit. The ARCHITECTURE.md edit is already landed.
