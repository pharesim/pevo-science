# Split the teardown describe block out of the fresh-auth session-window suite

**Owner:** ui
**Created:** 2026-09-01

Routed out of the architect review of the cross-user teardown work. A file-size
observation with a clean seam on the test side only.

## Why

`frontend/tests/unit/lib-fresh-auth-session-window.test.js` crossed 1000 lines
during the teardown work (756 before, 1021 after). The production file
`lib/fresh-auth.js` also crossed (957 to 1018), but the maintainability review found
no clean extraction seam there: the new teardown and generation-guard code is woven
through the exact closures it guards, so moving it would relocate the coupling
rather than remove it. The architect accepts the production file at its current size
(PEvO has no file-length rule) and this task does NOT split it.

The test file has a clean seam: the self-contained
`describe('teardown abandons in-flight acquisitions', ...)` block (roughly 260
lines) shares nothing with the rest of the suite beyond the module imports and the
file-level mocks.

## Scope

1. Move the teardown describe block into its own spec file beside the current one
   (e.g. `lib-fresh-auth-teardown.test.js`), carrying the imports, the file-level
   `vi.mock` setup, and the `tick` / `teardownSubjectState` helpers it needs.
2. Leave `lib/fresh-auth.js` untouched.

## Acceptance criteria

1. The teardown tests live in their own spec file and pass there.
2. The remaining `lib-fresh-auth-session-window.test.js` still passes with the
   teardown block removed, and both files are under 1000 lines.
3. No test is lost or weakened in the move (same count, same assertions).

## Notes

Pure test-file reorganization, no behavior change. Verify the vitest include glob
still collects the new file (it collects `tests/unit/**/*.test.js`, so a sibling
name is collected with no config change).
