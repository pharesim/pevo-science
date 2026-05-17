# UI-SETTINGS-DROP-DEFENSIVE-ROUTER-GUARD-CAPABILITY-CHECK — drop unnecessary `if (router && typeof …)` wrapper around registerNavigationGuard

**Owner:** UI
**Created:** 2026-05-17 (architect, surfaced by `/ce-code-review` on `ui-mid-broadcast-spa-navigation-guard` — maintainability M-1, P2/conf 75)
**Priority:** P3

## Problem

`frontend/src/pages/settings.js:612-627` wraps the navigation-guard registration in a defensive capability check:

```js
const router = Alpine.store('router');
if (router && typeof router.registerNavigationGuard === 'function') {
  if (this._navigationGuard) {
    router.unregisterNavigationGuard(this._navigationGuard);
    this._navigationGuard = null;
  }
  this._navigationGuard = () => { /* ... */ };
  router.registerNavigationGuard(this._navigationGuard);
}
```

The same file calls `Alpine.store('router').navigate(...)` and other router methods unconditionally elsewhere — the router store is a hard dependency of the settings page. Treating `registerNavigationGuard` as optional creates a false sense of resilience: if the registry ever goes missing, the upgrade flow silently runs without a guard, while the rest of the page still works (until the user clicks a nav link mid-broadcast, which is the case the guard exists to cover). Root CLAUDE.md: *"Don't add error handling, fallbacks, or validation for scenarios that can't happen. Trust internal code and framework guarantees."*

## Goal

Drop the capability wrapper. Call `router.registerNavigationGuard` directly; let a TypeError surface the regression if the registry ever disappears.

## Acceptance

1. `frontend/src/pages/settings.js` — remove the `if (router && typeof router.registerNavigationGuard === 'function')` wrapper. Keep the `if (this._navigationGuard)` deregister-before-reassign block (it's needed for Alpine re-init safety, independent of the capability check).
2. Apply the symmetric edit in `destroy()` where the matching `if (router && typeof router.unregisterNavigationGuard === 'function')` wrapper exists at the cleanup site.
3. Verify the existing settings + custody-upgrade test files still pass. They mock `router.registerNavigationGuard` / `unregisterNavigationGuard` via `mockRouterStore`, so the unconditional call already has a valid mock target.

## Out of scope

- Changing the deregister-before-reassign pattern itself (load-bearing per the alpine-init-handler-deregister-before-reassign-2026-05-17 convention).

## Cross-references

- `agents/docs/tasks-archive.md` — `UI-MID-BROADCAST-SPA-NAVIGATION-GUARD (archived 2026-05-17)` for the original implementation.
- `frontend/src/pages/settings.js` lines ~612-627 (init) and ~660-672 (destroy).
- Root `CLAUDE.md` "Don't add error handling … for scenarios that can't happen."
