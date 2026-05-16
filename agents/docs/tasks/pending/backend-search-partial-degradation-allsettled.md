# BACKEND-SEARCH-PARTIAL-DEGRADATION-ALLSETTLED — surface partial results on type=all search degradation

**Owner:** Backend Agent
**Created:** 2026-05-16 (architect, follow-up to `backend-papers-filter-accreditation.md` round-1 review)
**Priority:** P2

## Problem

`backend/src/routes/search.ts:286-308` (`searchFromHaf`) handles the `?type=all` branch by fanning out to `searchPapersFromHaf` and `searchReviewsFromHaf` via `Promise.all`. Neither inner function has its own catch; both propagate throws. The outer route catch swallows any rejection, returns `null`, and the route emits an empty `200`.

Path-by-path:

- Both branches succeed → merged results returned ✅
- Pool absent (`getPool()` returns null) → each branch returns `null`; outer `?? []` guards yield partial results ✅
- One branch throws (HAF transient error mid-query) → `Promise.all` rejects → outer catch → empty `200` ❌

A reviews-search transient HAF error silently collapses BOTH branches even though the papers-search succeeded. Users can't distinguish "no matching content" from "search partially broken." Operators must read logs to know.

Pre-existing bug (predates `backend-papers-filter-accreditation` lane-3); surfaced during round-1 reliability review (REL-03 P2/75) of that task. Filed as separate task because not in lane-3 accreditation-gate scope.

## Goal

Surface partial results from `?type=all` search when one branch degrades, with a structured log event signaling the partial failure.

## Acceptance

- Replace `Promise.all` at `search.ts:286-308` with `Promise.allSettled`.
- On either branch rejection, return the successful branch's results; populate the failed branch with `[]`; log `event: 'search_partial_degradation'` with `branch` (papers|reviews), error class, and the search query parameters.
- Real-HAF canary (or mocked-pool with carve-out documentation) asserting: when reviews branch throws, response contains papers results + log event fires; symmetric for papers branch throwing.
- Coverage that both-throw still yields empty 200 (no regression vs current behavior).

## Out of scope

- Refactoring `searchPapersFromHaf` / `searchReviewsFromHaf` internals.
- Other `Promise.all` sites in the codebase — separate audit if this pattern recurs.

## Source

- `backend-papers-filter-accreditation` round-1 `/ce-code-review` reliability REL-03 (P2/75). Pre-existing bug; lane-3 just happened to put eyes on the file.
- User triage 2026-05-16 elected separate-task filing because pre-existing scope, not lane-3-introduced.

## Cross-references

- `agents/docs/tasks/pending/backend-papers-filter-accreditation.md` — sibling task; reviewer surfaced this finding while inspecting lane-3 search.ts changes.
- `backend/src/routes/search.ts:286-308` — `searchFromHaf` type=all branch.

## Backend implementation signal (2026-05-16, worktree)

Acceptance items 1-4 + lint/tsc gate landed.

- **Refactor:** `Promise.allSettled` replaces `Promise.all` in `searchFromHaf` `type=all` branch (`backend/src/routes/search.ts:277-336` post-edit). Each rejected branch logs a `logger.warn` with the structured event slug below, then the merge step uses `[]` for the failed branch's rows. Both-throw degrades to empty rows → route renders as `200 OK { data: [], total: 0 }` (regression preserved). The outer `try/catch` is retained as the catch-all safety net for any unexpected throw outside the two helpers.
- **Event slug:** `search.type_all.partial_degradation` (dot-namespaced per the recent convention sweep; consistent with `accreditation.verify.*`, `custody.broadcast.*`, `auth.signup.*`). Payload shape: `{ event, branch: 'papers' | 'reviews', errClass, err, queryParams: { type, discipline, language, source, includeRetracted, sort, limit, offset } }`.
- **Tests:** 4 canaries added in a new file `backend/tests/routes/search-partial-degradation.test.ts`:
  - Reviews-branch-throws → 200, papers-only data, one warn fires with `branch: 'reviews'`.
  - Papers-branch-throws → 200, reviews-only data, one warn fires with `branch: 'papers'`.
  - Both-throw → 200 empty, two warns fire (one per branch). Regression guard against outer-catch collapse re-introduction.
  - QueryParams payload shape canary — pins `type`, `discipline`, `language`, `sort` in the warn event so future filter additions get operator-dashboard visibility.
- **Carve-out:** mocked `getPool()` via `vi.mock` so `pool.query` discriminates by SQL substring (` p ON ` is the reviews-branch JOIN — structural discriminator, not a brittle alias-name match). Real-HAF was impractical: inducing single-branch failure (one query times out, the other succeeds) requires per-statement timeouts plus a controlled rogue-query fixture the live corpus does not provide. Real-path companion is the existing `?type=all` happy-path coverage in `backend/tests/routes/search.test.ts` (different risk class — SQL-shape vs JS-level allSettled discrimination). New test file header documents the carve-out under clauses (a), (b), (c). `verifyHiveSignature` is NOT mocked (`/api/search` is unauthenticated; carve-out's auth-focused exclusion does not apply).
- `npm run lint` clean (pre-existing seed-phrase.ts warnings only); `npx tsc --noEmit` clean. Vitest not run in worktree (parent serializes after all worktrees merge).
