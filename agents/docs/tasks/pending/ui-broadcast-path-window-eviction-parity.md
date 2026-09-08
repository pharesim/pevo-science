# Broadcast-path window eviction parity for a non-string acquisition result

**Owner:** ui
**Created:** 2026-09-08

Routed out of the architect round-3 review of the fresh-auth shared-dispatch task.
Not held there: the gap is pre-existing and outside that diff, but four review lenses
raised it independently and the consumer-audit conventions in
`agents/docs/solutions/conventions/` name this exact function as a historically
missed consumer.

## Why

`ensureSessionWindow`'s fail-closed guard now evicts the window slot when acquisition
resolves a value that is neither a registered sentinel nor a string. The broadcast
path reads the same slot through `acquisitionAborted`, which applies the same string
test but never clears: a truthy non-string token in the slot (a backend contract slip
at the mint, or the ORCID-callback write) is re-read and re-refused on every vote,
comment, or review until the entry's idle deadline (at most 15 minutes), a sign-out,
or an unrelated page-gate or upload pre-flight read happens to run the evicting guard.
The page gate's own rationale ("refusing without clearing leaves whatever the slot
kept to be re-read and re-refused for the rest of that entry's life") applies verbatim
to this consumer, and the guard's docblock describes the two readings as differing on
whether the refusal speaks, which is no longer the whole difference.

## Scope

1. Close the eviction gap for the broadcast reading. Preferred shape: evict at the
   producer, inside `acquireSessionProof`, when the resolved result is neither a string
   nor a registered sentinel, so every consumer of one slot inherits it and the guard's
   own clear becomes a local restatement (or is retired in favour of the producer's).
   Acceptable alternative: mirror the clear in `acquisitionAborted`'s unregistered
   branch. Either way the broadcast path's existing teardown discipline holds: the
   401-retry clear in `broadcastWithFreshAuth` is gated on the teardown guard because a
   network round-trip sits between its read and its clear; decide from the code whether
   the new clear sits before or after such an await, gate it accordingly, and say why
   in the docblock.
2. Amend the guard docblock's closing sentence so the two readings are described
   accurately once parity lands.
3. While in the area, audit the consent-op orchestrators (`lib/settings-fresh-auth.js`,
   `lib/authorship-consent.js`): both compare their own mint result against
   `FRESH_AUTH_REDIRECT_PENDING`, which is `null`. If their mint callbacks also hand
   back the wire value verbatim, a `null` proof on those surfaces collides with the
   redirect sentinel the same way the session-window mint did; fix with the same
   mint-callback coercion the shared-dispatch task's round-3 hold prescribes, or record
   in the commit message why it cannot occur.
4. Out of scope: the messaging asymmetry (the page gate toasts an unregistered refusal,
   the broadcast unwinder stays silent) is intended.

## Acceptance criteria

1. A broadcast-path spec seeds a numeric window, calls `broadcastWithFreshAuth`,
   asserts the slot is empty afterwards, and asserts the next broadcast performs an
   ordinary acquisition (mints) rather than re-refusing.
2. Dropping the new clear reddens that spec and nothing else; the existing
   acquire-before-commit spec pinning that a cancelled proactive re-auth leaves the
   still-live window usable stays green (never evict a live non-offender).
3. Scope item 3 is answered in the commit message either way.
4. Suite green, build clean.

## Notes

A candidate shape the shared-dispatch task declined for itself: put the type check in
`readSessionWindow` next to the falsy-token and non-finite-deadline drops it already
performs, which closes both readers in one edit at the cost of turning the broadcast
path's silent abort into a re-auth. Weigh it against the producer-side clear above;
either is acceptable if the acceptance criteria hold.

Sequence after the shared-dispatch task's round-3 hold lands: that hold edits the same
mint callback and docblock, so landing this first would force it to rebase onto moved
code.
