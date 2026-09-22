# The edit spec never proves a successful load mounts the editors, and its retry-invariant test retries nothing

**Owner:** ui
**Created:** 2026-09-22

Surfaced by the architect's review of `e579c8c4` (the `$refs` harness default;
archived under `UI-EDIT-SPEC-UNHANDLED-MOUNT-REJECTIONS`). Both items predate
that commit, survived its mutation audit, and were confirmed by independent
probes in isolated copies. Neither blocks anything; both are cheap. Do them in
one commit against `frontend/tests/unit/pages-edit.test.js` only.

## Item 1: nothing asserts the load path schedules the mount

In `frontend/src/pages/edit.js`, a successful `loadPaperData` schedules
`this._mountEditors()` through `$nextTick`, and `_mountEditors` reads
`this.$refs.abstractEditor` / `this.$refs.bodyEditor` and calls
`createEditor` for each. Every `mockCreateEditor` assertion in the spec lives
in the `_mountEditors teardown-during-init guard` block, which calls
`_mountEditors()` directly. No `it()` block both awaits `loadPaperData()` and
asserts on `mockCreateEditor`. Consequences, each probe-verified:

- Deleting the `$nextTick(() => { this._mountEditors(); })` block in
  `edit.js` is a surviving mutant: 81 passed / 0 errors / exit 0.
- Renaming the template's `x-ref="abstractEditor"` is likewise invisible to
  the unit spec (there is no `x-ref` in `frontend/tests/unit/`).
- Replacing the harness default `comp.$refs = {}` with populated refs
  `{ abstractEditor: {}, bodyEditor: {} }` is also a surviving mutant, so the
  default is defended only as "does not throw", not for what it produces.

Add one test in a load-path describe: build the component, set
`comp._mounted = true`, set `comp.$refs = { abstractEditor: <el>,
bodyEditor: <el> }` BEFORE calling `loadPaperData()` (see the trap below),
resolve `fetchPaper` / `fetchPaperEnrichment` as the concurrent-retry tests
do, `await comp.loadPaperData()`, then assert `mockCreateEditor` was called
twice with the two elements and that `_editorsInitialized` is true. The
harness can drive this today: with refs set before the load, the real path
yields two `createEditor` calls. Optionally add a second short case pinning
that a default (empty) `$refs` load yields zero `createEditor` calls, which is
what turns the harness default from "does not throw" into an asserted state.

**Trap.** `_mountEditors` sets `_editorsInitialized = true` before it reads
`$refs`, and returns early on the next call when the flag is set. After any
successful load with empty refs, the flag is latched with zero editors, so
refs assigned afterwards are inert. Refs must be set before
`loadPaperData()`, not after. The `createComponent()` comment says cases
"assign their own after construction", which is accurate for the
teardown-guard block (it calls `_mountEditors` directly); do not read it as
"after the load".

## Item 2: the retry-invariant test's retry is a no-op

`init() registers every draft $watch handler + 1 storage listener exactly
once; subsequent loadPaperData() does not re-register` (the `reactive
bindings register exactly once across retries` block) calls `comp.init()`
without awaiting it, then immediately `await comp.loadPaperData()`.
`loadPaperData` sets `this._loadInFlight = true` synchronously before its
first `await`, and its entry guard is `if (this._loadInFlight) return;`, so
the "retry" returns before doing anything: `fetchPaper` is called exactly
once across the whole test. The "subsequent `loadPaperData()` does not
re-register" half of the invariant is proven against a call that never ran.
(The architect's earlier task-file description of this test, which said the
second call reached the mount, was wrong on mechanism.)

Make the retry real, probe-verified to pass (1 passed, exit 0):

- After computing the post-init counts, wait for init's own load to settle:
  `await vi.waitFor(() => expect(comp._loadInFlight).toBe(false));` and
  `expect(fetchPaper).toHaveBeenCalledTimes(1);`
- Keep `await comp.loadPaperData();`
- Then `expect(fetchPaper).toHaveBeenCalledTimes(2);` before the existing
  `$watch` / storage-listener count assertions.

The test's own header comment ("registrations happen exactly once across
init + N loadPaperData calls") is then true of what the test does.

## Constraints

- `frontend/tests/unit/pages-edit.test.js` only. No change under
  `frontend/src/`; in particular do not guard `this.$refs` or restructure
  the `$nextTick` scheduling in `edit.js`. The production discarded-promise
  observation (a failed `editor.js` chunk import never reaches `loadError`)
  was triaged separately and dismissed for now.
- Any new comment anchors on stable symbols (`_mountEditors`,
  `_loadInFlight`, `loadPaperData`, `$nextTick`), never on task slugs, hold
  ordinals, line numbers or SHAs; the pre-commit anchor gate will refuse
  otherwise.
- Drive each item proof-first: show the mutant surviving (item 1) and
  `fetchPaper` at 1 call after the "retry" (item 2) before the change, in an
  isolated copy, never in the shared checkout.

## Acceptance criteria

1. Deleting the `$nextTick` mount-scheduling block in a scratchpad copy of
   `edit.js` fails at least one test in the spec. Cite the failing test name
   in the signal block.
2. In the retry-invariant test, `fetchPaper` is asserted at 1 call after
   init settles and 2 calls after the retry; the `$watch` and storage-listener
   count assertions are unchanged and still pass.
3. `npx vitest run tests/unit/pages-edit.test.js` reports 0 errors and exits
   0, with no existing test removed or weakened; the `_mountEditors
   teardown-during-init guard` block is untouched.
4. The full unit suite exits 0.
