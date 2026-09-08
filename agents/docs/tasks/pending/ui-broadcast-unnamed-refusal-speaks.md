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
