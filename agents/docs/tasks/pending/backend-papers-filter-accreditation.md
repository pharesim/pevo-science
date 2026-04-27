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
