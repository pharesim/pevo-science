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
