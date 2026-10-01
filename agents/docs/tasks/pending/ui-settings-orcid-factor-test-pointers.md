# settings-orcid-factor.spec.js points at its own tests by position, and one pointer names a test.fixme that does not exist

**Owner:** ui
**Created:** 2026-10-01

Routed out of the architect re-review of `ui-e2e-retry-model-comment-sweep` (archived
2026-10-01), where the implementer listed the false pointer for triage. Comment-only
work: no assertion, fixture, mock, or test-order change.

## Why

All sites are in `frontend/tests/e2e/settings-orcid-factor.spec.js`.

**One pointer is false.** In the test 'the fresh_auth callback caches the proof under
(set_password, username, "") and the re-submit sends it', the comment above
`let capturedSetPassword` says the real backend verification "is the test.fixme below".
The file has no `test.fixme`. The real verification is the plain test 'ORCID-factor
set_password succeeds end-to-end with a real backend-minted proof'.

**The other pointers locate a test by position or count.** They are true today. They go
stale when a test is added, removed, or reordered. Root `CLAUDE.md` "Comment anchors"
names purely positional forms as a rot class, and hold item 4 of the routing task fixed the
same class ("the two tests below") in `login-email.spec.js`. The sites:

- The file docblock: "the first two tests" (twice), "the third test in this file", "the
  third test below", and "in all three".
- The comment above the real-backend round-trip test: "The two tests above".
- Inside that test, the comment above the consent-op cache read: "the stubbed token of the
  tests above".
- The comment above the mismatch describe: "The happy-path test above". Read against the
  code, it means the real-backend round-trip test. That is the only happy-path test that
  reaches the real `/api/orcid/callback`, and so the orcid-stub sidecar's reflection of the
  submitted `code`. The first two tests stub the callback. Confirm this before you name it.

## Scope

1. Replace the false `test.fixme` pointer with the name of the test that does the real
   verification.
2. Rewrite every other site listed so it names what it points at, or says what it needs
   without pointing. It can use the test title, a short form of the title that is
   unambiguous in this file, or the describe name. The invariant, not a fixed sentence: no
   comment in this file locates a test by position ("above", "below", "third") or by count
   ("the first two", "all three").
3. Sweep for the claim, not for the list. After the edits, run
   `grep -n -E "\b(above|below)\b|first two|third|all three|two tests|test\.fixme" frontend/tests/e2e/settings-orcid-factor.spec.js`
   and read each hit. "the fixed mismatch iD B below" in the mismatch describe's hook can
   stay: it names its target, which is the durable form under the stable-named-container
   carve-out in "Comment anchors". List in the signal block any further site you fix.

## Out of scope

- Any change to a test, assertion, fixture, mock, or the order of tests.
- Other spec files.

## Acceptance criteria

1. No comment in the file names a `test.fixme`, because the file has none.
2. No comment in the file locates a test by position or by count.
3. Every rewritten pointer names the test or describe it meant, and is true of it.
4. The diff is comment-only: no executable line changes.
5. New comment text follows root `CLAUDE.md` "Comment anchors": no task slug, round or hold
   ordinal, line number, commit SHA, or bare positional reference. The pre-commit anchor
   gate passes.

## Notes

The e2e suite does not need to run for a comment-only diff. State in the signal block that
it was not run.
