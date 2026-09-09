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

---

## UI implementation signal (2026-09-09, commit 8ff106b2)

**Both placements landed, with the roles inverted from this task's ranking.** Scope
item 1 offered the reader-side drop as preferred and the write-side type test as the
acceptable alternative; scope item 2 asked whether the write side deserves the test as
well, and for the decision to be recorded rather than defaulted to both. The decision is
both, because tracing the reader-side-only shape shows it is a REGRESSION on every
ORCID-only path rather than a partial fix:

- Today a poisoned entry reaches the backend on the coercing routes (`/settings/*`,
  `/custody/broadcast`), which coerce a non-string to `undefined` and answer
  FRESH_AUTH_REQUIRED with reason `missing`. That reason is remintable, so
  `consentOpFreshAuthRetryGate` clears the slot and the user is told re-authentication
  failed. Visible, terminal.
- With a drop at the reader alone, the read is a miss, and a miss is an instruction to
  acquire. For `set_password` (ORCID-only by construction, via `passwordFactorFor`) and
  for any passwordless account, acquiring is a full-page round-trip; the orchestrator
  answers `{ redirect: true }`, which the window-outcome dispatch keeps silent by design
  and every caller aborts on without a word. Click, ORCID, return, click. That is the
  indefinite re-OAuth loop with no error surface that the sibling target-triple guard in
  `_handleFreshAuth` states it exists to prevent, reproduced three statements below it.

So the type test at the WRITE is the refusal (the only placement with a surface the user
can act on), folded into that existing triple guard. The non-string drop at the READ is
the eviction, and it earns its place beside the write test rather than duplicating it: it
covers an entry a previous bundle wrote that is still inside the proof TTL, on precisely
the routes where the retry gate's clear never runs. That class is wider than the
accreditation-metadata edit this task named. Verified against the backend: the same
`z.string().min(1).max(512).optional()` bound is factored as `adminFreshAuthProof` across
seven admin schemas, and every one of those routes places `validate(...)` ahead of
`requireFreshAdminAuth`, so six live admin authority actions share the shape.

**Two decisions recorded in the docblocks, as scope item 1 asked.**

1. No teardown guard. The read, the type test and the removal are adjacent synchronous
   statements inside `getCachedConsentOpProof`; no await separates them, so the
   successor-pays-a-re-auth harm that gates the sibling clears in
   `broadcastWithFreshAuth` has no shape to take. This is strictly stronger than the
   argument `evictUnnamedAcquisition` had to make, which still had a microtask hop to
   reason away.
2. The drop joins the corruption branch BEFORE the target comparison. A token of the
   wrong type is unusable at every target, so a drop that waited for a match would leave
   it cached for the one target it does match; the comparison itself still returns null
   WITHOUT removing, so a proof minted for another target survives an unrelated lookup.
   Both directions carry a spec.

**Acceptance criteria.** The value never reaching the guarded call is pinned on both
surfaces, in a new `frontend/tests/unit/lib-fresh-auth-consent-op-eviction.test.js`.
Neither orchestrator suite could host these: both replace `getCachedConsentOpProof` and
`clearCachedConsentOpProof` with `vi.fn` through a partial mock, `vi.mock` is hoisted and
file-scoped, so a case added there would pass whatever the reader does. The new file
mocks only `api.js`, `signer.js` and `alpinejs` and leaves fresh-auth.js entirely real.

The non-remintable path stages `BAD_REQUEST`, not `VALIDATION_ERROR`: `validate` in
`backend/src/validation.ts` emits `sendError(res, 400, 'BAD_REQUEST', issues)` with no
`details`, and that is the code that reaches the gate's first statement. A companion case
drives a FRESH_AUTH_REQUIRED `missing` rejection through the remintable ladder, so the
drop is shown not to have swallowed it. Numeric and object tokens, never a Symbol.

Mutation probes ran in three isolated scratchpad copies of `frontend/` with `node_modules`
symlinked. Reverting the reader drop reddens 14 specs, every one of them new; reverting
the write guard reddens the three new callback rows; the control's only failure is the
`sec-001-equivalence.test.js` collection error every scratchpad copy shows, present
identically in all three arms. Full unit suite 1890 tests green (the intermittent
absolute-cap slide case in `lib-fresh-auth-session-window.test.js` is the documented 1ms
clock-boundary flake, reproduced on this tree and unrelated). Build clean.

**Residual surfaced for triage, deliberately not fixed here.** The cache assertion in
`tests/e2e/settings-orcid-factor.spec.js` (the stubbed-callback case) compares the stored
entry against a five-key object with `toEqual`, while `cacheConsentOpProof` has written
seven keys since the credit-op extension added `authorIndex: null, claimer: null`.
`toEqual` treats a missing key as equal to `undefined` but not to `null`, so the
assertion cannot pass. Pre-existing and independent of this change, but it will surface
during any e2e run of that file and should not be read as fallout from it.
