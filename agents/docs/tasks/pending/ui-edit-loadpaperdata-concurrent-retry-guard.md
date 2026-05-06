# UI-EDIT-LOADPAPERDATA-CONCURRENT-RETRY-GUARD — guard against concurrent loadPaperData() invocations

**Owner:** UI Agent
**Created:** 2026-05-06 (architect, surfaced during round-3 review of `ui-coauthor-continuation-publishing` commit `26c3b6b`)
**Priority:** P2

## Problem

`frontend/src/pages/edit.js:589-635` `loadPaperData()` is re-entrant with no in-flight guard. The Retry button at line 50 (`@click="loadPaperData()"`) can fire concurrent requests on a slow network if the user double-clicks. Two concurrent in-flight fetches race; the slower-resolving fetch wins and overwrites:

- `_originalBody` (the diff base for native edits)
- `this.paper`
- `existingSupplementaryFiles`

The existing stale-key guard at lines 602/629 only protects against route changes (different paper), not concurrent retries on the same paper.

The downstream effect is a subtle data corruption: the user's `_originalBody` ends up reflecting the slow fetch, not the latest one, so the next native edit may diff against stale content. Mechanically reproducible by clicking Retry twice quickly during a slow load.

This was outside the round-2 hold scope for `ui-coauthor-continuation-publishing` (which closed the lifecycle-binding duplication race). It is a request-level concurrency concern adjacent to that fix.

## Acceptance

### 1. In-flight guard

Add a `_loadInFlight` boolean flag (or equivalent — `AbortController` is also acceptable; ~6 lines either way, no library needed). When `loadPaperData()` is called and `_loadInFlight === true`, early-return without firing a second fetch. Clear the flag in the `finally` block of the existing flow. Verify the flag is reset on both success and error paths so a failed-then-retry sequence still works.

If using `AbortController`: cancel the prior in-flight fetch before starting a new one. Verify cancellation does NOT incorrectly clear `_originalBody` / `this.paper` mid-state.

### 2. Test

Add a unit test in `frontend/tests/unit/pages-edit.test.js` that:

- Drives `loadPaperData()` twice in rapid succession with a delayed mock response.
- Asserts only ONE `getPaper`-equivalent fetch fires (or, in the `AbortController` shape, asserts the first is aborted and only the second resolves cleanly).
- Asserts `_originalBody` and `this.paper` reflect a single consistent fetch result, not a mid-state interleave.
- Mutation-kill: removing the guard causes the test to fail (e.g., assertion of fetch count goes from 1 to 2; or the post-state shows mid-flight corruption).

### 3. No production-code seam beyond the guard

Don't introduce request-deduplication libraries or restructure the fetch flow. The fix is a one-flag early-return.

## Out of scope

- The latent storage-listener teardown gap on SPA navigation (separate concern flagged in round-3 review by `ce-learnings-researcher`; can be a follow-up if the architect wants to track it).
- Editor remount races on rapid Retry. No UI path reaches `_mountEditors` while a Retry is in-flight today.

## Source

Round-3 review of `ui-coauthor-continuation-publishing` commit `26c3b6b`. Surfaced by `ce-julik-frontend-races-reviewer` (finding JFR-R3-001) as a follow-up race that round-2's lifecycle refactor did not address.

## Cross-references

- `frontend/src/pages/edit.js:589-635` — `loadPaperData()` body
- `frontend/src/pages/edit.js:50` — Retry button binding
- `frontend/src/pages/edit.js:602, 629` — existing stale-key guard (route changes only)
- `agents/docs/tasks/pending/ui-coauthor-continuation-publishing.md` — round-2 task file from which this was surfaced (round-3 hold)
