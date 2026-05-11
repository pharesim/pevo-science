---
title: "Alpine `:value` (and `:disabled` / `:checked`) writes the DOM property, not the HTML attribute — CSS attribute selectors silently return zero matches"
date: 2026-05-11
category: conventions
module: frontend/tests/e2e
problem_type: convention
component: testing_framework
severity: medium
applies_when:
  - "Writing a Playwright locator like `input[value=\"X\"]` / `[value*=\"X\"]` against an input whose value is set by Alpine `:value=\"...\"`"
  - "Asserting disabled state on an input bound by Alpine `:disabled` (vs. a static `disabled` HTML attribute)"
  - "Asserting checked state on a checkbox bound by Alpine `:checked`"
  - "Reading the value of an Alpine-bound input — use `toHaveValue()` (property read), not `toHaveAttribute('value', ...)`"
  - "Setting state into an Alpine component from a test — use `Alpine.evaluate(root, 'field = \"X\"')` or `Alpine.$data(el).field = X`, never `_x_dataStack[0]`"
tags:
  - alpine
  - playwright
  - locator
  - property-vs-attribute
  - value-binding
  - data-testid
  - mutation-kill
  - refactor-stable-test
---

# Alpine `:value` (and `:disabled` / `:checked`) writes the DOM property, not the HTML attribute — CSS attribute selectors silently return zero matches

## Context

PEvO has hit this trap at least three times within two weeks, all in `frontend/tests/e2e/edit-paper.spec.js`:

1. **Discipline-field locator (fixed in `2f70270` 2026-04-28).** Original `input[disabled][value="Computer Science"]` returned zero matches at runtime; the test post-merge had to be fixed in a followup commit.
2. **Review-addressing checkbox locator at `edit-paper.spec.js:437` (held P1 as of `1ddc73e` 2026-05-11).** `input[type="checkbox"][value*="reviewer-"]` returns zero matches — same trap, missed by the implementer when fixing instance #1 one screen-scroll away in the same file. Test 4 of the spec fails at `toHaveCount(2)` or vacuously skips the broadcast-side assertions.
3. **Latent risk on instance #1's replacement selector.** The fix `input.select-control[disabled]` works only because the production template at `edit.js:151` has a STATIC `disabled` HTML attribute. If that ever becomes `:disabled="..."`, the locator silently breaks.

The pattern recurs because the failure mode looks like a render bug or a timing bug, not a selector-strategy bug. Browser DevTools show the correct `.value` in the console, creating a false impression that the attribute is set. Developers reach for `[value="..."]` selectors naturally.

## Guidance

**Never use CSS attribute selectors against an input whose attribute is set by an Alpine binding.** `:value`, `:disabled`, `:checked`, `:selected` all write the DOM PROPERTY, not the HTML attribute. `input[value="X"]`, `input[value*="X"]`, `input[disabled]`, `input[checked]` will silently return zero matches when the binding is Alpine-managed.

Three mitigation patterns, in order of preference:

### 1. Add a `data-testid` to the production template and locate by it

```js
// Production template (frontend/src/pages/edit.js):
// Before:
`<input type="checkbox" :value="rev.author + '/' + rev.permlink" ...>`
// After:
`<input type="checkbox" data-testid="address-review-checkbox" :value="rev.author + '/' + rev.permlink" ...>`

// Spec (frontend/tests/e2e/edit-paper.spec.js):
// Before:
const checkboxes = page.locator('input[type="checkbox"][value*="reviewer-"]');
// After:
const checkboxes = page.getByTestId('address-review-checkbox');
```

PEvO precedent: `data-testid="recover-method-orcid"` was added to the recover ORCID tab in FE-SEC-004-POLISH item 5 for exactly the same reason (brittle text-based selector → stable test-id).

### 2. Assert on the `.value` property using `toHaveValue()`

```js
// frontend/tests/e2e/edit-paper.spec.js (from 2f70270):
const disciplineInput = page.locator('input.select-control[disabled]').first();
await expect(disciplineInput).toHaveValue('Computer Science');
// .toHaveValue() reads el.value (the property). Auto-retries through Alpine's reactive flush.
// NOT: input[value="Computer Science"] — that reads getAttribute(), which is null.
// NOT: .toHaveAttribute('value', 'Computer Science') — same problem.
```

### 3. Container-scoped structural selector as a fallback

When adding a per-element `data-testid` is unwanted (e.g., a dynamic list where each element would need a unique suffix):

```js
const card = page.locator('[data-testid="address-reviews-card"]');
const checkboxes = card.locator('input[type="checkbox"]');
```

The card test-id is static markup; the inner structural selector avoids any Alpine-managed attribute.

### Setting state into Alpine from a test

Use the public Alpine API. Do not reach into `_x_dataStack[0]` (private, undocumented):

```js
// Correct (PEvO convention from FE-SEC-004-POLISH item 4):
await page.evaluate(() =>
  Alpine.evaluate(document.querySelector('[x-data]'), 'field = "X"')
);
// Also acceptable:
await page.evaluate(
  (el) => (Alpine.$data(el).field = 'X'),
  await page.locator('[x-data]').elementHandle(),
);
// Never:
await page.evaluate(() => document.querySelector('[x-data]')._x_dataStack[0].field = 'X');
```

## Why This Matters

Alpine's `bindInputValue` at `frontend/node_modules/alpinejs/dist/module.cjs.js:2843-2853` takes this branch for non-boolean / non-array / non-null string values:

```js
else if (!Array.isArray(value) && typeof value !== "boolean" && ![null, void 0].includes(value)) {
  el.value = String(value);
}
```

The assignment is `el.value = String(value)` — a PROPERTY write. `setAttribute('value', ...)` is never called on this code path.

In the browser DOM, `el.value` (the property) and `el.getAttribute('value')` (the attribute) are independent. The HTML attribute is the markup-source "initial value"; the property is the live runtime value. Once Alpine writes the property, the attribute stays at whatever was in the source markup — typically absent or empty for elements rendered from an `x-for` template.

CSS attribute selectors — `[value="X"]`, `[value*="X"]`, `[disabled]`, `[checked]` — call `getAttribute()` internally. When Alpine has only set the property, `getAttribute('value')` returns `null` and the selector matches nothing.

The failure modes, from most to least informative:

1. `await expect(locator).toHaveCount(N)` → fails immediately with a count mismatch. Clear signal that the selector returned nothing, but still points at "count" rather than "selector strategy."
2. `await locator.first().toHaveText('...')` → fails with "element not found" or a value mismatch depending on whether `.first()` resolves to an unrelated element.
3. `await locator.first().toBeVisible()` or `.click()` → **times out after the full Playwright timeout.** This is the worst failure mode: the page renders fine, the value is correct, only the test cannot see it. Developers add `waitForSelector`, increase timeouts, insert extra `networkidle` waits — none help. This is exactly what would happen in instance #2 above before the held fix lands.

## When to Apply

Apply this convention whenever a Playwright (or Vitest) spec selector targets an `<input>`, `<button>`, `<select>`, or `<option>` element in the PEvO frontend that has any of:

- `:value="..."` — most common; drives this entire document
- `:disabled="..."` — `[disabled]` attribute selector breaks when Alpine manages it
- `:checked="..."` — `[checked]` attribute selector breaks
- `:selected="..."` — `[selected]` attribute selector breaks

**Grep recipe — find all `:value` binding sites across page templates:**

```bash
grep -nE ':value=' frontend/src/pages/*.js
```

Run this before writing any new selector that includes `[value`. Every hit is a potential trap.

**Static-attribute exception (brittle):** If the production template has a hardcoded static `disabled` (no `:disabled` binding), the `[disabled]` selector works because the attribute IS in the source HTML. Instance #1's replacement selector relies on this — `edit.js:151` has a literal `disabled` attribute. The risk: if a future refactor changes that to `:disabled="someCondition"`, the selector silently breaks. Prefer `data-testid` even in the static-attribute case when the element is test-critical.

**Boolean attribute nuance:** Alpine SOMETIMES sets the `disabled` / `checked` HTML attribute for boolean values via a different branch in `bindInputValue` (the `Array.isArray(value)` / boolean branch). Don't generalize this convention beyond `:value` without checking the specific Alpine branch for the binding you're using. The safe-and-uniform rule remains: use `data-testid` for selection and `toHaveValue` / `inputValue()` / `isChecked()` / `isDisabled()` for assertion.

## Examples

### Instance 1 — Discipline-field locator (fixed in commit `2f70270`)

**Before:**
```js
const disciplineInput = page.locator('input[disabled][value="Computer Science"]');
// Returns zero matches: edit.js:151's :value="discipline" sets the .value property only.
// getAttribute('value') → null. CSS [value="Computer Science"] → no match.
await expect(disciplineInput).toBeVisible(); // times out at the full Playwright timeout
```

**After (`2f70270`):**
```js
const disciplineInput = page.locator('input.select-control[disabled]').first();
await expect(disciplineInput).toHaveValue('Computer Science');
// .toHaveValue() reads el.value (the property). Auto-retries through Alpine's reactive flush.
// [disabled] works here only because edit.js:151 has a STATIC disabled attribute.
```

### Instance 2 — Review-addressing checkbox locator (held P1 bug at `1ddc73e`)

**Before (current broken state, `frontend/tests/e2e/edit-paper.spec.js:437`):**
```js
const checkboxes = page.locator('input[type="checkbox"][value*="reviewer-"]');
// Returns zero matches: edit.js:337-339 binds :value="rev.author + '/' + rev.permlink".
// getAttribute('value') → null. [value*="reviewer-"] → no match.
await expect(checkboxes).toHaveCount(2); // fails — count is 0
```

**After (prescribed by the held hold-block in `ui-e2e-edit-paper-flow.md` item 1):**
```js
// Step 1: add to production template at frontend/src/pages/edit.js:337:
//   <input type="checkbox" data-testid="address-review-checkbox" :value="rev.author + '/' + rev.permlink" ...>

// Step 2: update spec:
const checkboxes = page.getByTestId('address-review-checkbox');
await expect(checkboxes).toHaveCount(2);
```

### Instance 3 — Latent risk on the static-`disabled` assumption

The current `input.select-control[disabled]` selector (instance #1's replacement) works only because `edit.js:151` has a literal `disabled` attribute. A future refactor to `:disabled="!canEdit"` silently breaks the locator with no other code change. The failure would again present as a mysterious timeout.

Hardened form (recommended before any `edit.js:151` refactor):

```js
// Add to edit.js:151: data-testid="discipline-select"
const disciplineInput = page.getByTestId('discipline-select');
await expect(disciplineInput).toHaveValue('Computer Science');
```

### Mutation-kill verification (the cheap two-minute check)

To confirm a new or repaired selector is actually exercising the Alpine binding:

1. In `frontend/src/pages/edit.js`, temporarily corrupt the `:value` expression — e.g., change `:value="rev.author + '/' + rev.permlink"` to `:value="rev.author + '/' + rev.permlink + '_TYPO'"`.
2. Run the spec.
3. If the spec turns red (value mismatch or element-not-found), the selector is correctly tracking the Alpine binding.
4. If the spec stays green, the locator is matching a different element or the assertion is not reading the property — investigate before proceeding.
5. Revert the typo.

This is especially important for `getByTestId` locators scoped to a dynamic list, where a misplaced `data-testid` might match a sibling element.

## Related

- `agents/docs/solutions/conventions/tests-must-fail-on-mutation-of-code-under-test-2026-04-22.md` — parent meta-rule. This convention is a specific instance: when the selector reads `getAttribute()` and Alpine sets `.value`, the test passes regardless of whether the property is set correctly — same "test that cannot be made red by mutating code under test" class.
- `agents/docs/solutions/conventions/alpine-factory-exposure-vs-template-mutation-coverage-2026-04-28.md` — thematic sibling in the "Alpine mutation-sensitivity zero" cluster. Different mechanism (template-expression layer vs. DOM property-vs-attribute layer), same underlying shape (Alpine feature writes state in a way naive tests cannot observe).
- `agents/docs/solutions/conventions/playwright-page-route-trigger-timing-2026-04-21.md` — tool-sibling. Different problem (page.route + waitForRequest pairing), same surface (Playwright traps against an Alpine page).
- `agents/docs/solutions/conventions/js-coercion-mutation-kill-vector-2026-05-04.md` — distant sibling. Same meta-pattern (test passes for the wrong reason); different domain (JS coercion vs. DOM property write).
