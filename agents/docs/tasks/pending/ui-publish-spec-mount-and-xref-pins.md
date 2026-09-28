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
