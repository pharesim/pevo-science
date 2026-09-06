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
