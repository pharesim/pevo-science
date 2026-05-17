---
title: "`vi.spyOn(sessionStorage, 'removeItem')` does not intercept in jsdom — Storage methods live on the prototype"
date: 2026-05-17
category: conventions
module: frontend/tests/unit
problem_type: convention
component: testing_framework
severity: medium
applies_when:
  - "Writing a vitest unit test that needs to assert `localStorage.*` or `sessionStorage.*` method calls"
  - "Reviewing a test where a `vi.spyOn(sessionStorage, '...')` assertion seemingly fails to fire despite the production code clearly invoking the method"
  - "Migrating an existing test from `localStorage` to `sessionStorage` (or vice versa) and reaching for spy patterns"
  - "Adding new mock surface for browser Storage in a test file that doesn't already replace the global via `vi.stubGlobal`"
tags:
  - vitest
  - jsdom
  - sessionstorage
  - localstorage
  - storage-prototype
  - vi-spyon
  - vi-stubglobal
  - test-mocking
related_components:
  - testing_framework
---

## Context

PEvO's `ui-non-consent-broadcast-fresh-auth-wiring` round-3 test work needed to assert that `auth.disconnect()` calls `sessionStorage.removeItem('pevo_orcid_mode')`. The natural-feeling pattern — `vi.spyOn(sessionStorage, 'removeItem')` — does not work in jsdom. The spy never registers a call, even though the production code observably runs `sessionStorage.removeItem(...)` and the key is removed. The test assertion silently fails: `expect(removeSpy).toHaveBeenCalledWith('pevo_orcid_mode')` reports "expected to be called, but was never called" with no further diagnostic.

The cause is a jsdom implementation detail. jsdom's `Storage` (the prototype of both `localStorage` and `sessionStorage`) implements its methods on `Storage.prototype`, not as own properties on each storage instance. `vi.spyOn(target, methodName)` calls `Object.getOwnPropertyDescriptor(target, methodName)` and, when the property is missing, attempts `Object.defineProperty(target, methodName, ...)` to install the spy. For jsdom Storage, this defineProperty call silently does nothing — the access still resolves up the prototype chain to the unspied `Storage.prototype.removeItem`. No error is thrown, no warning logged.

The pattern is reachable in any test that touches Storage and reaches for `vi.spyOn` instead of the replace-the-global form.

## Guidance

**Two acceptable patterns, in order of preference:**

### 1. Replace the global with `vi.stubGlobal` (preferred)

This is the established PEvO pattern, used across `pages-recover.test.js`, `pages-orcid-callback.test.js`, `pages-settings-custody-upgrade-round2.test.js`, and similar files. Mock the entire Storage object up-front in `beforeEach` (or globally for the test file); production code's `sessionStorage.removeItem(...)` call lands directly on `vi.fn()` and the assertion records normally.

```js
import { vi, beforeEach } from 'vitest';

beforeEach(() => {
  vi.stubGlobal('sessionStorage', {
    getItem: vi.fn(),
    setItem: vi.fn(),
    removeItem: vi.fn(),
    clear: vi.fn(),
    key: vi.fn(),
    length: 0,
  });
});

it('disconnect() removes pevo_orcid_mode', () => {
  // ... arrange + act ...
  expect(sessionStorage.removeItem).toHaveBeenCalledWith('pevo_orcid_mode');
});
```

Use this pattern when the test file already mocks browser globals (most PEvO frontend test files do). The `vi.stubGlobal` call replaces the binding before any production code reads it, so there is no jsdom prototype path to fall through to.

### 2. Patch `Storage.prototype` directly when the global replacement is not viable

If the test must keep jsdom's real Storage backing (e.g., to verify cross-method interactions like `setItem` then `getItem` returning the actual value), patch the method directly on the prototype where jsdom actually installs it:

```js
import { vi, beforeEach, afterEach } from 'vitest';

let removeSpy;

beforeEach(() => {
  removeSpy = vi.spyOn(Storage.prototype, 'removeItem');
});

afterEach(() => {
  removeSpy.mockRestore();
});

it('disconnect() removes pevo_orcid_mode', () => {
  // ... arrange + act ...
  expect(removeSpy).toHaveBeenCalledWith('pevo_orcid_mode');
});
```

`Storage.prototype` is the actual install point in jsdom, so `vi.spyOn` finds the property and the spy intercepts. `mockRestore` in `afterEach` is required — the prototype is shared across `localStorage` and `sessionStorage` AND across every test in the same process, so a leaked spy poisons subsequent tests. The `vi.stubGlobal` form has no equivalent leak risk because the global rebinding is per-test.

### Anti-pattern (does not work)

```js
// Does NOT intercept in jsdom — silently passes through to Storage.prototype.
const removeSpy = vi.spyOn(sessionStorage, 'removeItem');
expect(removeSpy).toHaveBeenCalledWith('pevo_orcid_mode'); // always fails
```

The assertion failure is silent in the sense that there is no diagnostic explaining WHY the spy didn't register — just "expected 1 call, got 0." A reviewer reading the test prose can convince themselves the production code is broken when the test itself is incorrectly mocked.

## Why This Matters

Storage spying is a routine need — almost every PEvO test for an auth or flow-state code path touches `localStorage`/`sessionStorage`. The wrong-pattern failure mode is invisible at the test-author level. Symptoms:

- "I clearly see `sessionStorage.removeItem` in the production code, but the spy says it wasn't called."
- "The test passes locally with manual stepping but fails in CI" (often a red herring — the test was already failing for this reason).
- Worse: the test author reaches for a fallback like asserting `sessionStorage.getItem('key')` returns `null` after the call. That works (jsdom DOES execute the removal under the spy-less call) but the assertion is weaker — a regression that calls `removeItem` on the wrong key, or fails to call it at all, can still pass if the key happens not to be present in the test fixture.

The first pattern (`vi.stubGlobal`) is preferred because it shifts the storage object away from jsdom's prototype implementation entirely. The second pattern (`Storage.prototype` spy) is acceptable when the real jsdom backing is needed but requires explicit `mockRestore` to avoid cross-test contamination.

## When to Apply

- **Writing any new frontend unit test that asserts on storage method calls** — default to pattern 1 if the test file already uses `vi.stubGlobal` for other globals; otherwise add it.
- **Reviewing a test where a storage spy seemingly doesn't fire** — check whether `vi.spyOn(sessionStorage, ...)` is being used and recommend pattern 1 or 2.
- **Adding a new test to an existing file** — match the file's established pattern. Most PEvO frontend test files use pattern 1 already; do not introduce pattern 2 alongside it unless there's a specific reason the test needs real jsdom Storage.

## Examples

### Established pattern in PEvO (pattern 1)

`frontend/tests/unit/pages-orcid-callback.test.js` uses `vi.stubGlobal('sessionStorage', { getItem: vi.fn(...), setItem: vi.fn(...), removeItem: vi.fn(...) })`. All assertions on `sessionStorage.removeItem('pevo_orcid_return_to')` and `sessionStorage.getItem('pevo_orcid_mode')` record correctly because the production code's `sessionStorage` binding resolves to the stubbed object, not jsdom's prototype-backed Storage instance.

`frontend/tests/unit/fresh-auth-401-retry.test.js` follows the same pattern and additionally exercises real timing behavior of the cached proof via the stubbed storage map (`getItem` returns whatever `setItem` last wrote, via a closure).

### When pattern 2 is appropriate (rare)

A test that wants to verify the **interaction** between `setItem` and a later `getItem` against jsdom's real Storage (rather than a mocked closure) would use:

```js
beforeEach(() => {
  sessionStorage.clear();
  removeSpy = vi.spyOn(Storage.prototype, 'removeItem');
});

afterEach(() => {
  removeSpy.mockRestore();
});

it('writes then removes', () => {
  sessionStorage.setItem('k', 'v');
  expect(sessionStorage.getItem('k')).toBe('v');
  disconnect();
  expect(removeSpy).toHaveBeenCalledWith('k');
  expect(sessionStorage.getItem('k')).toBeNull();
});
```

This is rarely needed in PEvO — the closure-backed mock in pattern 1 covers the same surface for almost all storage assertions.

## Cross-references

- `agents/docs/tasks-archive.md` — `UI-NON-CONSENT-BROADCAST-FRESH-AUTH-WIRING (archived 2026-05-17)`, round-3 testing where the implementer surfaced this gotcha as a `/ce-compound` candidate.
- `frontend/tests/unit/pages-orcid-callback.test.js`, `frontend/tests/unit/pages-recover.test.js` — examples of the established `vi.stubGlobal` pattern.
- `agents/docs/solutions/conventions/storage-scope-localstorage-vs-sessionstorage-for-spa-flow-state-2026-05-17.md` — the sister convention covering when to use sessionStorage vs localStorage (the production-side rule that motivates these test-side mocks).
