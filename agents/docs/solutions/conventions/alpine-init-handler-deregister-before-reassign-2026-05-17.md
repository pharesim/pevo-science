---
title: "Alpine `init()` must deregister-before-reassign for `window`/`document` event listeners"
date: 2026-05-17
category: conventions
module: frontend/src/pages
problem_type: convention
component: frontend_stimulus
severity: high
applies_when:
  - "Writing an Alpine component that registers a `window` or `document` event listener (`beforeunload`, `resize`, `popstate`, `keydown`, `visibilitychange`, etc.) from `init()`"
  - "Storing the handler reference on `this.*` so a paired `destroy()` can `removeEventListener` it"
  - "Reviewing any `init()` that does `this._someHandler = (e) => { ... }; window.addEventListener('...', this._someHandler);`"
  - "Refactoring an existing Alpine component to add lifecycle-bound event listeners"
tags:
  - alpine
  - lifecycle
  - event-listener
  - beforeunload
  - re-instantiation
  - memory-leak
---

# Alpine `init()` must deregister-before-reassign for `window`/`document` event listeners

## Context

Alpine.js's documented contract is "`init()` runs once per component instance, `destroy()` runs once before re-instantiation." In practice, x-data scope changes and SPA route re-mounts can call `init()` again WITHOUT an intervening `destroy()`. When `init()` registers a `window` event listener and stores the handler reference on a `this.*` property for paired `removeEventListener` parity, the second `init()` orphans the first handler in `window`'s listener list. That orphan carries a closure over the now-dead component scope, fires for every navigation for the tab's lifetime, and attempts to access reactive state on a disposed component.

Surfaced in `ui-custody-upgrade-seed-phrase-derive-flow` round-2 review (julik-frontend-races persona, JFR-1) and fixed in round-3 commit `7fdeae7`. The bug class is invisible until the orphan handler tries to access state — at which point the user sees a confusing "you have unsaved changes" beforeunload prompt on unrelated navigation, or a thrown error in console.

## Guidance

When `init()` registers a `window` or `document` event listener and stores the handler reference on a `this.*` property, the first 3-line block of `init()` MUST unconditionally remove any prior handler on that property before reassigning and re-registering. The deregister branch is a no-op on first init (when the property is null/undefined) and correctly cleans up the prior handler on every re-init.

```js
init() {
  // Deregister-before-reassign: Alpine can re-instantiate the component
  // (x-data scope change, route re-mount) without an intervening destroy().
  // Without this guard the first init's closure stays bound to window for
  // the tab's lifetime, capturing the dead component scope.
  if (this._beforeUnloadHandler && typeof window.removeEventListener === 'function') {
    window.removeEventListener('beforeunload', this._beforeUnloadHandler);
    this._beforeUnloadHandler = null;
  }

  this._beforeUnloadHandler = (e) => {
    if (this.upgradePhase === 'upgrading') {
      e.preventDefault();
      e.returnValue = '';
      return '';
    }
  };
  window.addEventListener('beforeunload', this._beforeUnloadHandler);

  // ...rest of init()
}

destroy() {
  if (this._beforeUnloadHandler && typeof window.removeEventListener === 'function') {
    window.removeEventListener('beforeunload', this._beforeUnloadHandler);
    this._beforeUnloadHandler = null;
  }
}
```

The pattern generalizes to ANY `window` or `document` event listener held by an Alpine component on a property reference — `resize`, `popstate`, `keydown`, `visibilitychange`, `online`/`offline`, MutationObserver disconnects held on `this.*`, etc. Not just `beforeunload`.

`typeof window.removeEventListener === 'function'` is a defensive SSR/JSDOM guard; in test environments where `window` is mocked partially, the typeof check prevents the deregister from throwing.

## Why This Matters

Alpine's lifecycle is not as deterministic as the docs imply. Three concrete re-init paths exist in the wild:

1. **`x-data` scope change** — when an `x-data` directive's expression evaluates to a new object reference (e.g., a parent component re-renders its slot), Alpine treats it as a new component and calls `init()` again. The old component is not guaranteed to receive `destroy()` first if the DOM node itself was reused.
2. **SPA route re-mount** — a router that swaps page-level components by re-rendering the `x-data` root can call `init()` on the same DOM node twice in a row without the old instance's `destroy()` firing.
3. **Hot-module reloads in dev** — Vite HMR can re-execute the component factory without invoking the old instance's `destroy()`.

In all three paths, the handler-on-`this.*` pattern leaks the prior handler to `window`. The leak is:
- **Permanent for the tab's lifetime** — `window` event-listener registrations don't auto-clean on component disposal.
- **Closure-carrying** — the orphan handler holds a reference to the disposed component's reactive state, the Alpine scope, and anything else the closure captured. Garbage collection of the old component is blocked.
- **Symptomatic on unrelated navigation** — for `beforeunload` specifically, every subsequent navigation in the tab fires the orphan handler. If the handler checks reactive state (e.g., `this.upgradePhase === 'upgrading'`) the check evaluates against stale state, sometimes producing spurious "you have unsaved changes" warnings on pages that have nothing to do with the original component.

The framework doesn't warn. There is no Alpine-level diagnostic. The bug is invisible in dev with hard refreshes (which destroy the page entirely) and only surfaces with SPA navigation patterns or Alpine re-instantiations that production users hit.

## When to Apply

- Every `init()` that registers a `window` or `document` event listener and stores the handler on `this.*` for later `removeEventListener` parity in `destroy()`.
- Code review checklist for any new Alpine component that touches `window.addEventListener`, `document.addEventListener`, or any disconnectable observer (MutationObserver, ResizeObserver, IntersectionObserver) held on `this.*`.
- Refactoring an existing Alpine component to add a lifecycle-bound event listener — back-fill the deregister-before-reassign block at the top of `init()` even if the component currently has no observed re-init path; the framework's re-init behavior is not stable enough to depend on its absence.

## Examples

**Wrong (the original code in `frontend/src/pages/settings.js` before round-3):**

```js
init() {
  this._beforeUnloadHandler = (e) => {
    if (this.upgradePhase === 'upgrading') {
      e.preventDefault();
      e.returnValue = '';
      return '';
    }
  };
  window.addEventListener('beforeunload', this._beforeUnloadHandler);
}

destroy() {
  window.removeEventListener('beforeunload', this._beforeUnloadHandler);
}
```

Second `init()` without intervening `destroy()` → first handler reference is overwritten, first registration leaks to `window` for the tab's lifetime.

**Right (round-3 fix, `frontend/src/pages/settings.js:583-586`):**

```js
init() {
  if (this._beforeUnloadHandler && typeof window.removeEventListener === 'function') {
    window.removeEventListener('beforeunload', this._beforeUnloadHandler);
    this._beforeUnloadHandler = null;
  }

  this._beforeUnloadHandler = (e) => {
    if (this.upgradePhase === 'upgrading') {
      e.preventDefault();
      e.returnValue = '';
      return '';
    }
  };
  window.addEventListener('beforeunload', this._beforeUnloadHandler);
}
```

Second `init()` → branch fires, first handler is removed from `window`, then the new handler is registered. No leak.

## Related

- [synchronous-flag-before-await-idempotency-guard-2026-05-16.md](synchronous-flag-before-await-idempotency-guard-2026-05-16.md) — sibling Alpine lifecycle convention: idempotency guards must set their flag BEFORE the first `await`. Same class of "Alpine async/lifecycle code must be defensive about re-entry."
- [alpine-factory-exposure-vs-template-mutation-coverage-2026-04-28.md](alpine-factory-exposure-vs-template-mutation-coverage-2026-04-28.md) — broader Alpine testing/lifecycle pattern from earlier PEvO work.
- `agents/docs/tasks/review/ui-custody-upgrade-seed-phrase-derive-flow.md` — origin task (round-2 hold JFR-1 surfaced the bug; round-3 commit `7fdeae7` landed this fix; archived alongside this entry).
