# E2E spec — search page

**Owner:** UI Agent
**Created:** 2026-04-28

## Problem

`frontend/src/pages/search.js` is core discovery functionality with zero E2E coverage. Search drives one of the platform's primary user journeys (find papers by keyword, discipline, author) and currently no test verifies that the results page renders, paginates, or filters correctly when wired to the real backend.

## Acceptance criteria

Add `frontend/tests/e2e/search.spec.js` covering at minimum:

1. **Keyword query renders results** — navigate to `/search?q=<known-fixture-keyword>`, assert at least one result card renders with title, author, and discipline. Assert the URL retains the query parameter on direct load.

2. **Empty-result state** — `/search?q=<known-no-match-string>` renders the empty state, not a broken layout.

3. **Filter combination** — `/search?q=<keyword>&discipline=<known-discipline>` narrows results vs. `/search?q=<keyword>` alone; assert the result count differs and disciplines on rendered cards match the filter.

4. **URL pagination** — `/search?q=<keyword>&page=2` (or whatever the search page's pagination param is) loads page 2 directly. Mirror the assertion shape from `url-pagination.spec.js`.

5. **Result navigation** — clicking a result card navigates to `/paper/<author>/<permlink>` and the paper-detail page loads. Single click-and-render assertion is enough.

Use the standard E2E topology (`./deploy.sh test-up`, `pevo_app_test`). Inspect existing `papers-browse.spec.js` and `url-pagination.spec.js` for fixture conventions and assertion patterns.

## Out of scope

- Backend search ranking / relevance behavior — owned by `backend/src/routes/search.ts` and its existing tests.
- Search-as-you-type / typeahead suggestions if those exist (file separately if so).
- The accreditation filter on search results is a backend invariant (see `backend-papers-filter-accreditation.md`); do not duplicate it here.
