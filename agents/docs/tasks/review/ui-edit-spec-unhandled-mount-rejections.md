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

---

## UI implementation signal (2026-09-22, commit e579c8c4)

`e579c8c4` `ui(tests): the edit harness gives every component a $refs`.
Self-verified: `git merge-base --is-ancestor e579c8c4 main` returns 0, and
`git show --name-status` lists exactly one file.

**The change.** 7 insertions / 4 deletions, both hunks in
`frontend/tests/unit/pages-edit.test.js`. `createComponent()` sets
`comp.$refs = {}` after the `$nextTick` mock, with a comment naming why (a real
Alpine component always has `$refs`; the deferred mount is discarded, so an
unset `$refs` becomes a post-pass unhandled rejection; cases needing live or
stale refs assign their own after construction). `loadedComponent()`'s local
`$refs = {}` and its three-line comment are removed as redundant. Nothing under
`frontend/src/`.

**AC 1 (spec clean, driven proof-first).** Observed the failure before touching
anything: `npx vitest run tests/unit/pages-edit.test.js` at HEAD gave
`81 passed (81)` / `Errors 3 errors` / exit 1, all three
`TypeError: Cannot read properties of undefined (reading 'abstractEditor')` at
`_mountEditors`. After: `81 passed (81)`, no Errors line, exit 0. Same 81 tests,
none skipped or weakened.

**AC 2 (teardown-guard block intact).** `npx vitest run
tests/unit/pages-edit.test.js -t 'teardown-during-init'` gives `4 passed | 77
skipped`, exit 0. All four assign their own `$refs` after construction, so the
default is overwritten where the block cares.

**AC 3 (full suite exits 0), and the count discrepancy the AC asks about.**
Full suite in the checkout: `86 passed (86)` / `1918 passed (1918)` / no Errors
/ exit 0. The task records 1911 tests at HEAD; the tree is at 1918. Nothing
landed to explain it: `git log 1affd33c..HEAD -- frontend/` is empty, so no
frontend code has changed since this task was filed. The 1911 was the
architect's isolated copy built from an older base. Proven by building a copy
from HEAD itself (`git archive HEAD frontend backend/src/lib/authMessage.ts`,
both `node_modules` symlinked) and running the full suite there:
`86 passed (86)` / `1918 passed (1918)` / `Errors 3 errors` / exit 1. So
before and after differ in the Errors line and the exit code only, and those
three rejections were indeed the only errors in the whole tree.

**AC 4.** `git show --name-status e579c8c4` lists only the spec file.

### Adversarial audit (4 lenses, 0 survivors)

Ran a four-lens panel with independent refutation, all probes in scratchpad
copies (the shared checkout was never written to or run in). Every finding was
judged; none survived.

- *Weakened assertions.* Instrumented the production `$refs` read itself. Across
  all 81 tests it is reached exactly 11 times, identically in both states. Eight
  reaches already carried a non-undefined `$refs`; only three flip `undefined` →
  `{}`, and they are exactly the three rejections. None of the three asserts on
  `_editorsInitialized`, `_abstractEditor`, `_bodyEditor` or `mockCreateEditor`.
  A per-test `mockCreateEditor` call-count-and-arg-shape dump diffs empty across
  81 tests. `$refs` is a fresh literal per call, every in-spec assignment is a
  wholesale reassignment (zero in-place mutations), and no test asserts `$refs`
  is undefined or snapshots the component's own-property set.
- *Mutation coverage.* Five prescribed mutants plus two unprescribed ones, each
  run against both states, judged on failing-test lines rather than exit code
  (the pre-change baseline already exits 1). Kill matrices are identical
  cell-for-cell. The two survivors (`if (true)` on the element guards; deleting
  the `$nextTick` mount scheduling) survived before the change as well, so
  neither is coverage this diff destroyed.
- *Comment anchors.* No slug, ordinal, `Option X.N`, `AC #N`, line number, SHA
  or positional anchor in the new comment; it anchors on `$refs`,
  `loadPaperData`, `_mountEditors`, `$nextTick`, all of which exist and behave as
  described. `.githooks/tests/test-pre-commit.sh` passes 37/37, and the real
  hook run against a throwaway repo staging this exact diff exits 0
  non-vacuously (all seven added lines reached the scan, no `anchor-allow`
  marker present, and a planted positive control fails the hook). Removing the
  `loadedComponent()` comment orphaned nothing.
- *Sibling sweep (survey only, per the no-widening constraint).* Zero siblings
  to report. Only `edit.js` and `publish.js` read `$refs` off a component
  instance, and `pages-publish.test.js` already sets `$refs` in its own
  `createComponent()`. Widening to the structural shape, the six other specs
  that mock `$nextTick` run `248 passed`, no Errors, exit 0.

### Note for the user, not filed as a task

One finding surfaced and was refuted as pre-existing and out of scope: the
spec's file-header block calls the file a "Minimal test harness ... focused on
the error-message-sanitization catch-block behavior", which understates a file
that now also covers mount teardown, uploads, fresh-auth gating and the
addressed-review ticks. It is byte-identical at HEAD, is not an anchor-rot
class, and this diff does not make it more false. Left alone; worth folding
into an unrelated sweep if one comes along.

The observation the task recorded as out of scope still stands unaddressed: the
same `$nextTick(() => { this._mountEditors(); })` discards its promise in
production, so a failed chunk import of `editor.js` becomes a browser-level
unhandled rejection rather than reaching `loadError`. The mutation pass
confirmed nothing asserts that scheduling at all. For the user to triage.
