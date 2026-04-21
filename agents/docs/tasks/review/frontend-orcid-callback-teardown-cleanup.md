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

## Architect re-review (2026-04-21) — HELD PENDING FIXES:

Code-reviewed via `/ce-code-review` on commit `00033df`. Core implementation is correct: `_mounted` guards cover every async continuation that writes component state, `_setTimer` correctly tracks IDs, `destroy()` cleans up, and the router (`page-mount.js`) reliably triggers `destroy()` on route change. The following items block archive:

1. **Missing `_handleAccredit` direct-call post-teardown test.** The task's acceptance criterion says "one test per major handler" — `_handleAccredit` is only covered implicitly via the `mode='accredit'` `_verify` resolution test, which never enters the handler body (the pre-switch `_mounted` guard short-circuits). Add a direct test at `frontend/tests/unit/pages-orcid-callback.test.js`: `comp.destroy(); comp._handleAccredit({ username: 'bob' });` and assert `status` stays `'verifying'`, `resultUsername` stays `''`, `auth._checkAccreditation` not called, `toast.show` not called. (testing/julik/maintainability 3-way agreement, 0.90 confidence.)

2. **Delete the implementation-coupled assertion at `frontend/tests/unit/pages-orcid-callback.test.js:424`.** `expect(comp._pendingTimers.size).toBe(0)` asserts internal Set state; the behavioral assertion at line 423 (`navigate` not called) already fully proves cancellation. Remove line 424 — rename-brittle and adds no regression-catching value.

3. **Add negative `localStorage.removeItem` assertion to the `_verify` teardown test at `frontend/tests/unit/pages-orcid-callback.test.js:363-384`.** `expect(localStorage.removeItem).not.toHaveBeenCalledWith('pevo_orcid_mode')`. Locks in the 503-refresh-retry invariant documented in `frontend/src/pages/orcid-callback.js:138-139`.

4. **Add negative `localStorage.removeItem` assertion to the `_handleSignup` teardown test at `frontend/tests/unit/pages-orcid-callback.test.js:428`.** `expect(localStorage.removeItem).not.toHaveBeenCalledWith('pevo_orcid_return_to')`.

5. **Extend the comment at `frontend/src/pages/orcid-callback.js:138-139`** to warn about the future-handler-async hazard. Append something like: `// If any handler later gains an await, move removeItem inside the handler after the mutation resolves. Otherwise a mid-await destroy() could clear mode without routing the flow, breaking 503-refresh-retry.`

6. **Add a one-line comment above the switch at `frontend/src/pages/orcid-callback.js:142`** documenting the implicit contract. Suggested shape: `// Handlers below are _mounted-gated by the check above; they do not re-check individually. Any direct call from elsewhere must guard at the call site.`

Deferred / dismissed during triage (no action required on this task):
- AbortController for `completeOrcid` fetch — backend TOCTOU guard catches double-exchange; flag approach sufficient.
- Double-`destroy()` idempotency test — Alpine lifecycle contract is single-destroy; test would encode behavior we don't rely on.
- `_setTimer` delete-before-check ordering — correct as-is; delete-first is mildly defensive.
- Pre-existing unguarded `setTimeout(navigate)` in publish/review/bridge/edit pages — filed as new task `ui-settimeout-navigate-teardown-guard-sweep.md`.
