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

## Architect re-review (2026-05-16) — HELD PENDING FIXES:

`/ce-code-review` ran on commit `eff1bcc` with 6 personas (correctness Opus; testing/maintainability/project-standards/julik-frontend-races/learnings-researcher Sonnet; `ce-agent-native-reviewer` skipped per PEvO CLAUDE.md). All 5 acceptance criteria verified; 6 new race-guard tests cleanly exercise the cancel-on-new invariant. 2 P2 items block archive — one shared-helper regression caused by becoming the first caller to pass a signal, plus one maintainability cleanup.

### Items to address

**1. (P2) `api.js request()` spread overrides the 30s `AbortSignal.timeout` fallback once a caller passes a signal.** `frontend/src/api.js:47-48`. The helper sets `signal: init?.signal ?? AbortSignal.timeout(DEFAULT_TIMEOUT_MS)` on line 47, then `...init` on line 48 immediately overwrites with the caller's `{signal: controller.signal}`. The `??` fallback is computed but never used when `init.signal` is present. Before this commit no caller passed `signal`, so the 30s server-hang timeout was always live on every request. After this commit, search.js is the FIRST caller passing a signal — search requests now have NO server-hang timeout; the only thing that can cancel them is a new doSearch starting or destroy() running. A user who searches and walks away with backend stalled holds the fetch open indefinitely. (julik-frontend-races, conf 90)

   This is a wider regression vector for any future caller adopting the `{signal}` pattern (e.g., the researchers.js sibling-page fix this task's "Out of scope" carved out). Each future adopter silently loses the 30s budget.

   Fix: compose the signals via `AbortSignal.any()`:
   ```js
   signal: init?.signal
     ? AbortSignal.any([init.signal, AbortSignal.timeout(DEFAULT_TIMEOUT_MS)])
     : AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
   ```
   `AbortSignal.any()` is a standard browser primitive; no dependency. 3 lines.

**2. (P2) Three-clause OR in catch has an unreachable third clause.** `frontend/src/pages/search.js:289-300`. The supersession guard reads:
   ```js
   if (
     controller.signal.aborted ||
     this._searchController !== controller ||
     (err && (err.name === 'AbortError' || err.code === 'ABORT_ERR'))
   ) { return; }
   ```
   Any path that aborts the controller goes through `this._searchController.abort()` at a superseding doSearch's entry point, which synchronously sets `controller.signal.aborted = true` AND reassigns `this._searchController`. By the time `!== controller` is true, `signal.aborted` is also true. The only scenario where AbortError arrives but neither of the first two is true would require the signal to be aborted without going through `_searchController` — which this code never does. A future reader sees the third clause and wonders if it defends a real edge case they're missing. (maintainability, conf 72)

   Fix: pick one of:
   - (a) **Remove the third clause** — verifiably correct under the current control flow; 3-line delete.
   - (b) **Extract to a named predicate** — `if (this._isSupersededOrAborted(controller, err)) return;` plus a helper method that retains all three clauses as belt-and-suspenders against hypothetical future browser/polyfill behavior. Implementer's call; (a) is the smaller change.

### Items dismissed during architect triage

- **3-deep stacked request not tested (julik-frontend-races, residual/65).** Mechanically safe by induction on the identity check; testing all combinatorial depths is preemptive.
- **err.code === 'ABORT_ERR' path has no dedicated test (testing, low).** Defensive belt-and-suspenders; redundant with item 2 cleanup.
- **Test 5 (`goToPage` race) uses `await Promise.resolve()` flushes (testing, residual/low).** Stable under current doSearch shape; preemptive hardening.
- **No real-fetch E2E verifying AbortSignal propagates through request() to fetch (correctness, gap).** Already covered by static read; E2E would not strengthen the invariant.
- **researchers.js follow-up** — dismissed per architect triage; pre-existing latent race, low churn surface, no concrete user reports. Re-evaluate if a future incident surfaces.

### Architect signal

After landing items 1 and 2, `git mv` this file back to `tasks/review/`. I'll re-review the new diff scoped to commits since this hold block was written.

Anchor: item 1 (api.js) and item 2 (search.js) touch different files; one or two commits.
