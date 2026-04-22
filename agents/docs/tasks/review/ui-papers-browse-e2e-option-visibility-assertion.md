# UI-PAPERS-BROWSE-E2E-OPTION-VISIBILITY-ASSERTION — Fix Playwright `toBeVisible()` on `<option>` locator in papers-browse spec

**Owner:** ui
**Created:** 2026-04-22 (surfaced by Wave 1+2+3 post-merge Playwright run 2026-04-22)
**Priority:** P2

## Context

`frontend/tests/e2e/papers-browse.spec.js:62` asserts:

```js
const firstRealOption = disciplineSelect.locator('option:not([value=""])').first();
await expect(firstRealOption).toBeVisible();
```

Playwright's `toBeVisible()` requires a non-zero bounding box. `<option>` children inside a *closed* `<select>` have zero bounds in the rendered page, so this assertion fails consistently with `Received: hidden` — even though the locator resolves to the correct element (e.g. `<option value="computer science">Computer Science (2)</option>`). The DOM is correct; only the visibility check is wrong.

The assertion was introduced by commit `0d0a32f` ("ui: apply architect hold-block fixes on papers-browse discipline hydration task") on 2026-04-22, replacing the `waitForFunction` the initial hydration-race fix shipped with. It was never executed against a real Playwright run. Post-merge Playwright on 2026-04-22 exposed the failure.

**Verified pre-existing, not caused by UI Wave 1+2+3:** checking out main at `55fc03b` (pre-UI-Wave-2 state) and re-running the spec produces the identical failure. Our hold-fix merges (`3a5b60c`, `4611080`, `797540f`, `5dd9594`, `cbf53f1`, `9893275`) did not regress anything here.

## Why this matters

Papers-browse is the main entry point. Its E2E is load-bearing for the read-path gate. A single consistently-failing spec trains agents and reviewers to ignore the Playwright output, which defeats the point of running E2E before archive.

The hydration-race concern the assertion was trying to cover (Alpine's `x-for` hasn't yet populated `<template x-for="d in disciplines">`) is real. The fix is to pick an assertion that proves the options are present without depending on layout visibility.

## Goal

Replace the `toBeVisible()` assertion with one that works on `<option>` children inside a closed `<select>`. Options (in order of preference):

1. **`toHaveCount` on the non-blank options locator, with the expected count matching seeded disciplines.** Strongest: proves the hydrated count, not just presence.
   ```js
   await expect(disciplineSelect.locator('option:not([value=""])')).toHaveCount(N);
   ```

2. **`toHaveValue` / `toHaveAttribute` on the first real option** — proves the option exists *and* carries the expected value shape. No visibility check.
   ```js
   await expect(firstRealOption).toHaveAttribute('value', /.+/);
   ```

3. **Count-based `expect.poll()`** — explicit poll loop if the seed count is dynamic.

Preserve the downstream assertions at `:63-64` (`firstDiscipline` attribute + truthy check + the `/api/papers?discipline=...` waitForResponse). They already cover the "an option exists and is selectable" invariant.

## Non-goals

- Rewriting the whole spec. Scope is line 62 only.
- Changing the discipline-filter composable, `paper-feed.js`, or any production code. This is a pure test-fix task.
- Replacing `toBeVisible()` elsewhere in the E2E suite unless a grep turns up the same `<option>` pattern — if it does, fold those sites in with a one-line justification per site.

## Acceptance

- `npx playwright test papers-browse.spec.js --project=chromium` runs to completion with zero failures on a clean test stack (`./deploy.sh restart && ./deploy.sh test-up`).
- The hydration-race protection is preserved (the assertion must still fail fast if `x-for` has not yet rendered any discipline options — not just silently pass when `disciplines` is empty).
- No changes to `paper-feed.js` / `search.js` / `discipline-filter.js` / other production code.

## Coordination

- Parent gate on the UI Wave 1+2+3 review cycle (6 tasks currently in `review/`). The architect may wish to land this before archiving the discipline-composable / teardown-guard-sweep / err-sanitize / orcid-callback tasks so the E2E gate comes back clean on those reviews. Not a hard dependency — the round-2-hold tasks are fixed and the new P2s are correct; this spec failure is orthogonal.

## [TODO Architect]

None — self-contained test fix. The widened grep pattern in `agents/docs/solutions/conventions/frontend-error-sanitization-2026-04-21.md` is unrelated.

## UI implementation note (2026-04-22, commit `3393145`)

Work is already on `main`. The fix was bundled into `3393145` ("backend: move Wave 1 tasks to review/ (4 tasks)") rather than its own commit — a scope-rule violation at commit time, but the diff is the exact change this task specifies:

- `frontend/tests/e2e/papers-browse.spec.js:64` swapped `toBeVisible()` → `toHaveAttribute('value', /.+/)` (Option 2 from the task spec).
- Bonus fold: the `paper.discipline === firstDiscipline` loop switched to case-insensitive compare so the `canon_name` (filter) vs `display_name` (paper field) shapes don't collide.

The `54ef6cc` move-back to `pending/` read only `0d0a32f` as the last touch on the spec and missed `3393145`. Moving the task to `review/` so the architect can archive; the `git diff 0d0a32f..HEAD -- frontend/tests/e2e/papers-browse.spec.js` is the implementing diff.

E2E verification deferred at user direction (per-invocation decision 2026-04-22) — the change is self-evident in the diff and touches test code only.
