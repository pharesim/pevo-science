# Close the cross-user teardown gap on re-login

**Owner:** ui
**Created:** 2026-08-31

Routed out of the architect review of `199c1e13` (light-account re-auth window).
Not held on that task: the gap is pre-existing and spans the login surfaces,
which are outside that task's scope. It is the reason the mismatch item held
there is reachable at all.

## Why

`auth.disconnect()` scrubs the JWT, the stored session, both fresh-auth proof
caches, the password-factor memo and the ORCID return-path pointer. Its comment
states the intent plainly: so that cross-user re-login on a shared browser
cannot pick up a stale fresh-auth proof.

The ordinary re-login path never runs it. `login.js` and `sign-in-modal.js`
call `loginFromResponse` for a new username directly, so a second user signing
in on the same tab inherits the first user's cached session window. The server
catches it (the consume compares the entry's username to the JWT subject and
refuses), but only after the client has spent an action on a credential that was
never going to work, and the client-side recovery from that refusal is exactly
what the re-auth window task had to add a teardown branch for.

Separately, `disconnect()` does not clear the module-level in-flight acquisition
promise in `lib/fresh-auth.js`. An acquisition still pending when the user
disconnects resolves afterwards and can hand its result to whoever joins next.
Reachability is thin today, since a password mint is pending on a modal the user
must interact with, but it sits in the same teardown block and has the same
shape as the caches that are cleared.

## Scope

1. Make the cross-user scrub run on every path that changes the JWT subject, not
   only on explicit logout. Prefer routing the login paths through the existing
   teardown over duplicating the scrub list at each call site, so a future cache
   added to `disconnect()` is not silently missed by the login surfaces.
2. Clear the in-flight acquisition promise as part of the same teardown.
3. Decide and document what "same subject re-login" should do. Re-authenticating
   as the account already signed in need not discard a live window, and treating
   it as a subject change would cost a re-auth the user does not owe.

## Acceptance criteria

1. Signing in as a different username in the same tab leaves no cached session
   proof, consent-op proof, password-factor memo, or return-path pointer from
   the previous subject.
2. A test drives the real login path (not `disconnect()` directly) and asserts
   the caches are empty afterwards.
3. An acquisition in flight when the session is torn down cannot deliver its
   result to a caller that arrives after the teardown.
4. The same-subject case behaves as decided in scope item 3, with a test either
   way.

## Notes

The reachability chain was established during the review of `199c1e13`: an
independent validator traced it to confirm that a `username_mismatch` refusal at
the IPFS upload leg is a live path rather than a theoretical one. The held task
adds the client-side teardown branch that handles the refusal; this task removes
the cause.

**Architect addendum (2026-08-31, from the hasPassword-divergence round-3
review):** the factor-resolution rework added a SECOND module-level in-flight
slot with the same shape, `_factorResolutionInFlight` in `lib/fresh-auth.js`.
It is joined with no identity comparison, and `clearPasswordFactorMemo()`
(which `disconnect()` calls) bumps the memo generation without nulling the
slot, so a status fetch pending across a same-tab disconnect and re-login hands
the previous account's `{ usesPassword, assumed }` answer to the new account's
first resolution (one-shot; the memo write is generation-guarded, and the next
resolution self-corrects). Four reviewers converged on it independently. Scope
item 2 and acceptance criterion 3 apply to BOTH slots: identity-key the join
(a caller only shares a flight whose captured username matches the current auth
subject), null the slot in the teardown, and guard each flight's `finally` to
clear only a slot it still owns. Add the cross-identity coalescing test neither
suite has (a clear landing mid-flight plus a second caller must trigger a fresh
fetch, not join the stale flight).

---

## UI completion signal (2026-08-31, commits 1b9f2137 + 9ecff448 + 4c3e7c7a)

Implemented in an isolated worktree from `c410a279`, adversarially reviewed by
three lenses (correctness/races, security/account-state against ARCHITECTURE
§ 6.1/6.4/6.5, test-quality with mutation probes) plus a re-verification pass,
then cherry-picked onto main. The addendum landed after the base implementation
and its remaining item was closed in `4c3e7c7a`.

**Design.** One funnel method on the auth store, `_adoptSubject(username)`,
called from `loginFromResponse` (before any field lands; subject falls back to
`this.username` when the response omits it, so the settings custody-upgrade
sites are same-subject by construction) and from `_restoreSession` (covering
init, cold load, and the cross-tab storage event). Detection is backed by a
per-tab sessionStorage marker `pevo_tab_subject` recording which subject the
tab's sessionStorage state belongs to, with an in-memory fallback to
`this.username`. The scrub list is not duplicated: `disconnect()`'s block moved
into `_scrubSubjectBoundState()`, called by both `disconnect()` and
`_adoptSubject()`.

**Scope 2 / AC 3, both slots.** `lib/fresh-auth.js` exports one teardown,
`abandonInFlightAcquisitions()`: nulls both `_acquireInFlight` slots and
`_factorResolutionInFlight` and bumps `_acquireGeneration`. Flights capture the
generation before any await and re-check it after factor resolution, before
spending a mint, after the mint round-trip (before `cacheSessionProof`, so a
late issuance cannot repopulate the scrubbed cache), and after
`mintViaPasswordFactor` (so the assumed-password ORCID fallback cannot navigate
post-teardown); stale flights resolve as a clean cancel. Both finally blocks
are ownership-guarded. Per the addendum, the factor-resolution join is
identity-keyed on the captured subject, with the cross-identity coalescing test
(subject swap mid-flight without the scrub; the second caller spends its own
fetch).

**Scope 3 decision.** Same-subject re-login preserves the live window, caches,
memo and marker; it is not a subject change and costs no re-auth. Documented at
`_adoptSubject`, pinned by tests including the username-less custody-upgrade
shape.

**Verification.** All new tests observed red at base before implementation
(18 red across 4 files). Every teardown guard in the acquisition path has a
killing test (verified by per-guard mutation probes, each killed by exactly its
intended test). ACs 1, 2, 4 driven through the REAL store paths (`initAuth` +
`loginFromResponse` / `_restoreSession` / `_handleStorageEvent`) and the real
page surfaces (`pages-login`, `components-sign-in-modal`). Full frontend unit
suite on the integrated tree: 79 files, 1733 tests green (the 3 vitest errors
are the documented pre-existing `pages-edit` `_mountEditors` rejections).
Playwright not run: no visual surface changed and the login flows are covered
at the unit layer against the real store; flagging the omission explicitly.

**Residuals surfaced for triage, deliberately not fixed here:**

1. (low) `orcid-callback.js` `_handleSessionAuth`/`_handleFreshAuth` cache a
   proof echoed for the previous subject with no subject/generation guard, so a
   teardown landing during the one `completeOrcid` round-trip can be followed
   by a stale cache write. Sub-second cross-tab race; the wide while-at-ORCID
   window is fail-closed (the scrub removes `pevo_orcid_mode`, so callback init
   dead-ends first), and the server's `username_mismatch` refusal plus the
   existing teardown branch self-heal it. Reviewers judged it dismissible under
   the theoretical-only norm; recorded so the decision is conscious.
2. (low) `_adoptSubject`'s in-memory fallback (`marker ?? this.username`) is
   exercised only when `sessionStorage.getItem` itself throws, an environment
   the suite does not simulate; the fallback is unpinned by tests. Near-
   theoretical per repo norms.

---

## Architect re-review (2026-09-01) — HELD PENDING FIXES:

Reviewed via `/ce-code-review` on `1b9f2137` + `9ecff448` + `4c3e7c7a` (frontend
paths only), eight reviewer personas plus an independent validation batch. **The
core work is verified sound and complete.** Independently confirmed rather than
taken from the signal: every subject-change path (login page, sign-in modal,
Keychain connect, ORCID-login callback, custody upgrade, cold restore, cross-tab
storage event) funnels through `_adoptSubject`; all four generation checks and both
ownership-guarded finally blocks each have a distinct killing test; the
identity-keyed factor-resolution join holds under every constructed interleaving;
ARCHITECTURE § 6.5 invariant #9 holds (`cacheSessionProof` call sites unchanged);
project-standards clean. All four acceptance criteria are met by tests driving the
real store paths.

Two items, both on the task's own surfaces.

### Item 1 — the ORCID redirect after `startOrcid` is the one acquisition await with no generation re-check

`acquireSessionProof` re-checks the teardown generation at every step boundary and
resolves stale flights as a clean cancel, except the passwordless branch: it calls
`beginSessionAuthOrcidRedirect` -> `beginOrcidFreshAuthRedirect`, and that helper
awaits `startOrcid` (a network round-trip) and then assigns `window.location.href`
with no re-check. Both passwordless outcomes reach it after their last generation
check. A teardown landing during that round-trip (the cross-tab storage-event login
this task adds a first-class path for) still full-page navigates the new subject's
tab to ORCID on the previous subject's behalf; the scrub has already removed
`pevo_orcid_mode`, so the return dead-ends in the callback's generic error branch.
Confirmed independently by three reviewers (adversarial constructed it mechanically,
security and correctness traced it), and it is the literal completion of this task's
own "re-check at every step boundary" invariant, which the review found uncovered at
exactly one boundary.

Thread a staleness predicate into `beginOrcidFreshAuthRedirect` (an optional
callback), supplied by `acquireSessionProof` as
`() => generation !== _acquireGeneration`. After `startOrcid` resolves and before the
navigation, if stale: clear the `pevo_orcid_mode` and return-path keys it wrote
(mirroring the existing error-unwind blocks) and return `FRESH_AUTH_CANCELLED`.
Page-level callers pass no predicate and keep today's behavior. Add the mirror test:
`startOrcid` pending -> teardown -> resolve -> assert `window.location.href`
unchanged and no navigation fired.

### Item 2 — the test fixture mirror hardcodes the scrub key list with no parity pin

`fixtures/mock-auth.js`'s `mockLoginFromResponse` reimplements the subject-adoption
scrub as a literal six-key array. Three of those keys (the session-proof,
consent-op-proof, and return-path keys) are module-private consts in `fresh-auth.js`
that are never exported, so the fixture cannot import the source of truth and must
copy the strings by hand. `components-sign-in-modal.test.js` and
`pages-login.test.js` assert cross-user-scrub behavior against this mirror, not the
real store, and no test binds the mirror's output to the real store's for identical
input. A future subject-bound cache added to the real `_scrubSubjectBoundState`
(whose own docblock instructs adding future caches THERE) silently desyncs, and those
two suites keep passing while no longer proving what they claim. Five reviewers
converged on it.

Either export the subject-bound key set from `auth.js` / `fresh-auth.js` (retiring the
can't-import-the-truth problem for the three private consts) and have the fixture
import and loop it, or add one parity test that seeds identical state, runs the real
`loginFromResponse` and `mockLoginFromResponse`, and asserts the resulting
sessionStorage contents match.

### Not held, routed elsewhere

The consent-op orchestrators (`settings-fresh-auth.js`, `authorship-consent.js`) act
on the same shared `resolvePasswordFactor` / `mintViaPasswordFactor` primitives with
no teardown guard, and the scrub does not close an open reauth modal, so a password
typed into a prompt left open across a cross-tab subject swap mints under the new
subject's JWT and runs the previous subject's action against the new subject's
account (validated end-to-end including the backend proof-to-subject binding). Filed
as `ui-consent-op-teardown-guard` because the fix spans files outside this task's
scope; the session-path reauth-modal silent-cancel gap (the same missing modal close)
is folded into it, as are the `username_mismatch` escapes on the broadcast and upload
retry legs (the same "teardown does not reach this path" family).

The custody-upgrade re-login race (the omitted-username `loginFromResponse` fallback
landing under a subject changed by a concurrent cross-tab login during the up-to-20s
upgrade window) is filed as `ui-custody-upgrade-subject-pin`; the "same-subject by
construction" comment this task added overclaims for that call site.

The disclosed orcid-callback stale-proof-write residual and the `_adoptSubject`
in-memory-fallback coverage gap are accepted as documented residuals (fail-closed and
near-theoretical respectively).

**When the fixes land, `git mv` this file back to `tasks/review/`.** The move is the
re-review signal. Do not edit this hold block or annotate items as fixed; the commit
diff is the evidence and the architect updates the block at re-review.

---

## UI re-review signal (2026-09-01, commit 659131b8)

Both hold items landed, red-first where a base red exists, adversarially
reviewed by a three-lens fan-out (correctness/races, security/account-state
against ARCHITECTURE § 6, test-quality) with three refute votes per raised
finding: zero findings survived. Full frontend unit suite on the integrated
tree: 80 files, 1780 tests green (the 3 vitest errors are the documented
pre-existing `pages-edit` `_mountEditors` rejections). Playwright not run: no
visual surface changed; same omission posture as the base implementation.

**Fix for the redirect boundary.** `acquireSessionProof` supplies its flight's
generation predicate to `beginSessionAuthOrcidRedirect`, which threads it into
`beginOrcidFreshAuthRedirect` as an optional `isStale` callback. After
`startOrcid` resolves and before any navigation, a stale flight clears the
mode and return-path keys (mirroring the error unwinds) and resolves as
`FRESH_AUTH_CANCELLED` — the same silent clean cancel as the sibling
generation checks. Both passwordless outcomes (known-passwordless and the
assumed-password fallback) share the one guarded closure. Page-level and
consent-op redirect starters pass no predicate; their behavior is unchanged.
The prescribed mirror test (startOrcid pending → teardown → resolve → no
navigation, keys cleared) was observed red at base for the right reason.

**Fix for the fixture mirror.** Went with the export option, plus the parity
test as a semantic pin on top. The export lives in a NEW dependency-free
module `frontend/src/lib/subject-bound-keys.js` rather than as exports from
`auth.js`/`fresh-auth.js` directly: the fixture's consuming suites partially
mock `api.js`/`alpinejs`, so importing the truth through those modules'
import graphs would have dragged the partial mocks' missing exports into six
suites. `fresh-auth.js` now imports its formerly-private key consts from the
module (retiring the can't-import-the-truth problem), `_scrubSubjectBoundState`
loops the module's `SUBJECT_BOUND_STORAGE_KEYS` for its storage removals, and
the fixture loops the same list. The parity test runs the real
`loginFromResponse` and `mockLoginFromResponse` from identically seeded
storage and asserts identical results for the cross-user scrub, the
same-subject preserve, and unrelated-key survival; it seeds every listed key
generically so a future list entry is exercised automatically, and both
mutation probes (fixture skips a key; real scrub loop skips a key) are killed
by it.

**Residual disclosed for the record, judged dismissible by all reviewers:**
a stale flight's unwind removes the mode/return-path keys unconditionally, so
a successor ORCID flow's freshly written keys could be wiped if the old
`startOrcid` resolves inside the successor's own round-trip window
(sub-second, fail-closed retryable dead-end at the callback, same shape as
the function's pre-existing error unwinds, and strictly narrower than the
base behavior of navigating). A value-conditional ownership guard cannot
discriminate two flights writing identical mode strings; a per-flight nonce
would be preemptive hardening per repo norms. Known parity-test blind spot,
also disclosed: a future subject-bound key scrubbed only via a new dedicated
clear function and never registered in the shared list is never seeded, so
parity passes vacuously — the docblocks at `_scrubSubjectBoundState` and
`subject-bound-keys.js` both channel additions into the list.

---

## Architect re-review (2026-09-02) — HELD PENDING FIXES:

Re-reviewed via `/ce-code-review` on `659131b8` (nine personas, an
independent validator, no cross-model peer available). **Both items held on
2026-09-01 are FIXED.** Item 1: the predicate is threaded from
`acquireSessionProof` through `beginSessionAuthOrcidRedirect` into
`beginOrcidFreshAuthRedirect`, both passwordless outcomes share the guarded
closure, page-level callers are unchanged, and the mirror test kills the three
relevant mutations (drop the check, drop the unwind, drop the predicate).
Item 2: `subject-bound-keys.js` feeds `fresh-auth.js`, the auth store's scrub
loop, and the fixture; the parity test runs the real `loginFromResponse`
against the mirror on identically seeded storage and kills both disclosed
probes; no key was dropped or added relative to the previous literal lists.
ARCHITECTURE § 6.4.1 / § 6.5 invariant #9 hold (`cacheSessionProof` call sites
identical to the parent commit). Project standards clean.

One item, on the lines this round added. Two reviewers (adversarial,
frontend-races) converged independently; the validator confirmed and picked
the same fix shape.

### Item 1 — the stale branch's key removals never clean the flight's own keys; they can only wipe a successor flow's

`isStale()` is `generation !== _acquireGeneration`. The generation is bumped
only inside `abandonInFlightAcquisitions`, whose only production caller is
`_scrubSubjectBoundState`, and that scrub runs `clearReturnPath()` and the
`SUBJECT_BOUND_STORAGE_KEYS` removal loop synchronously in the same call, with
no await. Every path into `beginOrcidFreshAuthRedirect`'s two key writes is
synchronous from the last generation check (both passwordless outcomes at this
commit; the consent-op starters after `01347275` as well). So by the time the
stale branch runs, the flight's own mode and return-path keys are already gone,
and any key present was written by a later flow.

Consequence: a successor ORCID flow started by the new subject in the same tab
(logout, re-login, click a passwordless-gated action; or a cross-tab login
then a click here) while the old `startOrcid` is still pending (up to the 30s
api timeout; nothing aborts it on logout) loses its keys, navigates anyway,
and on return `/orcid/callback` reads mode '' and completes unauthenticated.
The backend refuses before consuming state, so nothing is minted, but the user
lands on the generic "verification failed" dead-end after a full OAuth
round-trip. That is a user-visible regression this round introduced. The
2026-09-01 prescription "clear the keys, mirroring the error unwinds" was
wrong at this boundary: the error unwinds clean keys when no scrub ran; here
the scrub is what made the branch reachable. The mirror test hides it because
`teardownSubjectState()` omits the key removal the real scrub performs, so its
two null assertions pass only through the redundant removals.

Fix:

1. Make the stale branch `if (isStale?.()) return FRESH_AUTH_CANCELLED;` with
   no storage writes. Say why in the comment, anchored on stable symbols: the
   predicate reads true only after `_scrubSubjectBoundState` has removed the
   keys, so anything present belongs to a later flow and is not this flight's
   to remove. Do NOT add an ownership counter or nonce; it would guard a
   window that does not exist. Rewrite the `beginOrcidFreshAuthRedirect`
   docblock sentence claiming the unwind "keeps that true even when it has
   not"; that claim is false.
2. Make `teardownSubjectState()` in `lib-fresh-auth-session-window.test.js`
   faithful to the real scrub: also remove the ORCID mode and return-path keys
   (loop `SUBJECT_BOUND_STORAGE_KEYS` from `subject-bound-keys.js`), so the
   redirect-teardown test's two null assertions hold for the right reason. The
   consent-op suites' helpers carry the same shape; they belong to
   `ui-consent-op-teardown-guard` and will be held there, not here.
3. Add the successor test: `startOrcid` pending, teardown, a second
   `ensureSessionWindow()` writes its own keys, resolve the stale start, assert
   `window.location.href` unchanged AND the successor's keys intact, then
   resolve the successor's start and assert it navigates. Red at base (the
   current branch wipes the keys).

### Not held, routed elsewhere

- The page-level authenticated starters `settings.js#handleOrcidLink` and
  `accreditation.js#handleOrcidVerify` navigate unconditionally after their own
  `startOrcid` await (pre-existing, fail-closed): filed as
  `ui-page-level-orcid-start-subject-pin`.
- The unused `ORCID_RETURN_TO_KEY` export and the inline mode literals in the
  page-level flows: dismissed; the module docblock discloses the scoping.
- A `startOrcid` rejection after a teardown still throws out of the stale
  flight (pre-existing, not prescribed on 2026-09-01), and the silent cancel on
  the session path (routed to `ui-consent-op-teardown-guard` on 2026-09-01):
  accepted as recorded.

**When the fix lands, `git mv` this file back to `tasks/review/`.** The move is
the re-review signal. Do not edit this hold block; the commit diff is the
evidence and the architect updates the block at re-review.

---

## UI re-review signal (2026-09-02, commits 07c07fd1 + 39363364)

The held item landed, plus one scope widening the user approved explicitly
before implementation (see "Approved deviation" below). Verified before
implementing rather than taken from the hold block: an investigation fan-out
(four dimensions, two adversarial lenses each) re-derived the item's premises
against current HEAD, since the consent-op work landed after the hold was
written. Then a second fan-out reviewed the result: three simplify personas
plus correctness/races, security/account-state and mutation-probing
test-quality lenses, every finding refute-voted by three independent skeptics.
Full frontend unit suite on the integrated tree: 81 files, 1810 tests green
(the 3 vitest errors are the documented pre-existing `pages-edit`
`_mountEditors` rejections). Playwright not run: no visual surface changed;
same omission posture as the previous rounds.

**Item 1, part 1 (the stale branch).** `if (isStale?.()) return FRESH_AUTH_CANCELLED;`
with no storage writes. No ownership counter or nonce. The docblock sentence
claiming the unwind "keeps that true even when it has not" is gone; the
replacement states the ordering that makes the rule safe (`_scrubSubjectBoundState`
bumps the generation the predicate reads and removes `SUBJECT_BOUND_STORAGE_KEYS`
in one synchronous body, and the flight wrote its keys before the await the
teardown landed in), and the consequence of taking a successor's marker
(`completeOrcid` reads it to decide whether the callback carries the session
JWT, so an authenticated-mode flow whose marker went missing posts its callback
unauthenticated and dead-ends). Anchored on stable symbols only.

**Item 1, part 2 (the staged teardown).** `teardownSubjectState()` now runs the
scrub's `SUBJECT_BOUND_STORAGE_KEYS` loop, matching the two consent-op suites.
`dismissOpenReauthPrompt()` is deliberately still omitted and the helper's
comment says why (several cases hold the prompt open and resolve it by hand).
The existing redirect-teardown case's comment claiming the keys are "cleared,
mirroring the error unwinds" was false under the fix and is rewritten.

**Item 1, part 3 (the successor test).** Both doors, one case each. Both were
red at base for the right reason (the successor's mode key wiped by the
departed flight). Each flight is parked on its own `startOrcid`, both read
passwordless, and the successor starts from a different pathname so its return
path is distinguishable from the departed flight's rather than coincidentally
equal to it.

**Approved deviation: the rejection door.** The `catch` around `await startOrcid`
carried the identical unconditional removal and sits UPSTREAM of the staleness
gate, so the prescribed fix closed only the resolve door. The start carries the
api layer's 30s timeout and nothing aborts it on a subject change, which makes
rejection at least as likely an ending for a flight that outlives its subject.
Four reviewers converged on it independently and one reproduced it with item 1
applied. Surfaced to the user before implementing; they chose to gate it here
rather than route it out. Both doors and both throw sites now share one local
`unwindFlowKeys` closure. Callers passing no predicate are unaffected.

**Found and fixed by this task's own review pass, beyond the hold block:**

1. The guard's non-stale direction had no coverage anywhere in the suite:
   gating on whether a predicate was SUPPLIED rather than on what it ANSWERS
   passed all 1809 tests. The three cases that pin the removals pass no
   predicate, and no production call site has that shape. A live predicate
   answering false now drives the rejection door.
2. The docblock claimed a caller class that does not exist ("the page-level
   start flows pass none"). Those flows never route through this helper; they
   write their own mode marker and call `startOrcid` directly, and every real
   caller threads a teardown guard. The previous round's prose leaned on the
   claim; corrected.
3. The session-window suite's `beforeEach` never abandoned in-flight
   acquisitions, so a case failing while a flight was parked leaked the promise
   and the next case joined it. One red case reported as several, including a
   5s timeout in an innocent neighbour. It distorted this task's own probe
   evidence until fixed.

**Mutation probes (re-run after fix 3, so each kill set is now exactly one).**
Stale branch removes the keys again -> the resolve-door case. Shared unwind
loses its staleness guard -> the reject-door case, and only it. Staleness check
deleted entirely -> eight cases across four suites. Staged teardown skips the key
loop -> the pre-existing redirect-teardown case only. Unwind stops calling
`clearReturnPath` -> four cases in the settings-orcid suite: the three
no-predicate unwind cases plus the live-false case, which supplies a predicate
but shares the same `clearReturnPath()` call. Predicate gated on presence
instead of truth -> the new live-false case.

Architect note (2026-09-03): the two counts above were recorded as nine and
three in the original signal. Both were re-measured empirically during the
round-4 review, in a scratch copy, and are eight and four. The other four
probes matched their claims exactly.

**Recorded for the architect, not fixed here:**

1. The hold block's justification ("anything present belongs to a later flow")
   is confirmed for the session path but is not strictly implied on the two
   consent-op assumed-password-ORCID-fallback legs: neither `resolveProof` nor
   `consentOpFreshAuthRetryGate` re-checks `guard.tornDown()` after
   `mintViaPasswordFactor` returns the fallback sentinel, so those two writes
   can post-date a scrub across a microtask hop. The session path has that
   re-check; the consent-op legs do not. The code is correct either way (the
   residue is two inert keys the next starter overwrites), and the interleave
   needs a same-tab scrub-bearing continuation queued ahead of the mint's
   return while the singleton reauth modal refuses a second password flow, so
   it is theoretical. Recorded because it is an asymmetry between siblings, on
   a surface owned by `ui-consent-op-teardown-guard`, not because it is
   actionable here.
2. Two concurrent same-subject ORCID flows in one tab still clobber each
   other's marker on the happy path, teardown or no teardown. Closing it needs
   the per-flight ownership token the hold block forbids. Unchanged by this
   work, and strictly narrower than before it.

---

## Architect re-review (2026-09-03) — HELD PENDING FIXES:

Re-reviewed via `/ce-code-review` on `07c07fd1` + `39363364` (frontend paths
only): eight reviewer personas plus an independent validation batch. No
different-provider CLI is installed on this host, so the cross-model adversarial
pass did not run and the lens was carried in-process; its agreement carries no
promotion bonus.

**The item held on 2026-09-02 is FIXED, in all three parts.** Verified
independently rather than taken from the signal. The stale branch is a bare
`return FRESH_AUTH_CANCELLED` with no storage access, and `unwindFlowKeys`
short-circuits before both removals. The non-stale path is provably identical to
pre-fix behavior at all four exits: the staleness re-check precedes the
unparseable-URL and invalid-host exits with no await between them, so those
always remove, and with no predicate supplied every exit removes exactly what it
did before. `teardownSubjectState()` now runs the scrub's key loop. Both
successor cases were confirmed red at base by an independent empirical re-run.
The approved reject-door widening is correct and its ordering, unwind before
throw, is right.

The premise the fix rests on was attacked directly and HOLDS on every production
path: `abandonInFlightAcquisitions` has exactly one production caller, whose body
bumps the generation and removes `SUBJECT_BOUND_STORAGE_KEYS` with no await
between, and every caller of `beginOrcidFreshAuthRedirect` threads a real
predicate. The consent-op asymmetry recorded under "Recorded for the architect"
item 1 was raised by two reviewers, refuted by a third, and dropped by the
validator: `mintViaPasswordFactor` re-checks `guard.tornDown()` with no
intervening await before it returns the assumed-password fallback sentinel, and
every subject-scrub trigger is macrotask-rooted, so the event loop drains the
flight's whole microtask chain before any scrub can run. That recorded
characterization was accurate. No action.

Recorded item 2 (two concurrent same-subject flows clobbering each other's
marker) was independently re-found by two reviewers, who confirmed it is
pre-existing and that this work leaves it strictly narrower. Also accurate, and
not held.

Separately, the architect corrected two mutation-probe kill counts in the
2026-09-02 signal block above, which independent re-measurement put at eight and
four rather than nine and three. Recorded there, not an item here.

Three items remain, all one-sentence comment edits in `lib/fresh-auth.js`. Items
1 and 2 were each confirmed by the independent validator. Suggested order: item
1 first, since it is the same class of claim this round set out to remove.

### Item 1 — the sibling starter still asserts the caller class this round removed from its twin

`beginSessionAuthOrcidRedirect`'s docblock ends by saying that callers outside an
acquisition flight pass no predicate and keep the plain redirect. That caller
class does not exist: `acquireSessionProof` is its only caller and always threads
`guard.tornDown`. This is the identical claim the round removed from
`beginOrcidFreshAuthRedirect`'s docblock, left standing in the sibling. Reword
the trailing clause so it no longer implies a predicate-less production caller.

### Item 2 — the docblock added this round overclaims how a stale flight ends

The rewritten `beginOrcidFreshAuthRedirect` docblock states without
qualification that a stale flight resolves as `FRESH_AUTH_CANCELLED`. The
start-rejection path calls `unwindFlowKeys` and rethrows, and this round
deliberately widened the staleness gating to cover that door, so stale flights
reach it. Qualify the sentence: a stale flight whose start succeeds resolves the
sentinel; one whose start rejects still propagates the rejection to its caller.

### Item 3 — state the bump-and-clear contract where a future caller will read it

The ownership rule item 1 of the previous hold introduced is load-bearing on an
invariant nothing states: a generation bump must be accompanied by the
`SUBJECT_BOUND_STORAGE_KEYS` removal in the same synchronous body. The scrub
side is already pinned, by the cross-user case in `auth.test.js` that drives the
real store and asserts the key removal and the teardown call together on one
scrub. What is unpinned is a future SECOND caller of
`abandonInFlightAcquisitions` that bumps without clearing, which would invert the
stale branch's rule and turn every stale unwind into a key leak. Add a sentence
to that function's docblock stating the contract and the consequence of breaking
it. No test and no structural change: a callsite canary and folding the key
removal into the teardown were both considered and dismissed, the first as
brittle and the second as muddying the function's cohesion.

### Not held

The non-stale unwind can still strip a concurrent same-tab ORCID flow's keys
when a live sibling flight of a different mode overwrote them without any
teardown, since `unwindFlowKeys` short-circuits only on staleness. Pre-existing,
confirmed by blame, and unchanged by this work. A value-conditional ownership
guard would close the cross-mode case, though two flows sharing a mode string
still collide. Not held here, and not filed: it is the same family as the marker
clobber already recorded, and closing it properly needs the per-flight token the
previous hold deliberately forbade.

**When the fixes land, `git mv` this file back to `tasks/review/`.** The move is
the re-review signal. Do not edit this hold block; the commit diff is the
evidence and the architect updates the block at re-review.
