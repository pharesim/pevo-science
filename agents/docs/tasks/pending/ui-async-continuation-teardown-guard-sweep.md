# UI-ASYNC-CONTINUATION-TEARDOWN-GUARD-SWEEP — Apply _mounted guard pattern to async catch continuations across 10 frontend files using the createTimerGuard() helper

**Owner:** ui
**Created:** 2026-04-22 (surfaced by FE-PAPERS-BROWSE-DISCIPLINE-OPTION-HYDRATION-RACE review + FE-ERR-MESSAGE-SANITIZE-SWEEP-REST-OF-FRONTEND review 2026-04-22)
**Priority:** P2

## Context

The `UI-SETTIMEOUT-NAVIGATE-TEARDOWN-GUARD-SWEEP` task produced `frontend/src/lib/timer-guard.js` — a `createTimerGuard()` factory returning `{ _mounted, _pendingTimers, _setTimer, _teardownTimers }` — to guard `setTimeout(() => this.navigate(...))` call sites against post-teardown execution. That sweep's Non-goals section explicitly deferred "Hardening async continuations beyond timers (fetch/promise guards)" to separate work.

Two parallel architect reviews on 2026-04-22 flagged the same class of gap outside the setTimeout sweep's scope:

- **`ui-papers-browse-discipline-option-hydration-race`** review: JFR-1 — `paper-feed.js`:113-116 and `search.js`:184-187 both call `loadDisciplines()` in `init()` via `.catch(err => { this.disciplinesLoadFailed = true; ... })` without a `_mounted` guard. `Alpine.destroyTree()` fires synchronously on SPA route change; an in-flight fetch that resolves post-teardown writes to a destroyed reactive scope.

- **`ui-err-message-sanitize-sweep-rest-of-frontend`** review: JFR-001 / JFR-002 / JFR-003 — `publish.js`, `edit.js`, `review.js`, `accreditation.js`, `bridge.js`, `comment-composer.js`, `vouch-section.js`, `accreditation-verify.js` all await multi-second broadcasts/network I/O and write `this.step` / `this.errorMessage` in catch blocks without `_mounted` guards. Same class of bug as the setTimeout sweep closed for navigation.

Plus a related sequencing concern from review #2 (JFR-2): `paper-feed.js` `init()` runs `_syncFromUrl()` (sync) then `loadDisciplines()` (no await). Until the fetch resolves, the select can't match `x-model` against any option and briefly shows "All disciplines" despite URL state. Same file, same teardown surface.

## Why this matters

Teardown-race writes are a real SPA bug class. Impact is usually invisible (silent console errors, potential memory leaks), but the underlying mechanism is the same Alpine.destroyTree race the setTimeout sweep already normalized on. The fix shape is established and the helper already exists.

## Goal

1. **Migrate the two discipline consumers to the timer-guard helper:**
   - `frontend/src/components/paper-feed.js`: spread `createTimerGuard()` into the Alpine.data state, add `if (!this._mounted) return;` guards at the top of every catch and every post-await continuation in `loadDisciplines`, `loadPapers`, `onDisciplineChange`, etc. `destroy()` calls `this._teardownTimers()`.
   - `frontend/src/pages/search.js`: same.

2. **Migrate the 8 broadcast-heavy pages/components from REV-5 JFR-001/002/003:**
   - `frontend/src/pages/publish.js`, `edit.js`, `review.js`, `accreditation.js`, `bridge.js`
   - `frontend/src/components/comment-composer.js`, `vouch-section.js`
   - `frontend/src/pages/accreditation-verify.js`

   Same pattern: spread the helper, guard post-await continuations (catch + happy path + any `.then(...)` callbacks) on `_mounted`, wire `destroy()`. Some of these already have `destroy()` bodies (editor disposal in publish.js/edit.js) — additive, not replacement.

3. **Sequencing fix in paper-feed.js + search.js init() (REV-2 JFR-2):**
   - `init()` currently runs `_syncFromUrl()` synchronously, then kicks off `loadDisciplines()` + `loadPapers()` in parallel. The race window where the select has no options but state is set causes a visible "All disciplines" flash. Fix: `await this.loadDisciplines()` before `this.loadPapers()` in init. (Keep subsequent refetches parallel — only init's first pass needs ordering.)

4. **Tests:**
   - Per migrated file, one unit test asserting that a post-`destroy()` catch continuation does NOT write to component state. Mirrors the `ui-settimeout-navigate-teardown-guard-sweep` test pattern.
   - Grep verification: `grep -rn 'this\._mounted' frontend/src/{pages,components}/` should match in each of the 10 files post-sweep.

5. **Update comments & docs:**
   - Any paper-feed.js / search.js comments that still reference pre-sweep lowercasing or stale canonicalization claims are updated.
   - Add a note in `frontend/src/lib/timer-guard.js` that the same helper now guards both `setTimeout(navigate)` call sites AND async-continuation catches — helper is the canonical teardown primitive.

## Non-goals

- Migrating every `.catch()` in the frontend. Scope is limited to the 10 named files with identified teardown hazards.
- AbortController-based in-flight fetch cancellation (JFR-007). Cleaner but larger scope; file as follow-up if wanted.
- Alpine lifecycle refactor. Keep the existing `init()` + `destroy()` + magic-$t semantics.

## Acceptance

- All 10 files (`paper-feed.js`, `search.js`, `publish.js`, `edit.js`, `review.js`, `accreditation.js`, `bridge.js`, `comment-composer.js`, `vouch-section.js`, `accreditation-verify.js`) use `createTimerGuard()` spread + `_mounted` guards on post-await continuations.
- `paper-feed.js init()` awaits `loadDisciplines()` before `loadPapers()` for first-render ordering.
- One test per file asserting no-write-after-destroy.
- Full frontend unit suite passes; `npm run build` clean.
- Playwright E2E clean (or at minimum papers-browse.spec.js clean on cold run).

## [TODO Architect]

None — self-contained pattern-propagation pass using the existing helper.
