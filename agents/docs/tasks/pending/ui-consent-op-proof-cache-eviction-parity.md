# Consent-op proof cache has the never-evicted lockout shape, one slot over

**Owner:** ui
**Created:** 2026-09-08

Routed out of the architect review of the broadcast-path window eviction task. The
implementer surfaced it there as a residual and correctly declined to fold it in: that
task's scope was the null-versus-redirect collision, and this is a different defect
class. The architect verified the mechanism against the code before filing.

## Why

The session window slot now evicts an unnamed token at the producer, so every reading of
it inherits the drop. The sibling consent-op proof cache, which serves the settings and
authorship surfaces, still has the shape the session slot just shed.

`getCachedConsentOpProof` drops a FALSY token and returns any truthy one, without ever
type-testing it. The ORCID callback's fresh-auth handler writes the response's
`fresh_auth_proof` into that slot with no type test at all, while explicitly
type-checking the sibling target fields of the same response. So a truthy non-string can
reach the slot and be handed straight to the guarded call.

The recovery that would normally heal it does not always run. `consentOpFreshAuthRetryGate`
does call `clearProofCache()`, but its first statement rethrows any error whose code is
not `FRESH_AUTH_REQUIRED`, and the clear sits after that rethrow. On the routes whose
proof field is validated as a string before the fresh-auth check runs, a non-string draws
a validation rejection rather than a fresh-auth one, so the gate rethrows and the entry is
never dropped. The accreditation-metadata edit is the concrete case: its request schema
declares the proof as a bounded string, so a numeric token fails validation and the caller
sees the rejection while the poisoned entry stays cached for every later attempt on that
target.

Two code reviewers reported that this cache self-heals through the retry gate. That
reading is right only when the backend answers `FRESH_AUTH_REQUIRED`, and the
string-validated routes are exactly where it does not.

## Scope

1. Close the eviction gap for the consent-op slot. Preferred shape: drop a non-string
   token where the reader already drops a falsy one, inside `getCachedConsentOpProof`, so
   both orchestrators' cache legs inherit it in one edit and the entry cannot outlive the
   refusal. Acceptable alternative: type-test at the write instead, in the ORCID
   callback's fresh-auth handler. Weigh them and say why in the commit message. If you
   take the reader-side drop, decide from the code whether the drop needs the teardown
   guard the sibling clears in the broadcast path are gated on, and say why in the
   docblock either way.
2. While in the area, consider whether the write side deserves the type test as well as
   the read side. This is defence in depth, not a second fix for the same hole. Record
   the decision rather than defaulting to both.
3. Out of scope: the session window slot, which the broadcast-path task already closed.
   Do not touch `evictUnnamedAcquisition` or the fail-closed guard.

## Acceptance criteria

1. A spec seeds the consent-op cache with a truthy non-string token and asserts the value
   never reaches the guarded call, on both the settings and the authorship surface.
2. A spec drives the non-remintable path: the guarded call rejects with an error whose
   code is not `FRESH_AUTH_REQUIRED`, and the poisoned entry is gone afterwards rather
   than left for the next attempt. This is the case the retry gate's clear does not
   cover, so it is the one that pins the fix.
3. A spec asserts the attempt after the eviction performs an ordinary mint rather than a
   second refusal of the same entry.
4. Dropping the new drop reddens those specs and nothing else. Carry a numeric and an
   object token rather than a Symbol: a Symbol does not survive the JSON round-trip
   through storage, so a check narrowed to one member would still look covered.
5. Suite green, build clean.

## Notes

Sequencing. `lib/fresh-auth.js` is being edited by two other tasks right now, the
shared-dispatch round-3 hold and the broadcast-path round-1 hold, and both touch the
session-window half of that file. This task's edit sits in the consent-op half. Land it
after those two clear if the diffs collide; the surfaces are otherwise independent.

The session slot's fix chose the producer over the consumer so that all of its readings
inherited one drop. The same reasoning points at the reader here rather than at each
orchestrator's `resolveProof`, because the two orchestrators would otherwise each carry
their own copy of the same type test, which is the duplication the broadcast-path review
already declined to introduce elsewhere.
