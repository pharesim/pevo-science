# BACKEND-LISTING-PROFILE-ERROR-ISOLATION-ROUTE-TEST — route-level 200-status test for per-row chain-enrichment failure isolation

**Owner:** Backend Agent
**Created:** 2026-05-25 (architect, follow-up from `/ce-code-review` of `backend-cumulative-union-listing-surfaces-parity` round-2)
**Priority:** P2

## Problem

The cumulative-union enrichment loops in `fetchPapersFromHaf` (listing, `GET /api/papers`) and the profile `GET /:username/papers` handler wrap each per-row `resolveChainCumulativeAuthors` call in a `try/catch` so one row's chain-walk failure falls back to that row's head-meta projection rather than failing the whole page. The round-2 hold item 8 asked for a test asserting "the listing response status is 200 not 5xx" when one row's helper throws.

The landed test (`backend/tests/routes/papers-cumulative-cross-surface-parity-mocked.test.ts`) instead **re-implements the route's `Promise.all` + per-row `try/catch` loop inline in the test body** and asserts at the helper boundary. It pins the isolation primitive, but it does not invoke the real `fetchPapersFromHaf` / profile route handler. A refactor that moved the route's `try/catch` out of the per-row map (so one row's throw rejects the whole `Promise.all` → 5xx) would not be caught — the test's own inline catch absorbs the throw.

The backend re-review signal acknowledged this scope reduction and stated a route-level follow-up was "worth filing separately." This task is that follow-up (it was not filed at the time).

## Goal

Add a route-level test that drives the real `GET /api/papers` (and, if cheap, `GET /api/profile/:username/papers`) handler with a multi-row fixture in which one row's chain-enrichment throws, and asserts:

1. Response status is 200 (not 5xx).
2. The erroring row is present in the response with its head-meta `authors` / `accredited_authors` (no cumulative-union override).
3. The sibling rows return their cumulative-union enriched authors.

## Acceptance

- A test exercises the real listing route handler (not an inline re-implementation of its loop) with one row's `resolveChainCumulativeAuthors` forced to throw, asserting 200 + correct per-row fallback + sibling enrichment.
- The carve-out header documents which infrastructure is mocked and why (the listing SQL surface — count CTE, data query, reputation/accreditation/vote/ORCID batches — is impractical to run per-test for this deterministic failure-injection); the auth middleware policy follows the project carve-out clauses.
- Self-audit on added lines: no task-slug citations, round-N markers, line-number anchors, SHA refs, date anchors, or relative positional anchors.

## Out of scope

- Changing the route's error-handling shape — the per-row `try/catch` isolation is correct; this task only adds the missing route-level assertion.
- The helper-boundary isolation test already in `papers-cumulative-cross-surface-parity-mocked.test.ts` stays (it pins the primitive); this task adds the integrated-route assertion on top.

## Coordination

Can land independently of the `backend-cumulative-union-listing-surfaces-parity` round-3 hold, but if that hold's item-1 enumerated-keys canary lands first, this test can reuse the same multi-row fixture shape.

## Source

- `/ce-code-review` testing (confidence 90) + correctness testing-gap during round-2 review of `backend-cumulative-union-listing-surfaces-parity` (2026-05-25). Backend re-review signal explicitly deferred the route-level 200-status assertion to a separate follow-up.

## Backend completion signal (2026-05-26)

Verified both isolation structures exist in production before writing the test:
- Listing `fetchPapersFromHaf` (`backend/src/routes/papers.ts`) wraps each per-row `resolveChainCumulativeAuthors` call in a `try/catch` inside the `Promise.all(rows.map(...))` callback, so one row's throw is absorbed (logged as "chain cumulative authors enrichment failed") rather than rejecting the page.
- Profile `GET /:username/papers` (`backend/src/routes/profile.ts`) has the identical per-row `try/catch` inside its `Promise.all(rows.map(...))` enrichment loop ("profile chain cumulative authors enrichment failed").

Added `backend/tests/routes/papers-cumulative-route-error-isolation-mocked.test.ts` (2 tests, both passing). Drives the REAL `GET /api/papers` and `GET /api/profile/:username/papers` handlers via supertest with a 2-row fixture. Failure injection is at the helper's outermost wrapper: `hafCache.getOrSet` is spied to reject for the erroring row's `chain-authors:<author>:<permlink>` key and delegate every other key (including the profile response cache and the sibling's pre-seeded warm entry) to the real implementation. This forces the real `resolveChainCumulativeAuthors` to throw through the route's per-row map; a real chain walk swallows its own SQL failures and returns null, so it can't reproduce the throw the isolation guard defends against.

Assertions per route: (1) response status 200, not 5xx; (2) the erroring row is present with its head-meta `authors` (the SQL `authors_with_supersession` fallback for listing / `toPaperSummary` authors for profile) and empty head-derived `accredited_authors` — no cumulative-union override and no inheritance of the sibling's cumulative `accredited_authors`; (3) the sibling row carries cumulative-union enrichment (a dropped chain co-author plus the cumulative `accredited_authors` set). The helper-boundary canary in `papers-cumulative-cross-surface-parity-mocked.test.ts` stays — it pins the per-row `try/catch` primitive; this file adds the integrated-route assertion that catches a refactor relocating the catch out of the per-row map.

Mocked infra (carve-out documented in the test header): `getPool()` returns a deterministic multi-row dataset; `hafCache.getOrSet` is the failure-injection point. No auth middleware is mocked or bypassed — both routes are unauthenticated reads behind `readLimiter` only. `npm run typecheck` (src + tests) and `npm run lint` (src) pass; the one lint warning is pre-existing in `src/lib/author-supersession.ts`, untouched by this task.
