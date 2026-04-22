# FE-PAPERS-BROWSE-DISCIPLINE-OPTION-HYDRATION-RACE — Wait for discipline `<option>`s to hydrate before reading the first value

**Owner:** ui
**Created:** 2026-04-22 (surfaced by post-merge Playwright run 2026-04-22 covering FE-ORCID-CALLBACK-TEARDOWN-CLEANUP + FE-SETTINGS-ERROR-MESSAGE-SANITIZE-SWEEP)
**Priority:** P3

## Context

`frontend/tests/e2e/papers-browse.spec.js:48` failed (2/2 retries) with:

```
Error: expect(received).toBeTruthy()
Received: null

    46 |     .first()
    47 |     .getAttribute('value');
  > 48 |   expect(firstDiscipline).toBeTruthy();
```

The spec reads the first non-empty `<option>` of the discipline-filter `<select>` (line 41-48):

```js
const disciplineSelect = page.locator('select[x-model="discipline"]');
await expect(disciplineSelect).toBeVisible();
const firstDiscipline = await disciplineSelect
  .locator('option:not([value=""])')
  .first()
  .getAttribute('value');
expect(firstDiscipline).toBeTruthy();
```

The preceding assertions pass (`listBody.data.length > 0` → HAF has pevotest papers with disciplines on them). The root cause is a **hydration race**, not a data-availability gap:

- `await expect(disciplineSelect).toBeVisible()` waits for the `<select>` element itself to exist in the DOM, but NOT for its `<option>` children to be populated.
- The discipline list is populated asynchronously from the page's state (likely from the same `/api/papers` response or a side fetch). When the select is rendered but Alpine hasn't yet run the `x-for` pass that builds the `<option>`s, only the hardcoded "All disciplines" empty-value option exists — so `option:not([value=""])` returns nothing and `.getAttribute('value')` on the empty locator returns `null`.
- Two retries both hit the same race because the timing window is deterministic against the current dev backend latency on this machine.

## Goal

Update the spec to await option hydration before reading the first value. Two defensible shapes, prefer the first:

**Option A — wait on the option locator directly:**

```js
const firstRealOption = disciplineSelect.locator('option:not([value=""])').first();
await expect(firstRealOption).toBeVisible();   // or .toHaveCount >= 1
const firstDiscipline = await firstRealOption.getAttribute('value');
expect(firstDiscipline).toBeTruthy();
```

Lets Playwright's auto-waiting handle the race. No timing assumption about which request populates the dropdown.

**Option B — wait on the populating response explicitly:**

If `/api/disciplines` or the list response itself is what feeds the dropdown, wait for it the same way the spec already waits for `/api/papers`. This couples the spec to the populating endpoint but gives a more specific error on regression.

Option A is strictly better unless the dropdown is fed by a separately-timed request that the current page-level `waitForResponse` doesn't already cover — audit `frontend/src/pages/papers.js` and whichever component owns the discipline select to decide.

## Non-goals

- Changing what the dropdown contains or where it sources from.
- Reshaping the rest of the spec — only the 3-line hydration check + the existing `expect(firstDiscipline).toBeTruthy()` assertion.
- Auditing other specs for similar hydration races. If the grep surfaces obvious twins (e.g. other `option:not([value=""])` patterns), fix inline; otherwise file separately.

## Acceptance

- `papers-browse.spec.js` passes on a cold `npx playwright test papers-browse.spec.js` (no `--retries`) when the dev backend is healthy and HAF has ≥1 pevotest paper with a discipline set.
- No `sleep`/`waitForTimeout` fix — must be a real wait condition.
- Full Playwright suite clean on the branch that lands the fix (or documented-flaky with a separate follow-up).

## [TODO Architect]

None — self-contained spec-level fix.

---

**Architect re-review (2026-04-22) — HELD PENDING FIXES:**

First-pass `/ce-code-review` on commit `7961ac0` + merge `7139dcd` (8 personas: correctness, testing, maintainability, project-standards, api-contract, julik-frontend-races, ce-agent-native, ce-learnings-researcher). The fix to the Playwright spec and the FE-consumer migration are correct; the audit surfaced 4 hold items and several P3 residuals.

**Scope pivot note.** Task spec's Non-goals said "Changing what the dropdown contains or where it sources from." The implementer diagnosed during audit that the actual root cause was unmigrated `/api/disciplines` consumers (FE reading `d.name` after BE-DISCIPLINE-CANONICALIZE renamed the field → Alpine `:value="undefined"` → option with no `value` attribute → `getAttribute('value')` returned `null` → symptom looked like a hydration race). Scope was correctly extended to migrate paper-feed.js + search.js to `canon_name`/`display_name`. Per root CLAUDE.md §Asking Questions, the implementer should have paused to surface the non-goal conflict before acting. Noted as process feedback, not a hold item; the architect will append the scope-pivot narrative as "Implementation notes" at archive time so the task-archive entry is self-documenting.

Hold-block items below:

1. **P2 — Stale `_syncFromUrl` / `_pushUrl` comments claim loadDisciplines still lowercases** (correctness C-1 0.90 + maintainability M1 0.90, 2-reviewer convergence). `frontend/src/components/paper-feed.js:141, 156-158` and `frontend/src/pages/search.js:213, 227-229` — the comment in `_pushUrl` reads "Belt-and-suspenders: _syncFromUrl + loadDisciplines already lowercase the source values." False after this commit: `loadDisciplines` is now verbatim `res.data || []`. A future reader following the comment may remove `_pushUrl`'s own `.toLowerCase()` on the assumption it's redundant coverage, silently breaking any code path that assigns `this.discipline` / `this.disciplineFilter` directly without going through `_syncFromUrl` (explicitly tested via `comp.discipline = 'CHEMISTRY'`). Fix: update the comment in both files to say something like "_syncFromUrl lowercases URL reads; backend canon_name is already lowercase; _pushUrl catches direct state assignments." No code change needed.

2. **P3 — Dead `fetchDisciplines` import in publish.js** (api-contract AC-001 0.72). `frontend/src/pages/publish.js:2` imports `fetchDisciplines` from api.js but never calls it (page uses a static `DISCIPLINE_TAXONOMY`). Cheap cleanup. Fix: delete the import.

3. **P3 — Task-slug reference in source comments will rot** (maintainability M3 0.82). `loadDisciplines` comments in both files reference "BE-DISCIPLINE-CANONICALIZE" as the contract source. Task files are deleted on archive. Fix: reference `agents/docs/api-contracts/misc.md` (stable) instead of the task slug.

4. **P3 — Playwright `toHaveCount(1)` on `.first()` is tautological + 30s timeout on empty corpus** (testing T1 0.88 + julik JFR-3 0.78 + correctness C-2 0.85, 3-reviewer convergence). `frontend/tests/e2e/papers-browse.spec.js:50` — `.first()` already scopes to a single-element locator, so `toHaveCount(1)` on it is tautological (the wait condition is "first match resolves to ≥1 element" but the assertion reads as "exactly one"). Also: when `/api/disciplines` returns `[]` (beta corpus with no disciplines), the spec hangs for the 30s Playwright default timeout with an opaque message rather than failing readably. Task spec preferred Option A (`await expect(firstRealOption).toBeVisible()`). Fix: switch to `toBeVisible()` per spec Option A, AND add a preflight skip when `/api/disciplines` returns empty (`test.skip()` with a descriptive message).

**Dismissed from round-1 findings (architect triage):**
- **P3** No frontend shape-guard on canon_name pass-through (api-contract RR-001): subsumed by the `name` shim removal in `backend-discipline-canonicalize` hold item #2 — shim is dead anyway.
- **P3** No null-guard on canon_name (correctness RR-2): backend contract guarantees canon_name is lowercase string; defensive pre-check belongs on untrusted inputs, not contract-guaranteed fields.
- **P3** $t() post-teardown safe only accidentally (julik JFR-4 info): documented; no code change warranted until refactor threatens.
- **P3** Draft-timer teardown window in publish.js + edit.js (julik JFR-6): covered by `ui-async-continuation-teardown-guard-sweep.md` filed in this review pass.
- **P3** AbortError swallowing in fetch-backed catches (julik JFR-7): subsumed by the _mounted guard in the async-continuation sweep.
- **P3** login.js semantic-code carve-outs bypass i18n (correctness C-5 info): pre-existing, covered by the REV-5 sanitize-sweep hold block item #1.

**Filed as separate Pending tasks (out of scope for this hold):**
- `ui-async-continuation-teardown-guard-sweep.md` (P2) — JFR-001/002/003: 8 broadcast-heavy files (publish/edit/review/accreditation/bridge/comment-composer/vouch-section/accreditation-verify) + this task's paper-feed.js + search.js = 10 files with unguarded async catch continuations. Uses the existing `createTimerGuard()` helper. Also folds in the `_syncFromUrl` / `loadDisciplines` sequencing concern (JFR-2 — `init()` should `await loadDisciplines()` before `loadPapers()` so the select's x-model matches a hydrated option on first paint).
- `ui-paper-feed-search-discipline-composable.md` (P3) — duplicated loadDisciplines/_syncFromUrl/_pushUrl across paper-feed.js + search.js (maintainability M2).

**Past solutions relevant (ce-learnings-researcher):**
- `conventions/object-shape-fix-every-reset-site-2026-04-21.md` — applies to this commit's FE-consumer migration; the fix pattern is the Alpine analogue of the backend's SQL normalization sweep.
- `conventions/playwright-page-route-trigger-timing-2026-04-21.md` — aligned with Hold item #4's preference for the child-locator `toBeVisible()` wait shape over parent-locator `toBeVisible()` + independent `getAttribute` read.

**/ce-compound candidates at archive time** (none blocking; noted for archive):
- "Alpine `:value=\"undefined\"` renders an option with no `value` attribute (not empty string, not \"undefined\" — the attribute is absent). Playwright's `getAttribute('value')` returns `null`. The symptom presents as a hydration race (options rendered but value reads null) rather than as a missing-attribute contract mismatch. Correct diagnostic: inspect rendered attribute presence before adding awaits." Not covered by `object-shape-fix-every-reset-site-2026-04-21.md`; narrower and more memorable than the general "every-site" learning.
- "A backend contract rename requires a frontend migration task filed by the architect IN THE SAME review cycle. The gap between backend rename landing and FE migration landing creates `:value=\"undefined\"` windows that look like hydration races. REV-1 Hold #2 shim-is-already-dead is the dual of this finding — the architect filed a protective shim on BE for a FE consumer that THIS COMMIT had already migrated; the cross-task hold-block was stale by the time round-2 backend applied it."

**Path to re-archive:** (1) UI applies items #1-4 on this task. (2) UI re-review signal block below the hold. (3) Architect archives on clean round-2. The scope-pivot narrative will be prepended as "Implementation notes" at archive time.
