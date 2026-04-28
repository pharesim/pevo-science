---
title: "Alpine factory-exposure specs guard the binding-missing failure mode but not template-expression mutations"
date: 2026-04-28
category: conventions
module: frontend/tests/unit
problem_type: convention
component: testing
severity: medium
applies_when:
  - "Adding a new imported helper to an Alpine factory's return so a template can call it via `x-text` / `x-html` / `:class` / `:title` / `x-show`"
  - "Replacing a raw field reference (`x-text=\"paper.discipline\"`) with a helper call (`x-text=\"titleCaseDiscipline(paper.discipline)\"`)"
  - "Migrating a CSS-only transform (e.g. `class=\"capitalize\"`) to a JS helper, where the regression mode is 'lose the helper, fall back to raw value'"
  - "Renaming a binding on the factory and updating template expressions in lockstep"
  - "Reaching for a factory-exposure spec (`expect(factory().helper).toBe(<imported helper>)`) and calling that adequate template-binding coverage"
tags:
  - alpine
  - factory-exposure
  - template-binding
  - mutation-testing
  - regression-tests
  - x-text
---

# Alpine factory-exposure specs guard the binding-missing failure mode but not template-expression mutations

## Context

PEvO's frontend is Alpine.js + Vite. Components are defined as data factories (e.g. `paperFeed`, `searchPage`, `paperDetailPage`, `profilePage`) under `frontend/src/{components,pages}/`. Templates reference helpers via Alpine expressions like `x-text="titleCaseDiscipline(paper.discipline)"`. For that expression to resolve, the factory's returned object MUST bind the helper as a property — otherwise Alpine evaluates the expression against the component scope, hits a ReferenceError, swallows it, and renders the element empty. No console noise, no test failure, no visible breakage in unit tests.

During the discipline-canon UI cluster review (2026-04-28), the testing persona flagged that the four new "factory-exposure" specs added across `frontend/tests/unit/` (one per migrated factory) had **mutation sensitivity zero** against the actual user-visible regression class. Reverting any of the 5 migrated `x-text` expressions back to `paper.discipline` (raw, pre-helper) passed the entire suite. The specs assert factory return shape; they do not assert that any template actually calls the binding.

This convention captures the gap and the two acceptable resolutions, so future migrations of the same shape (helper-on-factory + helper-call-in-template) don't ship with the same false-confidence test layer.

## Guidance

When a migration adds a helper to an Alpine factory **and** updates one or more template expressions to call it, a factory-exposure spec is **necessary but not sufficient**. Pair it with one of:

1. **Conscious acceptance** — document in the task / commit body that Playwright e2e is the probabilistic backstop for the template-expression layer, and ship.
2. **Deterministic closure** — add a render-level smoke test that mounts the component in jsdom, initializes Alpine, and asserts the rendered DOM text reflects the helper's transform.

### Pattern 1 — Factory-exposure spec (keep this; it's still useful)

```js
// frontend/tests/unit/components-paper-feed.test.js
import { titleCaseDiscipline } from '../../src/lib/discipline-display.js';
import { paperFeed } from '../../src/components/paper-feed.js';

describe('paperFeed factory exposes titleCaseDiscipline', () => {
  it('factory().titleCaseDiscipline is identity-equal to the imported helper', () => {
    const comp = paperFeed();
    expect(comp.titleCaseDiscipline).toBe(titleCaseDiscipline);
  });
});
```

This catches: helper deleted from factory return, helper shadowed by a local inline copy, helper imported from a stale path resolving to a different module copy.

This does **not** catch: template-side typos (`titleCaseDiscipine`), reverts of the `x-text` expression to `paper.discipline`, or migrations of the call to a different attribute (`x-html`, `:title`).

### Pattern 2 — Render-level smoke test (the deterministic closure)

```js
// frontend/tests/unit/components-paper-feed.render.test.js
import { JSDOM } from 'jsdom';
import Alpine from 'alpinejs';
import { paperFeed } from '../../src/components/paper-feed.js';

describe('paper-card renders titleCased discipline', () => {
  it('x-text resolves through the factory binding, not a raw field', async () => {
    const dom = new JSDOM(`
      <div x-data="paperFeed()" x-init="papers = [{ discipline: 'computer_science' }]">
        <template x-for="paper in papers">
          <span data-test="disc" x-text="titleCaseDiscipline(paper.discipline)"></span>
        </template>
      </div>
    `, { runScripts: 'dangerously' });

    global.document = dom.window.document;
    global.window = dom.window;
    Alpine.data('paperFeed', paperFeed);
    Alpine.start();

    await new Promise(r => setTimeout(r, 0));
    const text = dom.window.document.querySelector('[data-test="disc"]').textContent;
    expect(text).toBe('Computer Science');
  });
});
```

A render-level spec mutates against template-side regressions: revert the `x-text` to `paper.discipline` and the assertion fails (`'computer_science' !== 'Computer Science'`); typo the helper name and `x-text` evaluates to empty.

If jsdom + Alpine setup is too heavy for a single helper, the **cheaper deterministic alternative** is a Playwright e2e assertion against a fixture page that asserts rendered text — but that lives in the e2e tier, not unit.

## Why This Matters

Silent template-expression regressions are the worst class of frontend bug. The element renders empty or with raw underscored text (`computer_science` instead of `Computer Science`), the unit suite is green, deploys ship, and the only signal is user reports or a Playwright run that happens to cover that exact card with a non-trivial value. The factory-exposure spec **passing** is actively misleading: it implies "the helper is wired up" when the assertion only proves "the factory return shape contains the helper key."

This gap surfaced during the **discipline-canon UI cluster review** (cluster review, 2026-04-28) where the testing persona reviewed both `4a9a4fe` (FE-DISCIPLINE-DISPLAY-HARDEN round-1 hold #1) and `fd315fe` (FE-DISCIPLINE-DISPLAY-HARDEN-PAPER-RENDER-SITES first-pass) and noted on both that mutation sensitivity per migrated render-site was zero. Cross-reviewer agreement (the same finding flagged on two separate commits in the same cluster) promoted it from a single-commit nit to a cluster-wide convention.

Sibling conventions that bear on the same surface:

- `tests-must-fail-on-mutation-of-code-under-test-2026-04-22.md` — parent meta-rule; this convention is a frontend-Alpine-specific instance.
- `object-shape-fix-every-reset-site-2026-04-21.md` — sibling Alpine convention arguing for testing through real factory boundaries; same domain, different evaluation surface (API-shape vs template-expression).
- `wrapping-primitive-exhaustive-call-site-audit-2026-04-22.md` — distant sibling; same audit-by-grep-not-by-mental-model meta-pattern applied to backend wrapping primitives.

## When to Apply

This convention fires whenever a migration touches the **helper-on-factory + helper-call-in-template** pair. Concretely:

- Adding a new imported helper to a factory's return object so a template can call it via `x-text`, `x-html`, `:class`, `:title`, etc.
- Changing the binding name on the factory (rename) and updating template expressions in lockstep.
- Replacing a raw field reference (`x-text="paper.discipline"`) with a helper call (`x-text="titleCaseDiscipline(paper.discipline)"`) — this is the exact shape of the discipline-canon cluster migration.
- Migrating a CSS-only transform (`class="capitalize"`) to a JS helper, where the regression is "lose the helper, fall back to raw value."

It does **not** fire for:

- Pure logic helpers consumed only inside the factory body (no template binding) — factory-level unit tests already cover those.
- Helpers exposed for Playwright e2e fixture seeding only, where e2e is the documented coverage tier.

## Examples

### Before (the cluster's first-pass state — mutation sensitivity = 0)

`frontend/src/components/paper-card.js:16`:

```html
<span x-text="titleCaseDiscipline(paper.discipline)"></span>
```

`frontend/src/components/paper-feed.js` (factory):

```js
export function paperFeed() {
  return {
    papers: [],
    titleCaseDiscipline,  // bound for template use
    async load() { /* ... */ },
  };
}
```

`frontend/tests/unit/components-paper-feed.test.js`:

```js
it('factory().titleCaseDiscipline is identity-equal to the imported helper', () => {
  expect(paperFeed().titleCaseDiscipline).toBe(titleCaseDiscipline);
});
```

**Mutation test**: revert `paper-card.js:16` to `<span x-text="paper.discipline"></span>`. Run `npx vitest run`. Suite passes. Production renders `computer_science` instead of `Computer Science` on every paper card.

### After (gap closed deterministically)

Keep the factory-exposure spec above (it still catches factory-side regressions cheaply), AND add:

`frontend/tests/unit/paper-card.render.test.js`:

```js
import { JSDOM } from 'jsdom';
import Alpine from 'alpinejs';
import { paperFeed } from '../../src/components/paper-feed.js';

it('paper-card x-text routes discipline through titleCaseDiscipline', async () => {
  const dom = new JSDOM(`
    <div x-data="paperFeed()" x-init="papers = [{ discipline: 'computer_science' }]">
      <template x-for="paper in papers">
        <span data-test="disc" x-text="titleCaseDiscipline(paper.discipline)"></span>
      </template>
    </div>
  `, { runScripts: 'dangerously' });
  global.document = dom.window.document;
  global.window = dom.window;
  Alpine.data('paperFeed', paperFeed);
  Alpine.start();
  await new Promise(r => setTimeout(r, 0));
  expect(dom.window.document.querySelector('[data-test="disc"]').textContent).toBe('Computer Science');
});
```

**Mutation test**: revert the `x-text` to `paper.discipline`. Render spec fails (`'computer_science' !== 'Computer Science'`). Typo to `titleCaseDiscipine`. Render spec fails (empty `textContent`). Delete the binding from the factory. Both specs fail.

### After (gap accepted consciously)

Same factory-exposure spec, plus an explicit note in the task file or commit body:

> Template-expression correctness for the 5 migrated `x-text` sites (`paper-card.js:16`, `paper-detail.js:266`, `profile.js:47/73/226`) is covered by Playwright e2e (`frontend/tests/e2e/papers-browse.spec.js`), not by unit tests. Factory-exposure specs guard the binding shape only.

Both resolutions are acceptable. What's not acceptable is shipping a factory-exposure spec while believing it covers the template layer.

## Related

- `agents/docs/solutions/conventions/tests-must-fail-on-mutation-of-code-under-test-2026-04-22.md` — parent meta-rule. This convention is a frontend-Alpine-specific instance.
- `agents/docs/solutions/conventions/object-shape-fix-every-reset-site-2026-04-21.md` — sibling Alpine convention; "tests must feed real data through the real binding path" applied to API-shape; this doc extends to template-expression evaluation.
- `agents/docs/solutions/conventions/wrapping-primitive-exhaustive-call-site-audit-2026-04-22.md` — distant sibling on the audit-by-grep-not-by-mental-model meta-pattern.
- Cluster commits this learning was extracted from: `4a9a4fe` (FE-DISCIPLINE-DISPLAY-HARDEN round-1 hold #1, factory-exposure specs for paper-feed + search), `fd315fe` (FE-DISCIPLINE-DISPLAY-HARDEN-PAPER-RENDER-SITES first-pass, factory-exposure specs for paper-detail + profile + 4 render-site migrations).
