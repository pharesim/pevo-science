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
