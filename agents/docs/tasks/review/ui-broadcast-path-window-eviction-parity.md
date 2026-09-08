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

---

## UI signal (2026-09-08, commit 85dfe378)

**Shape taken: the preferred one, producer-side.** `acquireSessionProof` evicts through
one helper on the two legs that can carry an unnamed value out of it, the cache hit and
the settled flight. A joiner performs no clear: the installing flight drops the value
before its `finally` releases the slot, so a joiner and every later cold caller already
find a clean slot. `ensureSessionWindow`'s own clear is KEPT as a local restatement,
which is what holds AC 2's "and nothing else" — with the guard's clear retired, dropping
the producer clear would also redden the pre-existing gate eviction spec.

**Ungated, and the docblock says why.** The sibling clears in `broadcastWithFreshAuth`
are gated because a real round-trip sits between their window read and their clear.
Neither producer leg has that shape: the cache leg reads and clears in adjacent
synchronous statements, and every teardown boundary a flight crosses resolves the
registered cancelled sentinel, including the one between the mint's cache write and its
return — so the check never evaluates true on a torn-down flight. What remains is a
microtask hop, and `_scrubSubjectBoundState` empties the slot before it bumps the
generation while both writers of that slot sit behind a round-trip, so a teardown
landing in the hop can only make the clear a no-op. Checked against the store's own
ordering, not inferred.

**Scope item 2.** Two sentences in the guard docblock needed the amendment, not one. The
named closing sentence now says both readings inherit the one eviction and names what
still differs (whether the refusal speaks). The higher-value correction is the other one:
"Retrying does not clear it; only signing out ... or a fresh tab" is flatly false once
the producer evicts, since retrying is now exactly what clears it. It is gone.

**Scope item 3: answered by fixing, not by explaining.** The collision is live on both
surfaces. `mintSettingsActionProof` / `mintAuthorshipFreshAuthProof` return
`fresh_auth_proof` verbatim, and `FRESH_AUTH_REDIRECT_PENDING` is `null`, the one member
of the vocabulary a JSON response can carry, so a null proof read as `{ redirect: true }`
at both outcome ladders: no toast, no navigation, the action abandoned after a correctly
answered prompt. Both mint callbacks now coerce a non-string. **Deviation from the
prescription, deliberate:** they coerce to `FRESH_AUTH_MINT_FAILED`, not to `undefined`.
`undefined` is right on the session surface because `ensureSessionWindow`'s fail-closed
guard catches it one line later; these two have no such guard, so `undefined` falls
through to `run(undefined)` — the self-custody shape — and reaches the same refusal only
after a second prompt and a second write against a rate-limited route.
`beginPasswordMintReport` already ignores a non-string, so neither coercion can record a
bogus password-factor memo.

**Verification.** Full frontend unit suite 84 files / 1858 tests green (the three
`pages-edit` unhandled errors are the documented pre-existing ones); `npm run build`
clean. Nine mutation probes, in scratchpad copies rather than the shared checkout:

| Mutation | Killed by |
|---|---|
| drop the producer clear | the 4 new broadcast rows, and nothing else |
| drop the cache-leg call | its 2 rows only |
| drop the settled-flight call | its 2 rows only |
| evict registered sentinels too | the pre-existing cancelled-proactive-re-auth spec |
| return a registered sentinel instead of the value | 4 pre-existing gate specs |
| revert the settings coercion | the settings rows only |
| revert the authorship coercion | the authorship rows only |
| return `undefined` instead of the value | **survives** — equivalent mutant |
| narrow the producer check to numbers | **survived the first table**; now killed |

The last two are the ones worth reading. `undefined` is itself unnamed and non-string, so
every consumer branches identically and the mutant is behaviourally equivalent, not a
coverage gap. The numbers-only narrowing DID survive the first draft, which is the
class-versus-member trap the fail-closed-guard convention names: the rows now carry an
object token on both legs, since a number and an object are the members a JSON response
can actually strand in the slot.

**Sequencing.** Landed BEFORE the shared-dispatch round-3 hold, against the note above,
because the task was assigned directly. That hold's items 1, 2 and 5 touch the same mint
callback and the same guard docblock and will need to rebase onto this text. Item 1's
mint-callback coercion is unaffected in substance: a coerced `undefined` from the session
mint is non-string and unnamed, so the new producer clear evicts it exactly as the guard
would.

**Residuals surfaced for triage, deliberately not fixed here.**

1. (medium, out of this task's scope) `getCachedConsentOpProof` drops a falsy token but
   returns any truthy non-string one, and `/orcid/callback`'s fresh-auth handler writes
   `data.fresh_auth_proof` into that slot with no type test while explicitly
   type-checking the sibling target fields of the same response. On the routes whose
   proof field is Zod-validated (`PATCH /accreditation/metadata`, the admin authority
   actions) a non-string draws a 400 rather than a 401, and `consentOpFreshAuthRetryGate`
   rethrows a non-FRESH_AUTH_REQUIRED error before it reaches `clearProofCache()` — so
   that slot has the same never-evicted lockout shape this task closed for the window
   slot, one slot over. Not folded in: this task's item 3 is the null-versus-redirect
   collision, and this is a different defect class.
2. (low, pre-existing) The guard docblock's "A value `JSON` cannot carry dropped itself
   on the write and makes the clear a no-op" is false on `persistWindow`'s failed-write
   mirror path, which keeps the raw entry with the offending value intact. Left alone on
   purpose: the shared-dispatch round-3 hold already prescribes the repair for that
   sentence, and editing it from two tasks would collide.
3. (low) `FRESH_AUTH_ORCID_FALLBACK` is an unregistered Symbol living inside the flight,
   kept from escaping only by the order of two adjacent statements. It now guards
   eviction and not just refusal, so reordering them would evict a live window rather
   than merely refuse one.
