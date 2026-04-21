# FE-ORCID-CALLBACK-TEARDOWN-CLEANUP — Clean up pending timers/promises on `orcid-callback.js` component teardown

**Owner:** ui
**Created:** 2026-04-21 (surfaced by FE-ORCID-CALLBACK-FIXES round-2 julik-frontend-races review 2026-04-21)
**Priority:** P3

## Context

`frontend/src/pages/orcid-callback.js` has at least one uncanceled `setTimeout` (the 500ms redirect after ORCID login) that continues firing if the component is destroyed mid-wait. Symptoms: if a user navigates away from the callback page within the ~500ms window, the timeout still fires and attempts to push a route — typically a no-op today but a latent source of post-teardown state mutations as the page's async surface grows.

Broader concern: other async entry points (`_verify`, `_handleLogin`, `_handleSignup`, `_handleLink`) all dispatch promises that mutate component state when they resolve. A navigation-away before resolution lets the handlers write to a destroyed Alpine `$data` object.

## Goal

Audit every async operation in `frontend/src/pages/orcid-callback.js`:

1. `setTimeout` / `setInterval` calls — store IDs in component state, clear in `destroy()` hook.
2. Outstanding `fetch` / API calls — track via AbortController or a "mounted" flag; skip state writes post-teardown.
3. Awaited Promises from imported API helpers (`completeOrcid`, etc.) — same "mounted" flag guard.

Minimal shape:

```js
return {
  _mounted: true,
  _pendingTimers: new Set(),

  init() {
    // ...
  },

  destroy() {
    this._mounted = false;
    for (const id of this._pendingTimers) clearTimeout(id);
    this._pendingTimers.clear();
  },

  _handleLogin(data) {
    // ...existing logic...
    const timerId = setTimeout(() => {
      this._pendingTimers.delete(timerId);
      if (!this._mounted) return;
      this.$store.router.navigate('/');
    }, 500);
    this._pendingTimers.add(timerId);
  },
};
```

Apply the same `_mounted` check as the first line of every async continuation that writes to component state.

## Non-goals

Refactoring the page-level architecture. This is a cleanup pass, not a redesign.

Applying the same audit to other pages. If the pattern recurs, consider extracting a small helper (`useLifecycle()` Alpine magic or similar), but that's a separate task.

## Acceptance

- No `setTimeout` / `setInterval` call site leaves the timer reachable after `destroy()`.
- No async continuation writes to component state without a mounted check.
- One test per major handler asserting post-teardown resolution is a no-op (`destroy()` before `await Promise.resolve()`, then assert no state mutation).
- Full frontend unit suite passes; `npm run build` clean.

## [TODO Architect]

None — self-contained page-lifecycle cleanup.
