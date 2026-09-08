# The broadcast path's unnamed refusal should speak

**Owner:** ui
**Created:** 2026-09-08

Routed out of the architect review of the broadcast-path window eviction task, and
decided by the user against the previous settlement. Read the reversal note below before
treating the old decision as still standing.

## This reverses a settled decision, deliberately

The messaging asymmetry between the two readings of an acquisition result was declared
intended twice: once as an explicit out-of-scope item on the broadcast-path eviction task,
and once as a finding dropped at validation on the shared-dispatch task, whose hold said
in as many words not to fix it. Both of those judgements were made while a poisoned entry
was a one-time event: the entry stayed in the slot, every later action read it from cache
and refused without prompting, so the silence cost the user one lost action and nothing
more.

The eviction changed that premise. The architect's validation gate measured it rather than
reasoning about it: against a repeatably-poisoned mint, the parent commit costs zero
password prompts across three consecutive broadcasts, and the reviewed head costs zero
then one then two, with zero toasts and zero broadcasts throughout. Evicting per action
means re-minting per action, and re-minting means prompting per action.

The session-mint coercion landing on the shared-dispatch task sharpens this rather than
relieving it. That fix hands back `undefined` for a non-string, and `undefined` is itself
unnamed, so the mint leg now resolves into exactly the class the broadcast path refuses in
silence. The end state without this task is a user who answers a password prompt for every
vote, comment and review, correctly, and is told nothing each time, while the page gate and
the upload pre-flight both report the same condition.

## Why

`acquisitionAborted` classifies the result through the shared vocabulary and toasts
whatever that classification carries. An unnamed result classifies as `null`, which
indexes no row in the toast table, so the abort is silent. `ensureSessionWindow` already
treats the same class as the `failed` outcome, which does carry a message. The two
readings agree on refusing and disagree only on speaking, and the condition they disagree
about is the one the user can actually act on: re-authentication did not complete.

## Scope

1. Give the unnamed class the outcome the page gate already assigns it, at the broadcast
   unwinder. The shape is a fall-through on the classification, so every registered member
   keeps the message or the deliberate silence it has today and only the unnamed class
   changes.
2. Verify no call site double-reports. The broadcast call sites share one clean-abort
   branch on the sentinel return; confirm none of them also toasts on that return, or the
   user gets the message twice for one action.
3. The upload pre-flight is not in scope and should not change: it refuses through
   `ensureSessionWindow` and maps the outcome onto its own coded vocabulary, which already
   reports this class.
4. Update the sentence in the fail-closed guard's docblock that says the two readings
   still differ on whether the refusal speaks. Once this lands they do not differ, and the
   remaining difference is which vocabulary each one reports through.

## Acceptance criteria

1. A broadcast-path spec drives an unnamed acquisition result through
   `broadcastWithFreshAuth` and asserts the re-auth-failure message is shown exactly once,
   and that the broadcast still does not go out.
2. Every registered vocabulary member keeps its current message or its current silence.
   Drive this from the vocabulary rather than from a hand-listed set, so a member added
   later cannot slip past the assertion.
3. Dropping the fall-through reddens the new spec and nothing else.
4. Suite green, build clean.

## Notes

Sequencing. Two other tasks are editing the same docblock and the same region of
`lib/fresh-auth.js`: the shared-dispatch round-3 hold and the broadcast-path round-1 hold,
whose fold-in corrects the reading count in the neighbouring sentence. Land this after
both clear, or expect to rebase the docblock edit onto their text.

The one-line shape adversarial proposed is a fall-through on the classification rather
than a new branch, which is what keeps criterion 2 cheap: nothing about the registered
members is restated, so nothing about them can drift.

## Implementation notes

Landed as a fall-through, one line: `showWindowOutcomeToast(acquisitionOutcomeKey(proof) ?? 'failed')`.

The `redirect` member is the one that made the shape worth checking rather than assuming.
Its sentinel IS `null`, the same operand class `??` falls through on, so a reader has to
ask which wins. The classification does: `WINDOW_OUTCOME_BY_SENTINEL` is a Map and a Map
takes `null` as a key, so `acquisitionOutcomeKey(null)` returns the string `'redirect'`
and the fall-through never fires for it. The `redirect` row of the new vocabulary loop is
the regression guard for exactly that collision.

Scope item 2, verified by reading every one rather than by sampling. There are 9
invocations of `broadcastWithFreshAuth` and 9 clean-abort branches across 6 files, all
of them either a bare `return` or `this.step = 'idle'; return;`. None shows a message.
No surrounding `catch` can add one either: the sentinel is a return value and never a
throw, and each branch returns before anything later could throw. The three `finally`
blocks reset flags only. The other double-report shape was checked too: `publish.js` and
both `edit.js` legs run `freshAuthWindowReady({ allowRedirect: false })` immediately
before their broadcast, and that gate already toasts `failed` for this class, but on
failure it returns false and the page aborts to idle without reaching the broadcast, so
gate and unwinder are mutually exclusive within one action. Inside the wrapper the two
`acquisitionAborted` call sites are mutually exclusive per action as well: the retry
leg's is only reachable when the first handed back a real proof string.

Scope item 3 holds: `lib/ipfs-upload.js` is untouched.

Scope item 4 landed on the guard's closing sentence. Two comments in
`lib-fresh-auth-session-window.test.js`'s poisoned-window block were the residual the
scope item does not name: both said the broadcast path aborts in silence on an unnamed
entry, which the fall-through makes false. Corrected in the same commit.

Acceptance criteria:

1. Three specs, in `fresh-auth-401-retry.test.js`. Two drive the class through the
   initial acquisition (the window-slot leg and the mint leg), one through the 401
   retry's re-acquisition. Each asserts `toHaveBeenCalledTimes(1)` on the toast, the
   localized `settings.reauthFailed` sentinel rather than the English fallback, and
   `broadcastOps` not called (the retry spec asserts one call, the first attempt).
2. `BROADCAST_ROUTE_BY_OUTCOME` is keyed by vocabulary member and its key set is
   asserted equal to `WINDOW_OUTCOME_KEYS` both ways, so a member added later fails for
   want of a route instead of going unasserted. Each row drives its member out of a real
   acquisition and compares the toast calls the unwinder made against the calls
   `showWindowOutcomeToast(key)` makes, so no message and no deliberate silence is
   restated in the test. Each row also runs an `evidence` assertion, because the
   comparison alone cannot tell `redirect` from `cancelled` (both silent) or `failed`
   from an unnamed result (identical message post-change); the evidence pins a second
   observable those pairs do not share.
3. Mutation probe, in two isolated scratchpad copies of `frontend/` with `node_modules`
   symlinked. Dropping `?? 'failed'` fails exactly the three specs above; the unmutated
   control in the same copy has zero test failures. (`sec-001-equivalence.test.js` fails
   to collect in any scratchpad copy, mutated or not, and is present in both arms.)
4. 84 files / 1869 tests pass, up 9 from 1860 at the parent commit. The three unhandled
   `pages-edit` errors are the documented pre-existing ones. Build clean.

Two things left deliberately alone, for the architect rather than as findings.

The vocabulary loop is a RELATIVE assertion: it pins that the unwinder agrees with the
dispatch, never what the dispatch says. A regression silencing both would pass it. That
hole is already covered twice, by the absolute-copy specs in this same file and by
`lib-fresh-auth-outcome-dispatch.test.js`, so the existing hand-written per-outcome
broadcast specs are kept on purpose and should not be trimmed as redundant.

Two concurrent broadcasts on one unnamed result toast twice: a joiner returns the
in-flight promise directly, so it skips `evictUnnamedAcquisition` but still reaches
`acquisitionAborted`. That is pre-existing behaviour for every speaking member, not
something the fall-through introduces, and it is two actions rather than one.
