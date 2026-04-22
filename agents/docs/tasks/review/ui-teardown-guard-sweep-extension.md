# UI-TEARDOWN-GUARD-SWEEP-EXTENSION — Extend `_mounted` teardown guards to the sites `UI-ASYNC-CONTINUATION-TEARDOWN-GUARD-SWEEP` left uncovered

**Owner:** ui
**Created:** 2026-04-22 (surfaced by REV #5 / #6 / #8 during architect review)
**Priority:** P2

## Context

`UI-ASYNC-CONTINUATION-TEARDOWN-GUARD-SWEEP` propagated `createTimerGuard()` + `_mounted` guards across 10 named files. The architect's review of that sweep found 5 missed guards **inside the sweep's own scope** (held on that task's round-2). Reviews of neighboring tasks surfaced **additional sites outside the sweep's named scope** with the same write-after-destroy failure mode.

This task folds all those additional sites into one extension sweep.

## Sites in scope

From Review #5 (`ui-err-message-sanitize-sweep-rest-of-frontend` round-2, julik JFR-5-001/002/003/004):

- `frontend/src/pages/signup.js` — catch block with deep async DUPLICATE branch (`await this._resolveExistingAccount()` nested `loginWithPassword`). (F5.1, 0.82)
- `frontend/src/pages/login.js` — catch blocks after async login post. (0.65)
- `frontend/src/pages/reset-password.js` — catch blocks after reset-request / reset POST. (0.60)
- `frontend/src/components/sign-in-modal.js` — catch blocks after modal auth. (0.58)
- `frontend/src/pages/signup-verify.js` — catch blocks after verification POST.

From Review #6 (`ui-err-message-sanitize-toast-and-handleconnect-sites`):

- `frontend/src/components/vote-buttons.js` `handleVote` — multi-second Hive broadcast with post-await writes (`voteState`, `displayVotes`, `currentWeight`, `isVoting`, `selectorOpen`), no guard. (F6.1, julik JFR-6-001 0.82)
- `frontend/src/pages/contact.js` `handleSubmit` — post-await `this.step` + `this.errorMessage` writes. (F6.7, julik JFR-6-002 0.68)

From Review #8 (`ui-paper-feed-search-discipline-composable`):

- `frontend/src/components/paper-feed.js` `loadPapers` — missing `finally` pattern + no concurrent-fetch generation counter. search.js's `doSearch` is the reference shape with `finally { if (this._mounted) this.loading = false; }`. (F8.1, julik JFR-1 0.82)

## Goal

Apply the standard `createTimerGuard()` + `destroy()` + `_mounted` guard pattern to all sites above, matching the convention documented in `frontend/src/lib/timer-guard.js`.

For `loadPapers` specifically: also apply the `finally` + generation-counter pattern from search.js's `doSearch` so concurrent fetches don't overwrite each other.

## Non-goals

- Migrating every `.catch()` in the frontend. Scope is the above named sites.
- AbortController-based in-flight fetch cancellation.
- Alpine lifecycle refactor beyond the guard additions.

## Acceptance

- All sites use `createTimerGuard()` spread + `_mounted` guards on post-await continuations.
- `paper-feed.js loadPapers` has `finally` + a generation counter (or equivalent mutex) matching the `doSearch` pattern.
- One test per file asserting no-write-after-destroy.
- Full frontend unit suite passes; `npm run build` clean.

## Coordination

- Sibling task `ui-async-continuation-teardown-guard-sweep.md` (in round-N hold) closes 5 in-scope missed guards. Land both; the convention documentation and helper already cover both.

## [TODO Architect]

None. Pattern-propagation pass using the existing helper.
