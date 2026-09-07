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

---

## UI implementation signal (2026-09-07)

**Landed:** the `describe('teardown abandons in-flight acquisitions')` block moved
verbatim (byte-identical to its former lines) into
`frontend/tests/unit/lib-fresh-auth-teardown.test.js`, carrying the vitest imports,
the three file-level `vi.mock` factories, the `issuance` / `seedWindow` / `cached`
helpers, the top-level `beforeEach` / `afterEach`, and the block-scoped `tick` /
`teardownSubjectState` helpers. `lib/fresh-auth.js` untouched.

**Counts:** 64 tests before, 47 + 17 = 64 after (17 `it()` cases and 75 `expect()`
calls in the block, unchanged). 1440 lines before; 888 (session-window) and 700
(teardown) after, both under 1000. Full frontend unit suite green (83 files, 1842
tests). The pre-commit anchor gate passes on the staged diff.

**Scaffolding trimmed from the parent** because the block was its only consumer:
the `uploadFileToIpfs` mock entry and `mockUploadFileToIpfs`, the `lib/ipfs-upload.js`
import (`uploadFile`, `describeUploadError`, `UPLOAD_SUBJECT_CHANGED`) and the
`lib/subject-bound-keys.js` import. `fresh-auth.js` imports only `startOrcid`,
`consentOpRequestFields`, `fetchEmailStatus`, `mintSessionAuthProof` from `api.js`,
so the parent's partial factory stays complete. The new file's scaffolding omits
`REAUTH_PROMPT_BUSY`, `broadcastWithFreshAuth`, `slideSessionWindow` and the
`mockBroadcastOps` default, which no case in the block uses; the `signer.js` mock
stays as a module-load stub.

**Header changes, so neither header claims what its file no longer does:**
- Parent: the clause-a sentence justifying the upload-transport mock ("one case
  drives the real `lib/ipfs-upload.js` ...") and the clause-c closing sentence ("The
  one case here that reaches the real upload module ...") left with the cases;
  `uploadFileToIpfs` is out of the real-fetch list; a pointer paragraph names the
  sibling; and "`broadcastOps` is mocked for the same reason as its sibling suite"
  now states the reason inline, since the parent broadcasts and reads the proof each
  call carried while the new sibling's reason (module-load only) does not apply.
- New file: its own clause-a/b/c paragraphs. Clause-a says TWO cases drive the real
  upload module, which is what the block contains. Clause-c states that no real-path
  companion exists for the mid-flight-scrub risk class: no e2e spec changes subject
  while an acquisition is parked; the e2e follow-up filed for the session-window
  suite scopes window-proof broadcast / upload / consent-op legs, not a mid-flight
  scrub; and `auth.test.js` stubs `abandonInFlightAcquisitions`, so the store's real
  composition is not driven either. Clause (c) is therefore undischarged for that
  risk class (no companion and no filed follow-up). Flagged here rather than cited
  to a task that does not cover it.

**For the architect (outside the ui zone):** `ui-light-account-fresh-auth-e2e-coverage`
scope item 4 and AC 6 route the "one case ... reaches the real upload module"
correction to `lib-fresh-auth-session-window.test.js`. After this split that file
makes no such claim, and the two upload-driving cases live in
`lib-fresh-auth-teardown.test.js`, whose header already says two. That task's header
sweep should include the new file (its clause-c paragraph is a fifth header of the
same family).

**Verification:** an independent six-lens review (parity, scaffolding, header truth
per file, conventions incl. the hook-deferred anchor classes, cross-suite citations)
with three adversarial refuters per finding. Two findings survived and are fixed in
the same commit: the new header's "clean cancel at every boundary" overclaimed the
upload-transfer case (the transfer completes; only the idle slide is withheld), and
the parent's sibling-reference reason for the `broadcastOps` mock. Refuted: a
verbatim-moved positional anchor, a verbatim-moved case that swaps subject without a
scrub, a duplicate of the fixed sibling-reference finding, and the e2e-task routing
note above (architect zone). `ce-simplify-code` pass over the scaffolding:
nothing applied. Two findings, both pre-existing patterns carried verbatim from
the parent and still present in the parent's untouched scaffolding, so applying either
to one file alone would break the sibling mirror: `PROOF_KEY` is a hand-typed literal
while `subject-bound-keys.js` exports `SESSION_PROOF_KEY` with the same value (and the
new file already imports three sibling keys from that module), and `vi.clearAllMocks()`
in the top-level `beforeEach` is redundant under `vitest.config.js` `restoreMocks: true`.
Both are optional both-files follow-ups; the second is a no-op either way.
