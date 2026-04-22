# UI-SETTIMEOUT-NAVIGATE-TEARDOWN-GUARD-SWEEP — Apply post-teardown guard pattern to unguarded `setTimeout(navigate)` call sites

**Owner:** ui
**Created:** 2026-04-21 (surfaced by `FE-ORCID-CALLBACK-TEARDOWN-CLEANUP` review 2026-04-21)
**Priority:** P3

## Context

`FE-ORCID-CALLBACK-TEARDOWN-CLEANUP` (commit `00033df`) introduced a `_mounted` + `_pendingTimers` + `destroy()` + `_setTimer` pattern in `frontend/src/pages/orcid-callback.js` to prevent post-teardown state mutation and stray navigation. The architect re-review surfaced 5 bare `setTimeout(() => this.navigate(...), N)` call sites in other pages with the same class of teardown hazard and no guard:

- `frontend/src/pages/publish.js:836`
- `frontend/src/pages/review.js:279` (*approximate — verify line at implementation time*)
- `frontend/src/pages/bridge.js:302`
- `frontend/src/pages/edit.js:824`
- `frontend/src/pages/edit.js:883`

All five fire after slow Hive broadcasts (3-10s end to end). A user pressing back during the wait triggers the delayed navigation on a destroyed component — a real UX regression, not speculative.

## Goal

Propagate the `orcid-callback.js` reference pattern to each of the 5 call sites:

1. Add `_mounted: true` and `_pendingTimers: new Set()` to the component state.
2. Add `destroy()` that sets `_mounted = false`, iterates `_pendingTimers` calling `clearTimeout`, then clears the set.
3. Add a `_setTimer(fn, ms)` helper matching the orcid-callback shape (register ID, gate `fn()` on `_mounted`).
4. Replace each bare `setTimeout(() => this.navigate(...), N)` with `this._setTimer(() => this.navigate(...), N)`.
5. Add a unit test per page asserting the timer is cleared on `destroy()` and `navigate` is not called after teardown.

## Extraction decision

Five call sites across four pages (plus the existing orcid-callback consumer) tips past "one consumer" and into clear duplication. Strongly consider extracting a shared helper — an Alpine magic (`$lifecycle` / `$timers`), a mixin, or a plain `useTimerGuard()` utility — rather than inlining the full `_setTimer` + `_mounted` + `_pendingTimers` + `destroy()` bundle six times.

If extraction happens, migrate `orcid-callback.js` to the helper in the same task so it doesn't carry a forked copy. If extraction is deferred (e.g., the 5 call sites need the pattern but the shared shape isn't obvious), at minimum factor the boilerplate into a shared object spread so the per-page state delta is minimal.

Make the extraction decision inside this task based on what the 5 call sites actually look like; don't commit to an API up front.

## Non-goals

- Auditing every `setTimeout` in the frontend. Debounce timers bound to input events have a different shape (replaced on next keystroke) and a different hazard model. Focus on `setTimeout(navigate)` and `setTimeout(state-mutation-after-success)` call sites in `frontend/src/pages/`.
- Hardening async continuations beyond timers (fetch/promise guards). The orcid-callback cleanup already covers async promise continuations in that file. Broader continuation hardening across other pages is a separate concern filed as `frontend-err-message-sanitize-sweep-rest-of-frontend.md` plus any future `/ce-compound` learnings the architect captures.

## Acceptance

- All 5 call sites use the guarded pattern (inline or via a shared helper).
- No bare `setTimeout(navigate)` remains in `frontend/src/pages/` after this task (grep as a check).
- If a helper was extracted, `orcid-callback.js` is migrated to it in the same commit set.
- One test per call site asserts post-teardown no-navigation behavior.
- Full frontend unit suite passes; `npm run build` clean.

## [TODO Architect]

None — self-contained pattern-propagation pass. Architect reviews at archive.

## UI re-review signal (2026-04-22, a33f667)

- Extraction decision: shared helper `createTimerGuard()` at `frontend/src/lib/timer-guard.js` (factory returning `{ _mounted, _pendingTimers, _setTimer, _teardownTimers }`). Pages spread it into their Alpine.data() state object and call `this._teardownTimers()` from `destroy()`. Helper keeps the public surface identical to orcid-callback's original inline shape modulo the rename `destroy` -> `_teardownTimers` (destroy() lives on the component and can call the helper in addition to its own teardown logic, e.g. editor disposal in publish.js / edit.js).
- All 5 sites migrated: `frontend/src/pages/publish.js:844`, `frontend/src/pages/review.js:290`, `frontend/src/pages/bridge.js:308`, `frontend/src/pages/edit.js:832`, `frontend/src/pages/edit.js:891`. Grep for `setTimeout(() => .* navigate` under `frontend/src/pages/` returns nothing (only debounce/retry timers remain).
- orcid-callback.js migrated in the same commit (no forked copy): inline `_mounted`/`_pendingTimers`/`_setTimer`/`destroy()` body replaced with `...createTimerGuard()` spread and a `destroy()` that delegates to `_teardownTimers()`.
- Tests: one post-teardown no-navigation assertion per site in `frontend/tests/unit/pages-{publish,review,bridge,edit}.test.js` (edit.js has two: same-author and continuation paths). Dedicated helper unit tests in `frontend/tests/unit/lib-timer-guard.test.js` (7 tests). Existing `frontend/tests/unit/pages-orcid-callback.test.js` timer-teardown test still passes against the migrated consumer.
- Full frontend unit suite: 862 pass; only pre-existing `sec-001-equivalence.test.js` dhive-import failure (noted in brief) remains. `npm run build` clean.
- E2E not run (parent owns serialization).
