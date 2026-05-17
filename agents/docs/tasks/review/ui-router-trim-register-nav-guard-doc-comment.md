# UI-ROUTER-TRIM-REGISTER-NAV-GUARD-DOC-COMMENT — trim verbose docblock on registerNavigationGuard

**Owner:** UI
**Created:** 2026-05-17 (architect, surfaced by `/ce-code-review` on `ui-mid-broadcast-spa-navigation-guard` — maintainability M-2, P2/conf 75)
**Priority:** P3

## Problem

`frontend/src/router.js:123-141` carries an 8-line docblock that mixes obvious-from-code restatement (signature, return-value semantics, the multi-guard AND-rule, "returns an unregister function for convenience") with the actually load-bearing WHY (popstate exclusion + the PEvO-specific `@click="navigate(...)"` rationale that justifies the scope decision). The signal is buried in the noise.

Root CLAUDE.md: *"Default to writing no comments. Don't explain WHAT the code does, since well-named identifiers already do that. Only add one when the WHY is non-obvious."*

The current comment:

```js
// Register a function that runs synchronously before each `navigate(path)`
// call. The guard receives `(targetPath)` and returns `true` to allow the
// navigation, `false` to block it. All guards must return true for the
// navigation to proceed. Guards typically surface a confirm prompt and
// gate on the user's response. Returns an unregister function for
// convenience; callers may also pass the same function reference back to
// `unregisterNavigationGuard`. Does NOT intercept popstate (browser
// back/forward) — that path goes around `navigate()`. In-page navigation
// in PEvO uses `@click="navigate(...)"` exclusively, so guard coverage
// matches the realistic interruption surface for an in-flight broadcast.
```

## Goal

Trim to the popstate + `@click` scope rationale only. Drop the signature / return-value / multi-guard restatement.

## Acceptance

1. `frontend/src/router.js` — replace the docblock above with a 3-4 line block containing only:
   - The popstate-out-of-scope explanation.
   - The PEvO-specific `@click="navigate(...)"` rationale that makes popstate omission acceptable.
   ```js
   // Does NOT intercept popstate (browser back/forward) — that path
   // goes around `navigate()`. In-page navigation in PEvO uses
   // `@click="navigate(...)"` exclusively, so guard coverage matches
   // the realistic interruption surface for an in-flight broadcast.
   ```
2. No code changes — purely the comment trim.
3. Tests untouched (no behavior change).

## Out of scope

- The router guard implementation itself.
- Comments on `unregisterNavigationGuard` and `navigate(path)` (they're already short).

## Cross-references

- `agents/docs/tasks-archive.md` — `UI-MID-BROADCAST-SPA-NAVIGATION-GUARD (archived 2026-05-17)` for the original implementation.
- `frontend/src/router.js` lines 123-141.
- Root `CLAUDE.md` "Default to writing no comments."
