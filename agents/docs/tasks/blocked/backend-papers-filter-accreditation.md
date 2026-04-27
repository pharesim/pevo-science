# Accreditation filter invariant — extend papers/comments/reviews tests

**Owner:** Backend Agent
**Created:** 2026-04-28

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

3. **`reviews.test.ts`** — same shape for `GET /api/reviews/:author/:permlink`. Reviews from non-accredited authors must be excluded from the default response.

Use real HAF (`pevo_app_test` routing under `./deploy.sh test-up`). If no suitable fixture exists in the test database for one of the three surfaces, file a follow-up rather than mocking.

## Why now

The display-filter invariant has no canary. We brainstormed E2E coverage and concluded this belongs at the backend integration tier, not Playwright — the assertion is query-shape, not user-journey. See session 2026-04-28.

## Out of scope

- UI-side affordance / banner behavior on `publish.js`/`review.js`/`edit.js` (separate UI task).
- Researchers directory (`/api/accreditations`) is implicitly accredited-only because its source table is `active_accreditations`; no separate test needed unless the implementation drifts.

---

## [BLOCKED by Architect] (2026-04-28) — reviews acceptance criterion #3 mismatch

The task's reviews surface (#3) cites `GET /api/reviews/:author/:permlink` and asks the test to assert that "the default response excludes reviews from non-accredited authors" with the same opt-out shape as papers/comments. Re-reading the route code, that shape does not exist:

- `/api/reviews/:author/:permlink` (`backend/src/routes/reviews.ts:91`) is a **single-review fetch** by author/permlink. It returns the review unconditionally and labels it via `is_accredited: true|false` (`reviews.ts:39, 86`). There is no `accredited_only` query param and no listing semantics. Asserting "default excludes" against a single-document fetch is not well-defined.
- The actual review-listing filter lives in **paper detail** (`GET /api/papers/:author/:permlink`) inside `fetchEnrichmentFromHaf`, where `c.author = ANY($6::text[])` is hardcoded to `accreditedArr + hiveAnonAccount` (`backend/src/routes/papers.ts:1133, 1108-1110`). That filter is **always on** — there is no `accredited_only=false` opt-out for the embedded `reviews: []` array, unlike papers/comments.

Two architect-scope questions:

1. **Did you mean the paper-detail `reviews` array?** If yes, the test belongs in `papers.test.ts` (or `reviews.test.ts` exercising the paper-detail endpoint) and the assertion is one-sided — always excludes, no opt-out path to test. The acceptance criterion text should be amended to reflect "default-and-only-on, no opt-out parity with papers/comments."
2. **Or do you want a new `?accredited_only=false` opt-out** added to the paper-detail reviews array for symmetry with papers/comments? That is an API contract change — `agents/docs/api-contracts/papers.md` or `reviews.md` would need updating, plus a backend code change. It is out of scope for a tests-only task.

Backend cannot proceed without a decision. Papers (#1) and comments (#2) acceptance criteria are unambiguous and ready to implement, but committing partial coverage on a "filter invariant" task without resolving the reviews surface would archive a half-invariant.

Please pick one of:
- (a) Rewrite #3 to target the paper-detail `reviews` array with an always-on assertion and explicitly drop the opt-out clause.
- (b) Split off the new `accredited_only=false` opt-out for reviews into a separate backend task with a contract update lane, and rewrite #3 here as the always-on assertion against the current behavior.
- (c) Confirm the literal `/api/reviews/:author/:permlink` text is intentional and describe what the assertion should be on a single-document fetch (e.g., 404 when the author is unaccredited?). This would also be a behavior change, not a test-only task.
