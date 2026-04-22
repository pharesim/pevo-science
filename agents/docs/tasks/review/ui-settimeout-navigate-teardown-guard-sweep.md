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

## Architect re-review (2026-04-22) — HELD PENDING FIXES:

Code-reviewed via `/ce-code-review` on commit `a33f667`. The extraction is correct: factory returns a fresh object per call, method binding via Alpine proxy `this` (plain object methods, not arrow-captured), `_mounted` lifecycle is clean, `_pendingTimers` cleanup on fire is correct, all 5 navigate-timer sites migrated, `orcid-callback.js` migrated without regression to its prior hold-block fixes. Grep confirms no bare `setTimeout(navigate)` remains under `frontend/src/pages/`. The following items block archive:

1. **Add 2 unit tests to `frontend/tests/unit/lib-timer-guard.test.js` covering the extraction's core invariants.** Three reviewers (correctness 0.90, testing 0.92 + 0.80) agree that factory-isolation and `_teardownTimers()` idempotency are safe by construction but unasserted — the exact properties a future author is most likely to accidentally violate by caching the factory return value at module scope.

   - **Factory isolation:** call `createTimerGuard()` twice, arm a timer on the first instance, call `_teardownTimers()` on it, then assert the second instance's `_mounted === true` and `_pendingTimers.size === 0`. This prevents a future module-level hoist from silently sharing state across components.
   - **Idempotency:** call `_teardownTimers()` twice on the same instance; assert no throw and state stays consistent (`_mounted === false`, `_pendingTimers.size === 0`).

2. **Expand the JSDoc at `frontend/src/lib/timer-guard.js`** to warn adopters that `createTimerGuard()` must be called inside the per-mount `Alpine.data(() => ({ ... }))` factory, NOT at module scope. Rationale: the return value carries `_pendingTimers` (a `Set`) and `_mounted` (a boolean) — both component-instance state. A module-level hoist shared across two components would corrupt teardown (clearing one would clear the other's timers; `_mounted = false` in one would silently gate the other's callbacks). Suggested addition (≈3 lines):

   ```js
   /**
    * ... (existing JSDoc)
    *
    * USAGE: Call inside the per-mount Alpine.data factory
    * (`Alpine.data(() => ({ ...createTimerGuard(), ... }))`), NOT at module
    * scope. The returned object holds component-instance state
    * (`_pendingTimers` Set, `_mounted` flag); hoisting a single return value
    * shared across multiple components would corrupt teardown state.
    */
   ```

Deferred / dismissed during triage (no action required on this task):
- `review.js:211` `loadPaper()` post-fetch write lacking `_mounted` check — already covered by the in-flight `ui-async-continuation-teardown-guard-sweep` task (currently in review/; `_mounted` guards are already applied at `review.js:212, 221, 242, 265, 289, 297`).
- Copy-pasted 6-step teardown block across 4 page-test files — dismissed; the shape is short, honest duplication that teaches the pattern at each call site.
- `bridge.js` / `review.js` thin-wrapper `destroy()` methods lack a cross-reference comment — dismissed as low value; the underscore prefix on `_teardownTimers` already signals internal helper.
- Residual risk: the helper centralizes timer-teardown only, not awaited-promise continuations. The `ui-async-continuation-teardown-guard-sweep` task covers that surface.

## UI re-review signal (2026-04-22, commit 15d6866)

Round-2 fixes landing the 2 architect hold items from the 2026-04-22 re-review:

1. **Factory isolation test** — added to `frontend/tests/unit/lib-timer-guard.test.js`. Creates two `createTimerGuard()` instances, arms + tears down the first, asserts the second's `_mounted === true` and `_pendingTimers.size === 0`, and additionally asserts the two `_pendingTimers` Sets are distinct object identities (extra belt-and-suspenders check). Prevents a future module-level hoist from silently sharing state across components.
2. **Idempotency test** — added to the same file. Arms a timer, calls `_teardownTimers()` twice; second call is wrapped in `expect(() => ...).not.toThrow()` and the post-state asserts `_mounted === false` and `_pendingTimers.size === 0`.
3. **JSDoc warning** — appended to `frontend/src/lib/timer-guard.js` using the architect's suggested wording verbatim (no intentional divergence), styled as a `// USAGE:` line-comment block consistent with the file's existing `//`-comment header (rather than a JSDoc `/** */` block, since the existing file header is `//`-comments; switching one section to `/** */` would be inconsistent). Content is identical to the hold-block shape.

Intentional divergences from the architect's suggested wording:
- Comment style: `//` line-comments instead of `/** */` JSDoc. Rationale: match the existing file header. Content and warning verbatim otherwise.
- Hold block said "7 existing tests" — the file actually has 6. Added 2, total 8. All pass.

Verification:
- `npx vitest run tests/unit/lib-timer-guard.test.js` — 8/8 pass.
- Full frontend unit suite — 864 pass; only the pre-existing `sec-001-equivalence.test.js` dhive-import failure remains (unrelated, noted).
- `npm run build` — clean.
