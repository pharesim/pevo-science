# Fresh-auth and upload comments that claim more than the code does

**Owner:** ui
**Created:** 2026-10-01
**Priority:** low

Routed out of the architect archive of the fresh-auth count-tally task (archived
2026-10-01). The implementer's last sweep reported these sentences as outside that
task's population (they count neither clears nor consumers); an architect-side check
against the code confirmed each one below. The last item is the one the second-pass
hold on that task left open for triage.

## Why

Each sentence below states something about what a gate guarantees, who reported a
teardown, why a re-mint would not help, how a deadline is anchored, or what a marker
decides, and the code does not support it read alone. None changes behaviour; each
misleads the next reader about a fresh-auth invariant.

1. **Window-identity claims on generation gates (`lib/ipfs-upload.js`).** The slide
   comment above `attemptOnce` ("The slide belongs to this flight's own window only")
   and `uploadFile`'s "Only this flight's own window is this leg's to drop". Both gates
   are `if (!guard.tornDown())`, and `guard.tornDown()` compares the generation that
   only the subject scrub moves. A sibling flight of the same subject can replace the
   window slot without moving that generation, so the gate does not establish that the
   slot still holds this flight's window. The twin comments in `broadcastWithFreshAuth`
   already say only what the gate guarantees (past a subject teardown, leave the slot
   alone); bring these two to the same scope.

2. **`mintViaPasswordFactor`'s opening sentence.** "Password-factor mint shared by the
   settings + authorship consent-op orchestrators": `acquireSessionProof` calls it too,
   and the same docblock names the session acquisition as a caller further down.
   "`mintFn(password)` — the only part that differs between surfaces": the guard also
   differs (the orchestrators pass their own, the session acquisition takes the
   default). The message does not differ (every caller passes
   `passwordPromptMessage()`), and `assumed` follows the factor resolution, not the
   surface.

3. **`cacheConsentOpProof`'s failed-write sentence.** "the freshly-minted token returned
   by the mint flow can still be passed to the broadcast in-memory". The only caller is
   the `/orcid/callback` fresh-auth handler, which navigates back to the return path
   after the write and passes the token nowhere; password mints never call this
   function. So a failed write loses the ORCID-minted token and the next attempt misses
   the cache. Say that instead.

4. **Teardown-report attributions.** `tearDownSessionWithMessage` runs
   `auth.disconnect()` and then `claimTeardownReport()` before any parked guard
   resumes, so when a teardown narrates itself, `reportTeardownOnce` finds the
   generation already claimed and the guard's cancel shows nothing. These sentences
   credit a guard with the report, or assume every report came from one:
   - the `FRESH_AUTH_CANCELLED` row of the sentinel table ("reported by
     `subjectTeardownGuard`'s cancel before the sentinel is returned");
   - `reportTeardownOnce`'s "the first guard to unwind under it speaks again" (a
     self-narrating next teardown claims the generation itself, and then no guard
     speaks);
   - `claimTeardownReport`'s "any teardown that shows a message of its own" (the
     settings account delete disconnects and shows its own toast without claiming);
   - in `acquireSessionProof`, "has already spoken by the time control returns here";
   - the window-outcome table's `cancelled` row ("already been reported at the abort
     site (`subjectTeardownGuard`)");
   - `handleSessionInconsistency`'s "says nothing when that teardown has already been
     narrated" (the code's condition is that the teardown was claimed, which is not the
     same thing for the unclaimed settings-delete toast);
   - in `lib/ipfs-upload.js`, the `UPLOAD_SESSION_TORN_DOWN` comment's parenthetical
     ("the re-login toast, by whichever flight detected the corrupted session first").
     When the mismatch lands on a store that a sign-out already disconnected,
     `handleSessionInconsistency` skips the disconnect and reports through
     `reportTeardownOnce`, so the message already shown is the session-changed one, or
     none from this call when that teardown was already claimed. (Added at the
     2026-10-05 archive of the repeat-detection task, where two reviewers raised it
     independently.)

   In each, the conclusion the sentence draws (the caller adds no message of its own)
   is the part to keep; correct the attribution so it is true for a self-narrating
   teardown as well. The settings-delete case is the one place where the conclusion
   itself can fail (a flight parked on that page would add the session-changed message
   on top of the delete toast). This task corrects the sentence only. If you find that
   case reachable, raise it rather than changing code here.

5. **The username_mismatch rationale.** `isUsernameMismatch`'s docblock ("no re-mint
   fixes it (every re-acquisition would replay the same mismatched pair)") and the
   mismatch branch in `lib/ipfs-upload.js` ("a corrupted session no re-mint fixes,
   because a re-acquisition under the same divergence produces the same pair"). A
   re-mint binds the proof to whatever subject the JWT names at the mint, and the
   consume compares it against the same JWT subject, so a re-acquisition after the
   cache is cleared yields a matching pair. The upload comment says as much a few lines
   later ("a resubmit would re-acquire and succeed"). Restate the reason for tearing
   the session down instead of re-minting, from the code: check what
   `broadcastWithFreshAuth`'s mismatch arm and the upload comment's own misreport
   paragraph give as the cost, and use that.

6. **Clock anchoring.** `readSessionWindow`'s "Every deadline in the entry is
   client-anchored ... comparing two readings of the same clock" and
   `cacheSessionProof`'s "the server-vs-client offset drops out of the arithmetic
   entirely". `anchoredSpan` returns the measured span (server deadline minus client
   now) unchanged whenever it lies between half the period and the full period, and
   `cacheSessionProof` stores `now + span`. Inside that band the stored deadline is
   the server's timestamp read on the client clock, so the clock offset is carried in
   full, both in the stored deadlines and in the learned `idlePeriodMs`. The offset
   cancels only when the span is clamped to the period. The behaviour is the accepted
   trade-off `anchoredSpan`'s docblock describes; only the two sentences overclaim.

7. **The ORCID mode-marker comment** at the `ORCID_MODE_KEY` write in
   `beginOrcidFreshAuthRedirect` ("so the callback dispatches to the matching handler",
   "route the callback to the wrong handler"). `pages/orcid-callback.js` dispatches on
   `data.mode`, the mode the backend stored. The marker feeds the back path, the error
   copy, and `completeOrcid`'s choice between an authenticated and an unauthenticated
   request. A wrong or missing marker can therefore post an authenticated-mode callback
   unauthenticated (the dead end the `beginOrcidFreshAuthRedirect` docblock describes)
   or show the wrong back link and copy; it cannot choose the handler.

8. **"Every teardown boundary resolves FRESH_AUTH_CANCELLED".** In
   `evictUnnamedAcquisition`'s docblock ("every teardown boundary a flight crosses
   resolves FRESH_AUTH_CANCELLED"), its restatement in the `ensureSessionWindow` guard
   comment ("every flight that crosses a teardown boundary resolves
   FRESH_AUTH_CANCELLED"), and the retry gate's "the same clean cancel every other
   teardown boundary resolves to". A stale ORCID start that rejects propagates the
   rejection instead, as `beginOrcidFreshAuthRedirect`'s docblock says. The first two
   use the universal as a premise for an ungated clear being safe. Check from the code
   whether the argument also holds for a rejecting start, and state the premise in a
   form that is true for both; scope the third sentence to the outcomes it actually
   compares.

## Scope

Comment-only, in `frontend/src/lib/fresh-auth.js` and `frontend/src/lib/ipfs-upload.js`.
No executable line changes, no test changes.

1. Repair each sentence by dropping the overclaim or moving its scope into the clause
   that makes the claim. Do not repair a universal by naming more exceptions.
2. Re-derive each replacement from the code, not from this file's wording. The
   descriptions above are a reviewer's reading; check each before reusing any of it.
3. Sweep both files for any other sentence making the same kind of claim (window
   identity from a generation gate, a guard credited with a teardown report, the
   same-pair re-mint rationale, client-anchored deadlines, the marker choosing the
   handler, the teardown-boundary universal), matched semantically, not by phrase.

## Acceptance criteria

1. Every sentence named above, and any the sweep finds, is true against the code read
   alone.
2. The comment-stripped files are byte-identical before and after.
3. The replacement text carries no line numbers, SHAs, task slugs, round ordinals, or
   bare positional anchors; `.githooks/pre-commit` passes on the staged diff.
4. Full frontend unit suite green with an unchanged count; `npm run build` clean.

## Notes

Dismissed at the same triage, do not reopen:

- `handleSessionInconsistency`'s "A repeat detection does not disconnect again": accurate
  (the `isConnected` gate), and the docblock already states the new-session caveat.
- "Taking those would strand it" in `beginOrcidFreshAuthRedirect`'s docblock: holds for
  the authenticated-mode flows it describes (the backend answers an unauthenticated
  callback for those with 401). For a later login or signup flow, losing the marker
  only costs the back path and the copy, which is not worth a correction.

Not part of this task: the behaviour reports from the same sweep. The upload leg's
mismatch teardown after a cross-tab sign-in is filed separately
(`ui-upload-mismatch-teardown-after-subject-change`); the expired-JWT mint answer is an
open architect decision; the same-subject window race and the failed consent-op cache
write were dismissed.
