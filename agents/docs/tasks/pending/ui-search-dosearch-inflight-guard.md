# UI-SEARCH-DOSEARCH-INFLIGHT-GUARD — Guard `doSearch` against stacked in-flight requests from `goToPage` and `popstate`

**Owner:** ui
**Created:** 2026-05-11 (architect, batch-1 review triage)
**Priority:** P2

## Context

Architect batch-1 review finding JFR-001 (julik-frontend-races, conf 75) constructed a concrete race on the search page:

`frontend/src/pages/search.js` has a `doSearch` method that performs an async HAF query (typically 2-5s on busy nodes). The submit button is disabled via `:disabled="loading"`, which prevents handleSubmit-driven double-submits. But two other call paths bypass this guard:

1. **`goToPage` (line ~282):** clicking pagination calls `doSearch` directly. The pagination component is visible during loading; nothing prevents clicking page 2 while page 1 is still in flight.
2. **`popstate` handler (line ~200):** browser back/forward calls `_syncFromUrl` → `doSearch`. No `loading` check.

**Concrete sequence:**
1. User submits search → `doSearch` starts, `loading=true`, HAF query in flight.
2. User clicks page 2 in pagination footer. `goToPage` calls `doSearch` again. Second fetch starts; `loading` is still true throughout.
3. Whichever response arrives LAST wins. Page-1 response may arrive after page-2 response and overwrite the page-2 results.
4. UI shows page-1 data while URL says `?page=2` and pagination footer claims page 2.

Same race via popstate: user clicks back during a slow query → second fetch stacks → last-arriving wins.

## Acceptance

1. **Pick a guard mechanism (one of two; either is ~8 lines):**
   - **AbortController** (preferred — also cancels the underlying request): maintain `this._searchController` on the component. At the top of `doSearch`, abort the prior controller and create a new one. Pass `signal` to the fetch helper. Aborted requests reject cleanly; downstream code should ignore the abort error.
   - **Epoch token** (fallback if fetch helper doesn't support signal): `this._searchEpoch = (this._searchEpoch || 0) + 1; const myEpoch = this._searchEpoch;` after `await fetch`, check `if (myEpoch !== this._searchEpoch) return;` (silently discard stale response).
2. **Apply the guard at the entry point of `doSearch`.** Both `goToPage` and the `popstate` handler invoke `doSearch`; the guard at `doSearch`'s top handles both call paths uniformly.
3. **Don't disable the pagination buttons during loading** — that would be a different UX choice (slower-feeling on fast queries). The race fix is cancel-on-new, not block-during-old.
4. **Verify handleSubmit still benefits from `:disabled="loading"`** — the existing button-disable should remain as the FIRST-line defense against rapid form-submit double-clicks. The guard inside `doSearch` is the SECOND-line defense against the call paths that bypass the button.
5. **Test the cancel-on-new behavior in a unit spec** (see Tests below).

## Tests

Add specs to `frontend/tests/unit/pages-search.test.js` (create the file if it doesn't exist):

- **Concurrent doSearch race:** mock `searchPapers` (or whatever the fetch helper is) to return on-demand promises. Resolve them out of order (page-1 promise after page-2 promise). Assert that `this.results` ends up as the page-2 data, NOT page-1 data.
- **AbortController fires on new request:** if using AbortController, verify the prior signal's `aborted` flag becomes true when a new doSearch starts.
- **Epoch token discards stale response:** if using epoch, verify the early-return path is hit when myEpoch !== this._searchEpoch (mock the underlying fetch to record what gets assigned to results vs early-returned).
- **Existing submit-button-disabled behavior preserved:** assert that during `loading=true`, the submit button has `disabled` attribute / `pointer-events: none` per the existing styling.

## Out of scope

- The pagination component itself (its rendering logic). The fix is in the page component, not in the pagination helper.
- E2E spec changes. `frontend/tests/e2e/search.spec.js` recently had 9 hold items addressed in commit `ee8be6d`; that work is separate from this race-guard fix. If the e2e spec triggers the race in CI (unlikely with deterministic mocks), file a follow-up.
- Other pages with similar patterns. If grepping reveals `doSearch`-like patterns elsewhere (e.g., a similar in-flight stacking risk in `frontend/src/pages/papers.js` or `frontend/src/pages/notifications.js`), file a separate task per page rather than bundling here.

## References

- Architect batch-1 review finding JFR-001 (julik-frontend-races). Conf 75.
- Cited line range: `frontend/src/pages/search.js:240-287` (doSearch body, goToPage at 282, popstate handler at 200).

## Priority rationale

P2 because the user-visible failure mode is concrete (wrong-page data shown with URL/footer claiming a different page), the trigger is plausible (slow HAF + impatient user), and the fix is ~8 lines. Not P1 because the rate at which users actually hit this on PEvO's current scale is bounded.
