# Decide whether a second concurrent session-inconsistency detection should speak

**Owner:** ui
**Created:** 2026-09-02

Routed out of the architect round-3 review of `ui-consent-op-teardown-guard`
(`69686a16`). Not held there: three reviewers raised it independently and the adversarial
pass reproduced it, but the validator established the behaviour as pre-existing and
unaffected by that commit, and the obvious fix carries a behaviour decision the round-3
hold should not absorb.

## Why

`handleSessionInconsistency()` in `lib/fresh-auth.js` disconnects the auth store, claims
the teardown report, and toasts. The disconnect and the claim now sit inside an
`if (auth)` branch, so the claim is only stamped when there was a real teardown to claim,
but nothing gates the sequence against a SECOND caller detecting the same fault. It is
called from five sites across three modules (the broadcast surface's first-attempt and retry mismatch arms,
the consent-op retry gate, and the upload surface's mismatch teardown).

Two concurrent flights that each detect the same corrupted session therefore each run the
whole sequence, and the user sees two identical "Session inconsistency detected. Please
sign in again." messages for one incident. Reproduced by driving two mismatch legs
concurrently: two toasts, where the surrounding work's stated contract is exactly one
message per teardown.

The reachable shape is the publish page, where an inline-image upload and the submit
broadcast can be in flight together against the same divergent JWT-and-proof pair.

## The decision this task exists to make

The `_reportedTeardownGeneration` claim cannot solve this, and reaching for it is the
trap: each call's `disconnect()` re-runs the subject scrub and bumps the generation, so
the second detector legitimately observes a new generation. Under the dedup mechanism's
own semantics, two detectors are two teardowns, not one teardown reported twice.

So the question is not "how do we dedup this" but "should a second, genuinely new teardown
speak at all". Suppressing it also suppresses a real second event; keeping it means the
one-message contract holds per teardown but not per incident.

The proposal to evaluate, not to apply unexamined: gate on the store's own liveness before
disconnecting, so a second caller short-circuits once the first has torn down.

```js
const auth = Alpine.store('auth');
if (auth) {
  if (!auth.isConnected) return;
  auth.disconnect();
  claimTeardownReport();
}
toastLocalized(/* ... */);
```

Note the shape: the liveness short-circuit and the claim both belong INSIDE the `if (auth)`
branch. An earlier draft of this proposal was written against a version of the function
whose claim ran unconditionally; applied literally on top of the current code it would move
`claimTeardownReport()` back outside the branch and re-introduce the stamping-with-no-
teardown defect that branch exists to prevent.

Whichever way it goes, the outcome must be written down where the next reader meets it:
either the function's docblock states that repeat detections are deliberately silent, or
it states that each detection speaks and why that is the right trade.

## Acceptance criteria

1. A decision is recorded in the code, not only in this file: `handleSessionInconsistency`
   carries a docblock sentence stating whether a repeat detection speaks, and why.
2. Two concurrent flights that each detect `username_mismatch` against the same corrupted
   session produce the message count that decision calls for, pinned by a test that fails
   if the behaviour flips.
3. If the early return is adopted, the store fixtures that stub `disconnect` as a bare
   `vi.fn()` (they never flip `isConnected`) are updated so the suites exercise the
   production shape rather than passing because the flag never moves.
4. No surface loses its teardown message entirely: a single detection still reports, and
   the existing "exactly one" assertions across the fresh-auth and upload suites stay green.

## Notes

Related but distinct from the report-collapse mechanism already in `fresh-auth.js`: that
one dedups several flights abandoned by ONE scrub, and works. This is about several scrubs
raised by several detectors of one underlying fault. Do not widen the existing claim to
cover this case without first settling the question above.

UI implementation signal (2026-09-30, commit `790eee0e`):

**Decision: a repeat detection is quiet.** Only the detector that finds the store
still connected disconnects and shows the re-login message. Recorded in the
`handleSessionInconsistency` docblock (AC1).

The proposal's bare `return` was amended. A detector that finds the store already
disconnected calls `reportTeardownOnce()` (the claim-keyed report extracted from
the guard's `cancel`) and then returns. After a sibling detector that is silent,
because the first detector claimed the generation. After a sign-out that showed
nothing (this tab's, or another tab's over the storage event) it shows the
session-changed message once. Reason: with a bare return that second sequence
ends with no message at all, since every caller shape is silent at the page
layer, which AC4 rules out. The liveness check and the claim both stay inside the
`if (auth)` branch.

- AC2: `fresh-auth-401-retry.test.js` "two flights detecting the same corrupted
  session tear down and report once" (one disconnect, one toast). Observed red
  before the change (2 and 2). A second pin covers the upload leg through the
  real window and the real `tornDownSession`
  (`lib-ipfs-upload-real-window.test.js`), and a third covers the mismatch that
  lands after a silent sign-out.
- AC3: the three suites that run the real handler on a mismatch
  (`fresh-auth-401-retry`, `lib-settings-fresh-auth`, `lib-authorship-consent`)
  now carry `isConnected` and a disconnect that flips it. The consent-op suites
  returned a fresh store literal per read; they now return one object. Suites
  that never drive a mismatch into the real handler were left alone.
- AC4: full unit suite green, 87 files, 1980 tests, exit 0. No Playwright run
  (no e2e spec induces `username_mismatch`).

**For architect triage, not fixed here (pre-existing, out of this task's scope):**
none of the five mismatch arms consults its teardown guard before calling
`handleSessionInconsistency`. If a login lands before the mismatch response
(another tab signs in as someone else, or a re-login inside the round trip),
the store reads connected again and the handler disconnects the successor's
healthy session with the re-login message. The liveness gate neither causes nor
cures this, and the docblock says so. Closing it means threading the guard into
the arms, which changes what the primary single-flight mismatch does, so it is a
decision rather than a fix.
