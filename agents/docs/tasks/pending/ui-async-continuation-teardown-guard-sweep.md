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

None. self-contained pattern-propagation pass using the existing helper.

---

**UI implementer note (2026-04-22, merge commits `e3bba81` + `95ce11e`):**

Sweep fanned out into two parallel worktree subagents (1-A: paper-feed, search, publish, edit, review + sequencing fix + helper docblock; 1-B: accreditation, bridge, accreditation-verify, comment-composer, vouch-section). Both branched from pre-composable `5023a67`, so 1-A's inlined `loadDisciplines` migrations conflicted with the composable (`12782d6 ui: extract discipline-filter composable`) on `paper-feed.js` + `search.js`.

Resolution: merged 1-B first (no overlap with composable; clean auto-merge). Merged 1-A with manual conflict resolution — took 1-A's `createTimerGuard()` spread alongside the existing `createDisciplineFilter()` spread, took 1-A's `async init()` + `await this.loadDisciplines()` sequencing fix, dropped 1-A's inlined `loadDisciplines` method (composable owns it), and moved the post-await `_mounted` guards INTO the composable's `loadDisciplines`. The composable uses `this._mounted === false` (strict `false`, not falsy) so consumers that spread `createDisciplineFilter` without `createTimerGuard` retain prior behavior (undefined `_mounted` never short-circuits). Added 2 composable-level guard tests covering happy + error teardown paths.

Final totals: 899/899 unit tests pass; `npm run build` clean. `grep -n 'this\._mounted' frontend/src/{pages,components,lib}/` matches across all 10 in-scope files + the composable + the pre-existing `orcid-callback.js` + `timer-guard.js`. Helper docblock updated to note the primitive now covers both setTimeout and async-continuation teardown. Playwright NOT re-run in this pass (parent-level gate — the architect's review pass can run the E2E suite with the backend in test-mode, which requires the `./deploy.sh test-up` dance documented in the UI agent CLAUDE.md).

---

**Architect re-review (2026-04-22) — HELD PENDING FIXES:**

First-pass `/ce-code-review` on merges `e3bba81` + `95ce11e` (10 personas). The sweep's core pattern is correctly propagated across the 10 in-scope files; the composable's `=== false` strict check is correctly reasoned; the merge conflict resolution (1-B first, 1-A with composable-aware adaptation) is clean. However the review surfaced 5 missed-guard sites **inside the sweep's own scope** and 9 P3 polish items. Additional out-of-scope missed sites from Reviews #5/#6/#8 are filed as separate task `ui-teardown-guard-sweep-extension.md`.

Hold items:

1. **P2 — `paper-feed.js init()` missing `_mounted` check between loadDisciplines and loadPapers** (correctness C9-1 0.92). `frontend/src/components/paper-feed.js:~119` — `async init() { await this.loadDisciplines(); this.loadPapers(); window.addEventListener('popstate', ...); }`. If the component is destroyed during the loadDisciplines fetch, `init()` resumes and calls `loadPapers()` which writes `this.loading = true` on a destroyed scope before reaching any guard. The popstate listener also gets registered on a dead component, permanently leaking because `destroy()` already ran and cleared `_popstateHandler`. Fix: `if (!this._mounted) return;` immediately after `await this.loadDisciplines();`.

2. **P2 — `search.js init()` missing `_mounted` check before popstate registration** (correctness C9-2 0.90). `frontend/src/pages/search.js:~190` — same pattern. Back/forward navigation during the 1–3s disciplines fetch is missed; the newly-registered popstate listener can never be cleaned up. Fix: `if (!this._mounted) return;` immediately after `await this.loadDisciplines();`.

3. **P2 — `publish.js handleSubmit()` upload phase has 3 unguarded awaits** (correctness C9-3 0.88). `frontend/src/pages/publish.js:~735, ~737, ~750` — `sha256File`, `uploadToIpfs` for PDF, `uploadToIpfs` per supplementary file all write reactive state (`this.step`, `sf.uploading`, `sf.cid`, `sf.error`) with no `_mounted` guard. The first guard in `handleSubmit` is at line ~818 (after the confirm dialog), missing the entire upload phase. A component destroyed during a multi-second IPFS upload receives writes to a dead scope. Fix: `if (!this._mounted) return;` after each of the three upload awaits.

4. **P2 — `edit.js handleSubmit()` supplementary upload loop: unguarded await** (correctness C9-4 0.87). `frontend/src/pages/edit.js:~754` — `await uploadToIpfs(sf.file)` writes `sf.cid, sf.error, sf.uploading` without guard. First guard at line ~823 (post-broadcast) misses the upload phase. Fix: `if (!this._mounted) return;` after the await.

5. **P2 — `review.js loadPaper()` has no try/catch/finally; bare await triggers unhandled rejection on error** (julik JFR-1 0.92). `frontend/src/pages/review.js:~207` — bare `await fetchPaper(...)`. Two bugs ship together: (a) `fetchPaper` rejection (network error, 404, 503) becomes an unhandled promise rejection because caller `init()` calls `this.loadPaper()` without awaiting/catching; (b) `loadingPaper = true` set at line ~210 is never reset on any path → loading spinner permanently visible after any error. Every other data-fetch method in the sweep (`edit.js loadPaperData`, `paper-feed.js loadPapers`, `vouch-section.js loadVouchStatus`) uses try/catch + finally. Fix: wrap in try/catch + finally mirroring the sibling pattern; add a no-write-after-destroy test for `loadPaper`.

**Dismissed from round-1 findings (architect triage):**
- **P3** `vouch-section.js handleVouch + handleRetract` await `loadVouchStatus` unguarded after inner catch (julik JFR-2 0.72): inner-catch return prevents the state-write race; wasted network call on destroyed component is benign. Note for future cleanup.
- **P3** `paper-feed.js loadPapers` missing `finally` pattern vs `search.js doSearch` — inconsistency within the sweep (julik JFR-3 0.65): fold into `ui-teardown-guard-sweep-extension.md` (already filed).
- **P3** `comment-composer.js:79`, `accreditation-verify.js:69`, `accreditation.js handleSubmit / handleOrcidVerify / searchColleagues debounce`, `vouch-section.js handleRetract` success-path or debounce guards lack tests (testing T9-1 through T9-4 low): test-hygiene gaps; acceptance-met at one-test-per-file. Note for voluntary cleanup; not blocking.
- **P3** `timer-guard.js` docblock doesn't document the `=== false` strict convention for composables (maintainability M-1 0.62): canonical entry point should be the helper. Fold with the hold-fix commit opportunistically.
- **P3** 5 `finally` blocks use positive `if (this._mounted) this.x = y;` form vs dominant early-exit (maintainability M-2 0.61): semantically necessary in finally; add a one-line comment explaining polarity switch.
- **P3** `accreditation.js vouchDebounce` uses manual id-tracking vs `_setTimer` (julik RR-2): undocumented parallel pattern; acceptable.

**Filed as separate Pending tasks (out of scope for this hold):**
- `ui-teardown-guard-sweep-extension.md` (new P2) — extend `_mounted` guards to signup/login/reset-password/sign-in-modal/signup-verify/vote-buttons/contact.js + `paper-feed.loadPapers` finally pattern. Sites surfaced by neighbouring reviews (#5 / #6 / #8) outside this sweep's original scope.

**Path to re-archive:** (1) UI applies items #1-5 on this task. (2) UI re-review signal block below the hold. (3) Architect re-reviews round-2 with `/ce-code-review`; archives on clean. `ui-teardown-guard-sweep-extension.md` archives independently.
