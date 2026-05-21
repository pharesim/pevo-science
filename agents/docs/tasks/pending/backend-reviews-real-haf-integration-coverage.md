# BACKEND-REVIEWS-REAL-HAF-INTEGRATION-COVERAGE — add real-HAF companion suite for `/api/reviews/:author/:permlink`

**Owner:** Backend Agent
**Created:** 2026-05-21 (filed as part of `backend-pevo-string-helper-adoption-sweep.md` round-3 hold item 2: clause-(c) follow-up for the mocked-pool reviews.test.ts file)
**Priority:** P3

## Problem

`backend/tests/routes/reviews.test.ts` is mocked-pool end-to-end: the file's top-level `vi.mock('../../src/db.js')` applies to every describe block, including the one previously labeled `(real HAF)`. The carve-out justification in the file header now correctly acknowledges that no real-HAF integration coverage exists for the `/api/reviews/:author/:permlink` route, and cites this task as the clause-(c) follow-up.

The risk class the mocked specs guard (the `buildReviewDetail` projection shape, the SQL accreditation gate, the SQL parent-paper parity gate, and the `pevoString` collapse semantics on `reviewer_attestation_id`) is partially exercised against real HAF by sibling SQL gates (e.g. `review-parity-invariant.test.ts`, `reputation-lifecycle.test.ts` — same shape patterns at different routes). But the single-doc `/api/reviews/:author/:permlink` endpoint itself has zero real-HAF coverage today.

## Goal

Add a real-HAF integration companion suite (in `backend/tests/routes/` or a new `reviews-real-haf.test.ts`) that exercises the GET-review route family against the live HAF pool:

1. **404 path against an unseeded permlink.** Hit `/api/reviews/<random>/<random>` and assert 404 + `NOT_FOUND`. No DB seed required.
2. **200 path against a live reviewer-authored record.** Walk the live HAF for a known accredited-reviewer record (or use a fixture account if available) and assert the response envelope shape: `author`, `permlink`, `body`, `rating`, `reviewer_attestation_id`, `paper.author`, `paper.permlink`, `paper.title`, `is_accredited`. Tolerant assertions only (shape, not values) so the spec stays green across drifting live data.
3. **404 for an unaccredited-author review** if a deterministic unaccredited-Hive-account-with-review-shaped-comment can be located on chain; otherwise note this branch remains in mocked-pool coverage only.

The real-HAF companion does NOT need to re-prove the helper-narrowing semantics that the mocked specs pin; it only needs to integrate the route against the real pool so a different mutation class (SQL composition errors, pool config errors, real CTE-binding bugs) is caught at the route layer.

## Acceptance

1. New test file(s) exist under `backend/tests/routes/` that exercise `/api/reviews/:author/:permlink` against the real HAF pool.
2. The 404 path is pinned end-to-end against real HAF.
3. At least one 200-path spec is pinned against a live record (with tolerant shape assertions).
4. The file uses the standard real-HAF setup (no `vi.mock('../../src/db.js')`, real pool config, the project-wide `getPool()` helper).
5. `npx tsc --noEmit` clean. Targeted vitest stays green.
6. Update the `backend/tests/routes/reviews.test.ts` file-header carve-out clause (c) to cite this new file (or remove the follow-up reference once landed).

## Coordination

This task is independent of the keystone helper-adoption sweep. It can land any time. The mocked-pool specs in `reviews.test.ts` remain valid coverage for the per-test deterministic shapes; this task adds the complementary real-path mutation-kill at the route layer.

## Cross-references

- `agents/docs/solutions/conventions/test-mock-carve-out-clause-c-2026-05-04.md` — the clause-(c) "follow-up filing IS the carve-out satisfier" convention this task implements.
- `backend/tests/routes/reviews.test.ts` — the mocked-pool sibling whose carve-out cites this task.
