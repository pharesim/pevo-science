# The publish spec never pins the $nextTick mount routing or the template x-ref names

**Owner:** ui
**Created:** 2026-09-28

Measured during the architect re-review of the edit-spec mount-coverage
task, by probes in isolated copies (pages-publish spec baseline 76 passed /
exit 0):

- `frontend/src/pages/publish.js` holds exactly one `$nextTick(` call site,
  which schedules `_mountEditors()`, and its template carries the same
  `x-ref="abstractEditor"` / `x-ref="bodyEditor"` pair `_mountEditors`
  reads.
- Unwrapping that `$nextTick` block to a bare `this._mountEditors()`
  SURVIVED the publish spec: 76 passed, exit 0.
- Renaming the template's `x-ref="abstractEditor"` likewise SURVIVED.

This is the twin of the two pins the edit spec now carries in its
`a successful load mounts the editors` describe: the exact-count `$nextTick`
routing assertion and the template `toContain` case over both x-ref names.
`pages-publish.test.js` already has the `_mountEditors teardown-during-init
guard` describe and the mocked `createEditor` harness, but nothing drives
the real mount-scheduling path and nothing reads the template. Mirror the
edit spec's two pins, adapted to publish.js's own structure:

1. A case on the real mount-scheduling path asserting the mount effect
   (`createEditor` once per present ref, `_editorsInitialized` true) AND the
   `$nextTick` routing. Before pinning an exact call count, verify
   publish.js's `$nextTick` call-site inventory on the tested path, and
   state the invariant the count rests on in the comment, no broader than
   what the assertion enforces.
2. A template case asserting the publish page's exported template carries
   both `x-ref` names `_mountEditors` reads.

## Constraints

- `frontend/tests/unit/pages-publish.test.js` only; nothing under
  `frontend/src/`.
- Check the publish spec's harness first: if its component factory does not
  already mock `$nextTick` as a synchronous spy the way the edit spec's
  `createComponent` does, mirror that harness shape; the mock stays
  synchronous either way.
- Comment anchors on stable symbols (`_mountEditors`, `$nextTick`, the
  template export name), never task slugs, hold ordinals, line numbers or
  SHAs; the pre-commit anchor gate refuses otherwise.
- Proof-first in isolated scratchpad copies, never the shared checkout: show
  both mutants surviving before the change and killed after, one fresh copy
  per probe.

## Acceptance criteria

1. Unwrapping the `$nextTick` mount-scheduling block in a scratchpad copy of
   `publish.js` fails at least one test; cite the failing case name and
   message in the signal block.
2. Renaming either template `x-ref` in a scratchpad copy of `publish.js`
   fails the template case.
3. `npx vitest run tests/unit/pages-publish.test.js` reports no Errors line
   and exits 0, with no existing test removed or weakened.
4. The full frontend unit suite exits 0 in an isolated two-level copy.

UI implementation signal (2026-09-30, commit afa2237b):

Landed in `afa2237b` (`frontend/tests/unit/pages-publish.test.js` only; an
ancestor of main, verified with `git merge-base --is-ancestor`). A new
`init mounts the editors` describe holds both pins.

Harness check: the publish spec's `createComponent` already mocks
`$nextTick` as a synchronous spy (`vi.fn((fn) => fn && fn())`), the same
shape as the edit spec's, so the harness is unchanged.

`$nextTick` inventory on the tested path: `init` holds publish.js's only
`$nextTick` call site, and nothing init reaches (`createTimerGuard`,
`_mergeCitationCollection`, `_loadAccreditedDirectory`) calls it. The only
other `nextTick` hits under `frontend/src` are in `edit.js` and the
`getting-started.js` template. The comment on the count states only that
init dispatches through `$nextTick` exactly once.

Probes, one fresh scratchpad copy each. The baseline spec at HEAD before
the change ran 79 cases (not the 76 measured when this task was filed; no
case was removed or weakened, the diff is additive plus one import).

- AC 1, `$nextTick` block unwrapped to a bare `this._mountEditors()`:
  before 79 passed / exit 0 (survived); after exit 1, failing case
  `publishPage > init mounts the editors > builds one editor per ref
  present when init runs`, message `AssertionError: expected "spy" to be
  called 1 times, but got 0 times`.
- AC 2, `x-ref="abstractEditor"` renamed: before survived; after exit 1,
  failing case `publishPage > init mounts the editors > declares the x-ref
  names _mountEditors reads in the template`, message `expected '…' to
  contain 'x-ref="abstractEditor"'`. `x-ref="bodyEditor"` renamed: same
  case, same shape of message for `bodyEditor`.
- AC 3, `npx vitest run tests/unit/pages-publish.test.js`: 81 passed,
  exit 0, no Errors line (also five consecutive runs, all exit 0).
- AC 4, full unit suite in an isolated two-level copy: 87 files / 1977
  tests passed, exit 0, no Errors line.

Further mutants killed by the init case: deleting the block, duplicating
it, adding a second empty `$nextTick`, swapping which ref feeds which
editor, renaming either code-side `$refs` read. One known survivor, outside
the acceptance criteria: replacing the block with an empty
`this.$nextTick(() => {})` beside an inline `this._mountEditors()`. The
count assertion pins the number of dispatches, not what runs inside the
callback, and the comment is worded to claim no more than that.

Observation for the architect, not acted on (edit spec is out of this
task's scope): the edit spec's `a successful load mounts the editors`
comment says refs assigned after the load are inert because of the
`_editorsInitialized` latch. In publish.js the equivalent claim is false:
`_mountEditors` reads `$refs` only after its dynamic import resolves, so
refs assigned right after `init()` are still picked up (probe: moving the
`$refs` assignment after `comp.init()` stayed green). The publish comment
therefore does not carry that sentence. Whether the edit spec's sentence
holds for `loadPaperData` was not measured here.
