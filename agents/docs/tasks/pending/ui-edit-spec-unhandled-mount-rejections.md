# Three edit-page specs leave `_mountEditors` dereferencing an unset `$refs`, so vitest exits 1 on a green suite

**Owner:** ui
**Created:** 2026-09-22

Surfaced while the architect closed the "suite green" claim on
`ui-empty-string-proof-reads-as-ready-window` in an isolated copy. Every test
passes at HEAD (86 files / 1911 tests) and vitest still exits 1:

```
Test Files  86 passed (86)
     Tests  1911 passed (1911)
    Errors  3 errors
```

All three are unhandled rejections that originate in
`frontend/tests/unit/pages-edit.test.js`, and the file reproduces them alone
(81 passed, 3 errors, exit 1). Not introduced by any task currently in flight:
the three tests date from 2026-05-06 (`c0de45bc`, `26c3b6b0`).

## What happens

`createComponent()` in the spec builds the page object from the `Alpine.data`
factory and mocks `$store`, `$t`, `$watch` and `$nextTick` (as a synchronous
call-through), but never sets `$refs`. On a successful `loadPaperData`, the
handler schedules `this._mountEditors()` through `$nextTick` and discards the
promise. `_mountEditors` passes its `_mounted` guard, awaits the dynamic
`editor.js` import, then reads `this.$refs.abstractEditor` on `undefined`:

```
TypeError: Cannot read properties of undefined (reading 'abstractEditor')
 > Object._mountEditors src/pages/edit.js  (the `this.$refs.abstractEditor` read)
```

Nothing awaits that promise, so the TypeError surfaces as an unhandled
rejection after the test has already passed. The three tests that take the
success path with `_mounted = true` and no `$refs`:

1. `init() registers every draft $watch handler + 1 storage listener exactly once; subsequent loadPaperData() does not re-register`
   (the `reactive bindings register exactly once across retries` block). The
   second `loadPaperData()` does not throw again only because the first
   `_mountEditors` had already set `_editorsInitialized` before it threw.
2. `rapid concurrent invocation: only one fetch fires; post-state reflects single consistent result`
   (the `loadPaperData concurrent-retry guard` block).
3. `flag resets after Promise.allSettled rejection so retry can proceed`
   (same block; the second, successful load is the one that mounts).

The `loadPaperData catch:` test in the same region sets `_mounted = true` too
but takes the failure path, so it never schedules the mount.

The spec already knows the shape. The draft-restore block's `loadedComponent()`
helper sets `comp.$refs = {}` with a comment saying exactly why: "an empty
$refs lets that deferred mount find no editor elements instead of
dereferencing undefined." That fix was applied locally to one describe block
and not to the harness the whole file shares.

## Why it is worth closing

A non-zero exit on an all-pass suite is a lie in both directions. Every
implementer's "suite green" claim is currently made by reading the test count
and ignoring the exit code, and the next real unhandled rejection anywhere in
the tree lands in the same bucket where nobody looks. CI, when it exists, will
fail on it.

## What to change

Default `$refs` in the shared harness: `comp.$refs = {}` inside
`createComponent()`. The `_mountEditors teardown-during-init guard` tests set
their own `$refs` (null elements, mock elements, `{}`) after construction and
are unaffected by a default. Once the default exists, `loadedComponent()`'s own
`$refs = {}` line and its comment become redundant; drop them or leave a
one-line pointer, either is fine. Do NOT guard `this.$refs` in `edit.js` for
this: a real Alpine component always has `$refs`, so a production guard would
defend a state only the harness produces.

## Observation, not in scope

The same `$nextTick(() => { this._mountEditors(); })` shape discards the
promise in production too, so a failed chunk import of `editor.js` (a real
outcome on a flaky connection for a code-split module) becomes a browser-level
unhandled rejection rather than reaching `loadError`. Recorded for the user to
triage separately; do not widen this task to it.

## Acceptance criteria

1. `npx vitest run tests/unit/pages-edit.test.js` reports 0 errors and exits
   0, with the three unhandled rejections gone and no test skipped or
   weakened. Driven proof-first: observe the three rejections before the fix.
2. The `_mountEditors teardown-during-init guard` block still passes with its
   own `$refs` assignments intact.
3. The full unit suite exits 0. At HEAD the three edit-spec rejections are the
   only errors, so this follows from criterion 1 unless something else has
   landed since; if it has, say so in the signal block rather than absorbing
   it.
4. No change under `frontend/src/`.
