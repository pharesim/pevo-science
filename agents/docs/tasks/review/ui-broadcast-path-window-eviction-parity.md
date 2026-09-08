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

---

## Architect re-review (2026-09-08) — HELD PENDING FIXES:

Full `/ce-code-review` fan-out on `85dfe378` (correctness, security, adversarial,
reliability, testing, maintainability, julik-frontend-races, project-standards,
learnings), plus an independent validation gate that ran its own behavioural and
mutation probes against a pinned copy of the reviewed head rather than reasoning from
the reports. No cross-model peer was available on this host, so the adversarial lens ran
in-process.

**Both acceptance criteria hold, verified independently of the signal block's table.**
Testing re-derived the eviction condition's mutation space by hand and confirmed the
claims: dropping the producer clear reddens the four new broadcast rows and nothing
else, and dropping the second conjunct is genuinely caught by the pre-existing
cancelled-proactive-re-auth spec, which would lose its seeded live window as a side
effect. The `undefined` equivalent-mutant claim checks out against both real consumers.
The ungated clear was attacked from three directions and survived all of them:
adversarial verified the joiner ordering and the ORCID_FALLBACK containment,
julik-frontend-races and correctness each traced the microtask hop, and reliability
confirmed the eviction reaches the in-memory mirror on every path. project-standards
audited the new prose line by line and returned zero findings; the learnings pass found
no documented convention contradicted. Scope item 3 was answered by fixing, and the
deviation to `FRESH_AUTH_MINT_FAILED` on the two orchestrator surfaces is right: those
surfaces have no fail-closed guard to catch an `undefined`.

One item to land, plus one fold-in while in the same docblock.

1. **(P1, validated by mutation probe; raised by testing, and named independently as a
   gap by correctness and reliability) The authorship retry leg's coercion is
   unpinned.** Both orchestrators wire the same coercing mint callback into two legs:
   the initial resolution and `consentOpFreshAuthRetryGate`'s `mint` hook. The settings
   suite pins both legs; the authorship suite pins only the first, because its new rows
   stage no rejection from `run` and so never enter the gate. The validator measured the
   consequence rather than inferring it: a mutation that coerces only the initial leg
   leaves all 34 authorship specs green, while the identical mutation on the settings
   sibling reddens its retry-leg spec. This is not preemptive hardening. The retry
   ladder has no `FRESH_AUTH_REDIRECT_PENDING` branch, so an uncoerced non-string on
   that leg falls past every sentinel comparison into `run(retry)` and spends a live
   authorship broadcast on a garbage proof, which is a worse failure than the silent
   abandonment the initial-leg rows already cover. Mirror the settings retry-leg spec on
   the authorship surface: stage a `FRESH_AUTH_REQUIRED` rejection from `run`, then a
   first mint that answers with a proof string and a second that answers `null`, and
   assert the surface reports `freshAuthFailed` with `run` called exactly once.

   **Fold-in, same docblock.** `evictUnnamedAcquisition`'s opening sentence names three
   readings that refuse an unnamed value and says only the first ever cleared. The
   upload pre-flight is not a third reading of the acquisition result: `windowProof`
   calls `ensureSessionWindow` and refuses through its outcome, so it already inherited
   that guard's clear and was never a never-clearing reader. Two sites read the raw
   acquisition result, the fail-closed guard and the broadcast unwinder, and the
   unwinder is the one that could not clear. Correct the count and the attribution.

**Dispositions the implementer does not need to act on.**

- **The session mint returning the wire value uncoerced** was found independently by
  adversarial, correctness and maintainability, and the validator confirmed it: a
  response carrying a null proof classifies as the registered redirect outcome, because
  `FRESH_AUTH_REDIRECT_PENDING` IS `null` and the producer eviction deliberately spares
  registered sentinels. It is real, and it is already held as item 1 of the round-3 hold
  on the shared-dispatch task, filed before this diff landed. Do not fix it here. Two of
  the three reviewers proposed coercing that leg to `FRESH_AUTH_MINT_FAILED`; that
  proposal is wrong and the existing hold's `undefined` is right, for the reason the
  next bullet gives.
- **DROPPED at validation: fold the two orchestrator coercions into a shared helper.**
  Maintainability proposed moving the ternary into `mintViaPasswordFactor`'s mint
  wrapper so all three callers inherit it. The validator proved it is not
  behaviour-preserving: the session leg would then resolve the REGISTERED
  `FRESH_AUTH_MINT_FAILED`, which the producer eviction never evicts, so the poisoned
  entry would stay in the slot and the two specs this task added would redden. The three
  surfaces need different coercion targets because only one of them has a fail-closed
  guard behind it. The duplication is load-bearing; keep it.
- **DROPPED at validation: the cross-slot eviction race.** julik-frontend-races raised,
  and adversarial and correctness each noted, that the two acquisition postures write
  one window slot and the new clear is ungated, so a poisoned flight could drop a good
  token a concurrent flight just wrote. The validator ran the interleaving at the PARENT
  commit and it wipes the window there too, through the pre-existing unconditional clear
  in the fail-closed guard. Not introduced by this diff, ceiling one extra re-auth, and
  it needs the backend to hand poison to one flight and a valid proof to another in the
  same tick.
- **DISMISSED: the retained consumer-side clear is now redundant.** It is deliberate,
  documented, and AC 2's "and nothing else" depends on it. **DISMISSED: the
  `evictUnnamedAcquisition` name does not advertise its pass-through.** Preference.
- **Residual 1 is CONFIRMED and promoted to its own task**, not folded in here. The
  architect verified the mechanism the note claims: `consentOpFreshAuthRetryGate`
  rethrows any non-`FRESH_AUTH_REQUIRED` error at its first statement, before it reaches
  `clearProofCache()`, and the accreditation-metadata route validates the proof field as
  a string, so a non-string draws a 400 and the poisoned consent-op entry is never
  dropped. Correctness and reliability both reported that this cache self-heals; that
  reading holds only when the backend answers `FRESH_AUTH_REQUIRED`, and it does not
  here. Residuals 2 and 3 stand as written and stay with their owning tasks.

---

## UI re-review signal (2026-09-09, working tree)

Both held items landed. Three files touched, all under `frontend/`.

**Item 1: the authorship retry leg is pinned.** A spec mirroring the settings twin, staged
exactly as prescribed: a `FRESH_AUTH_REQUIRED` rejection from `run`, a first mint
answering a proof string and a second answering `null`, asserting `freshAuthFailed` with
`run` called exactly once. The mutation the architect's validator measured was reproduced
and now dies: coercing only the initial leg (a `coerce` parameter defaulting true, passed
`false` at the gate's `mint` hook) previously left all 34 authorship specs green and now
fails exactly one, the new row. The same mutation on the settings sibling fails exactly
its retry row, which is the asymmetry closing.

**Fold-in: the count and the attribution.** `evictUnnamedAcquisition` now says TWO sites
read the raw acquisition result, names the fail-closed guard as the one that ever cleared
and `acquisitionAborted` as the one that could not, and states why the upload pre-flight
was never a third such reading. The ruling was verified from the code rather than taken on
trust: `windowProof` and `freshAuthWindowReady` both consume `ensureSessionWindow`'s
OUTCOME, so neither ever sees the raw result.

**Three corrections beyond the two items, surfaced rather than buried.**

1. The same miscount lived one function over, inside `ensureSessionWindow`'s own docblock
   ("all three readings of the slot"). Correcting only the named sentence would have left
   the module asserting both counts about one fact. Fixed.
2. The settings retry-leg spec's comment was affirmatively FALSE, not merely incomplete:
   it claimed an uncoerced non-string on the retry leg is "read as a redirect". The gate
   never compares its mint result against `FRESH_AUTH_REDIRECT_PENDING`. Since the new
   authorship spec is that comment's twin, landing a correct twin beside a false original
   was the worse option. Fixed.
3. A review pass caught two imprecisions in the NEW prose, both written here and both
   fixed before commit: "carries no redirect arm at all" is false as written, because the
   gate's ORCID_FALLBACK arm does `return { redirect: true }` (a null simply never reaches
   it); and "the silent abandonment the initial-resolution rows drive" is true of the null
   row only, since uncoerced `undefined` and `4242` fall into `run()` rather than aborting
   quietly. Both now name the missing comparison and attribute the silence to the value
   that produces it.

**On the apparent two-versus-three contradiction.** `WINDOW_OUTCOME_BY_SENTINEL`'s
docblock counts THREE consuming sites and is untouched, because it is a different and
still-correct tally: it counts who acts on an outcome, and the vocabulary-exhaustiveness
suite pins exactly those three. Four independent review lenses collided on the apparent
contradiction anyway, so the evict docblock now names the distinction in one clause rather
than leaving the next reader to re-derive it.

**Considered and declined, for the architect to overrule.** The new spec does not assert
that the retry mint ran (`toHaveBeenCalledTimes(2)`), so it would also pass if the gate
skipped the inline re-mint entirely. Declined on two grounds: the hold said to MIRROR the
settings spec, which carries no such assertion either, and the initial-leg-only mutation
already proves the row is load-bearing for the coercion specifically. Adding it to one
surface alone would break the mirror.

**Verification.** Full frontend unit suite 84 files / 1860 tests pass; the three
`pages-edit` unhandled errors are the documented pre-existing ones. `npm run build` exit
0. `.githooks/pre-commit` anchor gate exit 0 on the final staged set. A HEAD baseline run
confirmed the per-file delta is exactly `lib-authorship-consent.test.js` 34 -> 35 and
nothing else changed status. Mutation probes ran in isolated scratchpad copies, never the
shared checkout:

| Mutation | Killed by |
|---|---|
| control, unmutated | nothing; 89/89 pass, harness clean |
| authorship coercion removed entirely | the 3 initial-leg rows AND the new retry row |
| authorship coercion on the INITIAL leg only | the new retry row, and nothing else |
| settings coercion on the INITIAL leg only | the settings retry row, and nothing else |

One caveat on the probe harness for whoever repeats it: an isolated copy of `frontend/`
cannot resolve `tests/unit/sec-001-equivalence.test.js`, which imports across into
`backend/src/`. That file fails in any copy-based full-suite run and the failure is a
harness artifact, not a defect.
