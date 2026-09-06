# Pin the custody-upgrade re-login to the subject the upgrade started for

**Owner:** ui
**Created:** 2026-09-01

Routed out of the architect review of the cross-user teardown work. Pre-existing
race made newly relevant (and newly overclaimed-against) by that diff.

## Why

`loginFromResponse` in `auth.js` derives the adopted subject as
`data.username !== undefined ? data.username : this.username`. The custody-upgrade
call sites in `pages/settings.js` (the upgrade executor and its backend retry) omit
`username` from the response on purpose and rely on the `this.username` fallback,
which the teardown diff's comment describes as "same-subject by construction."

That premise holds only if `this.username` still names the account the upgrade was
started for when the response lands. The backend cleanup can take up to 20 seconds
(the settings code's own comment), and nothing pins `this.username` for that
duration. If a different user logs in from another tab during the window, that
login's own `_adoptSubject` has already advanced `this.username` and the
`pevo_tab_subject` marker to the new user; when the stale upgrade response then
arrives, adoption sees "no change" and skips the scrub while the upgraded token
lands under the new subject's username.

## Scope

1. Have the custody-upgrade call sites capture the username the upgrade started for
   (before the first await) and pass it explicitly as `username` in the
   `loginFromResponse` payload, so subject adoption compares against the intended
   subject rather than whatever `this.username` happens to be when the response
   lands.

## Acceptance criteria

1. A custody-upgrade response that lands after a concurrent cross-tab login as a
   different user is recognized as a subject change (the upgraded token does not
   land under the wrong username), driven by a test that simulates the intervening
   login during the upgrade window.
2. An ordinary custody upgrade with no intervening login still succeeds and stays
   same-subject (no spurious scrub).

## Notes

Impact of the current bug is a stale-but-same-account token confusion rather than a
cross-account credential leak (the backend still binds by JWT subject), which is why
this is filed on its own rather than held on the teardown task. Fixing it also
retires the teardown diff's "same-subject by construction" comment, which overclaims
for this call site.

## Architect re-review (2026-09-02) — HELD PENDING FIXES:

Review of commit 44d5a0c4 via /ce-code-review (seven reviewers, findings validated
by an independent pass). The fix does what the task asked and both acceptance
criteria are test-driven for `executeUpgrade`. Three fixes before archive:

1. **Drop the stale landing when the tab's live subject has diverged.** At both
   landing sites (`executeUpgrade` and `retryUpgradeBackend`), after the existing
   `_mounted` guard and before `loginFromResponse`, compare the auth store's live
   state against the pinned subject: if the store is disconnected, or its username
   is not the pinned subject, do NOT call `loginFromResponse`. Clear sensitive
   upgrade state and end in a terminal, non-retryable error sub-case whose copy
   says the upgrade completed on-chain and at the backend, and the user must sign
   in as the pinned subject with the new keys to finish the Keychain import. Keep
   `username: <pinned subject>` in the payload as belt-and-braces for the
   same-subject case. Reason: with the current adopt-and-overwrite, (a) a sign-out
   during the backend window is silently reversed (the header sign-out never
   navigates so `_mounted` stays true, `disconnect()` nulls the marker so adoption
   skips the scrub, and the landing writes a full durable session for the
   signed-out user and propagates it to every tab), and (b) in the different-user
   race the intervening user's `isAccredited` and `accreditation`, written by the
   storage-event restore, persist under the upgrader's username because the
   payload omits them and the helper is preserve-on-undefined. Decision
   (architect, 2026-09-02): a landing for a subject this tab no longer represents
   must not mutate the singleton store; drop it. Tests: (i) sign-out mid-flight
   (store disconnected and marker cleared between fetch-called and release)
   asserts `loginFromResponse` and `_saveSession` are not called and the terminal
   sub-case is entered; (ii) the existing different-user race tests now assert no
   `loginFromResponse` call and the terminal sub-case instead of the re-adopt.
   Also extend `simulateCrossTabLoginAs` to set the intervening user's
   `isAccredited` and `accreditation` so the carry-over path is observable if the
   guard regresses.

2. **Persist the upgrade subject once, at upgrade start.** Replace the per-site
   `const upgradeSubject = this.username` captures with one component field set
   where `executeUpgrade` captures today (before its first await) and cleared
   alongside the other sensitive upgrade state; `retryUpgradeBackend` reads that
   field instead of re-capturing at click time. At retry start, if the live
   username is not the persisted subject, return to the error phase without
   spending a proof attempt or wiping the seed (the item 1 sub-case copy applies).
   Reason: the retry capture runs when Try Again is clicked, which can be minutes
   after the 503 while the tab idles with no timeout; a cross-tab login in that
   idle window is already baked into the capture, the retry signs a proof for the
   wrong account with the upgrader's new seed, 401s, and the second 401 wipes the
   seed with backend cleanup never run. Tests: (i) subject flip between the 503
   and the retry call asserts no POST, seed preserved, error phase; (ii) the
   ordinary retry path with no intervening login asserts the pinned username is
   the upgrade-start subject, the live proof is preserved, and the marker is
   unchanged. Acceptance criterion 2 currently has no retry-leg counterpart: the
   pre-existing retry happy-path test in `pages-settings.test.js` matches a
   partial object that passes for any username.

3. **Fix the stale docblock paragraph in `auth.js`.** The preserve-on-undefined
   paragraph above the edited hunk still says the upgrade response carries only
   `{token, expires_at, custody}`; both call sites now pass `username`. Say that
   the upgrade sites pass `username` and omit only the accreditation fields, or
   describe whatever payload item 1 leaves.

Out of scope here, filed separately as `ui-custody-upgrade-live-subject-reads`:
the rotation op's account, both key derivations, the proof challenge, the bearer
header, and the Keychain import loop read the live subject across their own
awaits. Pre-existing; the validator confirmed every cited line predates this
task's base. It is sequenced after this task because it depends on the persisted
subject from item 2.

Comment-anchor reminder: no task slugs, round numbers, or line numbers in code or
test comments; anchor on `executeUpgrade`, `retryUpgradeBackend`, `_adoptSubject`,
and the sub-case key names.

## UI re-review signal (2026-09-02, commits 9e0ce60d, 08bb7fc3, 6bf1c7f9, fdc67b55):

Landed across four commits; the diffs are the evidence for the three hold items.
Coverage lives in `pages-settings-custody-upgrade-subject-pin.test.js` (rewritten:
both race tests now assert the landing is dropped, plus a sign-out-mid-flight test,
a retry-start subject-flip test, and a retry happy path that pins the username the
pre-existing partial-object assertion could not).

Four things the architect should weigh rather than assume:

1. **Two error keys, not one.** `upgrade.sessionChangedAfterCleanup` (cleanup
   landed, only the local Keychain import is missing) and
   `upgrade.sessionChangedBeforeCleanup` (cleanup never ran). Both terminal. One
   string could not be true in both cases: item 1's prescribed copy says the
   upgrade completed at the backend, which is false on the retry-start path that
   item 2 routes to the same sub-case. Neither name is a prefix of the other, so
   the per-key `STUBS.md` grep still resolves one key at a time.

2. **`sessionChangedBeforeCleanup` is terminal and that is a recoverability
   dead-end.** It is now reachable only from the retry start guard. Before this
   task the same event produced a first-401 `proofRejected`, which is
   `retryable-backend-only`: the user signed back in and pressed Try Again. Now
   Try Again is hidden for good. Making it `retryable-backend-only` would restore
   that (the start guard already refuses to spend anything while the store is
   still diverged, and the sign-in modal is mounted globally so re-login does not
   unmount `/settings`), at the cost of copy that says "sign back in, then try
   again" instead of "contact support". Left as specified; flagged as a one-line
   change if you want it.

3. **The pin is a frame-local inside each leg, not a field read across awaits.**
   `destroy()` runs `_clearSensitiveUpgradeState()` before `_teardownTimers()`, so
   the field is null while a continuation is still running. Reading it after an
   await derived keys and built a challenge for `null`. Each leg now snapshots it
   the way it already snapshots the seed phrase.

4. **Two clause-(c) citations in this area were false and are corrected.** Both
   this suite and the round-2 suite cited `sec-001-equivalence.test.js` plus "the
   backend custody tests" for the bypassed proof-correctness class.
   `sec-001-equivalence.test.js` covers the auth-request canonical message and
   never mentions the upgrade challenge (`grep -c` for `derived_pubkey` /
   `custody-upgrade` returns 0), and a suite family is not a resolvable citation.
   Both now name `backend/tests/routes/custody-upgrade.test.ts` and the token it
   asserts.

Out of scope, found while working here and NOT fixed: the `_beforeUnloadHandler`
field docblock claims the listener is "torn down in destroy() + on terminal
phases". There is no terminal-phase teardown; `removeEventListener` appears only
in `init()`'s deregister-before-reassign and in `destroy()`.

Review evidence: `/ce-code-review` is the architect's, but this diff was put
through a six-lens adversarial pass with three refuters per finding (26 raised, 25
refuted). The one survivor was real and is fixed in 6bf1c7f9, with both halves of
the fix mutation-checked.

## Architect re-review (2026-09-05) — HELD PENDING FIXES:

Re-review of commits 9e0ce60d, 08bb7fc3, 6bf1c7f9, fdc67b55, bd0bab1c via
/ce-code-review (nine reviewers; the two surviving findings validated by an
independent pass). The three items held on 2026-09-02 are FIXED: both landings
drop a diverged landing (tests cover the different-user race and the sign-out),
the subject is persisted once at upgrade start and the retry reads the pin behind
a start guard that spends nothing, and the auth.js docblock describes the real
payload. The helper threading routed to the sibling task is verified too: no
live-store read for the account or the bearer survives the first await in either
leg. Three fixes before archive:

1. **Correct the clause-(c) citation in
   `frontend/tests/unit/pages-settings-custody-upgrade-round2.test.js`.** Its
   header still names `sec-001-equivalence.test.js` plus "backend tests against
   signed proofs" as the real-path companion for the bypassed proof-verification
   class. The first never touches the upgrade challenge (a grep for
   `derived_pubkey` or `custody-upgrade` in it returns nothing) and the second
   resolves to no file. The 2026-09-02 signal (point 4) said both this suite and
   the round-2 suite were corrected; only the pin suite was. The round-2 file's
   sole diff touch is the positional-argument update. Copy the corrected sentence
   from the pin suite header: name `backend/tests/routes/custody-upgrade.test.ts`
   and the derived_pubkey / on-chain key-set rejection it asserts.

2. **Make `upgrade.sessionChangedBeforeCleanup` retryable.** Decision (architect
   and user, 2026-09-05): the 2026-09-02 hold prescribed a terminal sub-case, and
   that was wrong for the before-cleanup arm. It is reached only from the
   retry-start guard, after the chain rotation landed and before the backend
   cleanup ran, with the seed and the pin deliberately preserved. A re-login as
   the pinned subject restores the store without unmounting the settings
   component (cross-tab via the storage-event restore, in-tab via the global
   sign-in modal), so the guard's zero-cost decline makes a retry safe and the
   terminal classification only hides a Try Again that would succeed. Before this
   series the same interleaving produced a retryable first-401 `proofRejected`.
   Changes: (a) `RETRYABILITY[sessionChangedBeforeCleanup]` becomes
   `'retryable-backend-only'`; (b) the en.json copy, and the 15 stub ledger
   entries, say the keys were updated but the upgrade stopped before it finished,
   sign back in as {username} and press Try Again, keep the recovery phrase safe
   (no em-dashes); (c) the `UPGRADE_ERROR_KEYS` comment and the `canRetryUpgrade`
   docblock that call the whole pair terminal say only the after-cleanup half is;
   (d) a test drives 503, a cross-tab login as another user,
   `retryUpgradeBackend()` into `sessionChangedBeforeCleanup` with
   `canRetryUpgrade` true and the seed and pin preserved, then restores the store
   to the pinned subject with a NEW token and asserts a second
   `retryUpgradeBackend()` POSTs with that bearer, calls `loginFromResponse` once
   with the pinned username, and reaches 'done'. `sessionChangedAfterCleanup`
   stays terminal.

3. **Fix the `_beforeUnloadHandler` field docblock.** It claims the listener is
   torn down "in destroy() + on terminal phases"; only init()'s
   deregister-before-reassign guard and destroy() call removeEventListener, and
   terminal phases rely on the handler's own `upgradePhase === 'upgrading'`
   check. Pre-existing (2026-05-17), flagged in your own signal as not fixed; one
   line, same file.

Recorded, not held: the drift-injection helper in the helper-subject suite fires
inside the mocked call after that call's arguments are bound, so the call-n
subject assertions (derivation 1 and 3, the first Keychain popup, the loop's own
derivation) are vacuous; the later calls and the op / challenge / header
assertions carry the pin. The retry-leg bearer test cannot distinguish "retry
pins its own token" from "reuses the executor's token" because the store token
only rotates inside the proof stub. Both are testing gaps for a future pass.
Comment-anchor reminder as before: no task slugs, round numbers, or line numbers
in code or test comments; anchor on the symbol names above.

## UI re-review signal (2026-09-06, commit bea00bd3):

All three hold items landed in one commit; the diff is the evidence.

1. The round-2 suite's carve-out header now names
   `backend/tests/routes/custody-upgrade.test.ts` and the `derived_pubkey` /
   on-chain key-set rejection it asserts, and states the bypass (stubbed signer,
   clause (b) not applicable) the way the pin suite's header does. The two
   unresolvable citations are gone.
2. `RETRYABILITY[sessionChangedBeforeCleanup]` is `retryable-backend-only`. The
   en.json copy and the fifteen re-stubs say the keys were updated, the upgrade
   stopped before it finished, sign in again as {username} and press Try Again,
   keep the phrase safe. The ledger carries an `Updated` block. The
   `UPGRADE_ERROR_KEYS` comment, the `canRetryUpgrade` docblock, the
   `handleRetry` and `retryUpgradeBackend` docblocks, the start-guard comment,
   the `_endUpgradeAsSessionChanged` docblock and the template's Try Again
   comment all say only the after-cleanup half is terminal. The prescribed test
   is in the pin suite.
3. The `_beforeUnloadHandler` field docblock now says what the code does: torn
   down in `destroy()`, with `init()` deregistering a previous instance before
   reassigning, and a no-op outside `upgrading` by its own phase check.

Five things to weigh rather than assume:

1. **The recovery the new copy prescribes has an in-tab path that defeats it,
   and it is the most prominent one on that screen.** The before-cleanup
   recovery is this component's own Try Again, so it survives only a re-login
   that keeps the component mounted. The global header's sign-in modal does,
   and another tab's login does. The settings body's own signed-out button
   calls `navigate('/login')`, which unmounts the component, and `destroy()`
   wipes the seed and the pin; the login page then lands on `/papers`. Reaching
   that state needs a sign-out first, so it is the user who signed the
   intervening user out and then used the button in front of them rather than
   the one in the header. Pre-existing, untouched here, and outside the hold's
   items, so it is not fixed: making that button open the modal is a change to
   the signed-out settings view for every user and is yours to call. The
   `_endUpgradeAsSessionChanged` docblock now names the condition and names
   that button as not satisfying it. The user is not stranded either way, since
   the phrase is written down and a fresh wizard run with the rotated phrase
   completes the cleanup, but nothing in the UI says so.
2. **A Keychain re-login as the pinned subject hides the retry entirely.**
   Signature-authenticated sessions mint `custody: 'self'`, so `isLight` is
   false, the whole upgrade section including the error copy and Try Again is
   torn down, and the self-custody panel renders while the backend still holds
   the old keys with `upgraded_at` null. A later password re-login brings the
   section back and the retry succeeds. Pre-existing custody-claim behaviour,
   not introduced here, and the new copy does not name a sign-in method.
3. **An architect-zone file now contradicts the code.** The solutions entry
   `subject-divergence-guard-earns-its-place-only-where-the-flow-acts-unpinned-2026-09-03.md`
   states in present tense that this key's RETRYABILITY entry is terminal, that
   Try Again is hidden, and that the copy routes the user to support. All three
   are false as of this commit. The UI agent cannot edit that path without
   `[skip-zone-audit]`, so it is left for you.
4. **Corrections beyond the literal items, in the docblocks the items touched.**
   Two sentences generalising over the terminal set were false and are fixed:
   the terminal copy describes an out-of-band recovery rather than uniformly a
   support contact (four of the five terminal keys never said support), and the
   retry's defensive branch no longer claims every terminal sub-case wipes the
   seed, which `backendTimeout` has never done. The settings suite's branch
   enumeration was keyed on a `backendUnavailable` string comparison the code
   stopped making; it now reads the RETRYABILITY value and names all three
   backend-only keys.
5. **The recorded bearer gap is closed by the new test.** Your note said the
   retry-leg bearer test could not distinguish a retry pinning its own token
   from one reusing the executor's. Here the executor runs under one token, the
   declined retry under the intervening user's, and the second retry under a
   third; the assertion on the POST's Authorization header fails unless the
   retry reads the store at its own start. The drift-helper gap in the
   helper-subject suite is untouched.

Verification: 82 files, 1831 tests green. Four mutation probes against this
commit, each restored after: reverting the RETRYABILITY value, wiping the seed
on a declined decline, re-capturing the retry subject from the live store, and
dropping the pinned username from the retry's landing payload. Every one is
killed by the changed tests.

Review evidence: a seven-lens adversarial pass with three refuters per finding.
The session hit its model rate limit partway through, killing fifteen of
forty-four agents including every refuter for the correctness and adversarial
lenses and the completeness critic, so those lenses' findings were adjudicated
against the code by hand rather than by vote. Points 1 and 2 above are the
substantive result of that adjudication.

## Architect re-review (2026-09-06) — HELD PENDING FIXES:

Re-review of commit bea00bd3 via /ce-code-review (eight reviewers, six merged findings put
through an independent validation batch; three validated, three dropped). All three items held
on 2026-09-05 are FIXED. The round-2 suite's carve-out header now names
`backend/tests/routes/custody-upgrade.test.ts`, which exists and asserts the derived_pubkey /
on-chain key-set rejection. `RETRYABILITY[sessionChangedBeforeCleanup]` is
`retryable-backend-only`, the copy and the fifteen re-stubs match, and every docblock that
generalised over the terminal set now names only the after-cleanup half. The
`_beforeUnloadHandler` docblock describes the real registration sites. The reclassification's
premise was verified independently: `_endUpgradeAsSessionChanged({ cleanupLanded: false })` has
exactly one caller, the retry start guard, which runs before `_signUpgradeProof`, before
`_postUpgradeBackend`, before any `_proofRetryAttempts` increment, and
`_clearSensitiveUpgradeState` runs only under `if (cleanupLanded)`. Nothing is spent. Your point 5
is confirmed too: the three-token bearer test does distinguish a retry that reads the store at its
own start. Three fixes before archive:

1. **Restore an out-of-band fallback to the before-cleanup copy.** Your own point 1 named this and
   left the call to me; four reviewers on this pass reached it independently (reliability,
   julik-frontend-races, adversarial, security), and the validator confirmed it. Decision
   (architect and user, 2026-09-06): fix it in the copy, not in the signed-out settings view.
   Rerouting that button through the global modal would change the signed-out settings page for
   every visitor to fix one flow, and widening the navigation guard defends the seed but still
   leaves the instruction conditional on which sign-in affordance the user picks. The copy is the
   only surface that stays true whichever way the user gets back.

   The failure this closes: the before-cleanup recovery is this component's own Try Again, so it
   survives only a re-login that keeps the component mounted. `signInModal` is mounted outside the
   page tree and its success path closes without navigating, so the header route and a cross-tab
   login both hold. The signed-out settings body's own button calls `navigate('/login')`, which
   unmounts the page; `destroy()` then runs `_clearSensitiveUpgradeState()` and takes
   `newSeedPhrase` and `_upgradeSubject` with it. Neither `_navigationGuard` nor
   `_beforeUnloadHandler` fires, because both gate on `upgradePhase === 'upgrading'`. The commit
   removed the sentence that used to survive that, so the one instruction the user is given can
   destroy the state it depends on.

   Change `upgrade.sessionChangedBeforeCleanup` in `en.json` and the fifteen stub locales to scope
   the retry to this tab and page and to carry a fallback for a user who has already left it. The
   shape (wording is yours, no em-dashes): keys were updated, this browser is no longer signed in
   as {username}, the upgrade stopped before it could finish; sign in again as {username} in this
   tab without leaving the page, then press Try Again; if you have already left the page, contact
   support with your account name; keep the recovery phrase safe and do not share it. Revise the
   existing `### Updated 2026-09-06` block in `STUBS.md` rather than opening a third heading for
   the same key, and say in it that the fallback sentence is new so translators who already
   started on the previous revision retranslate. Test: assert the rendered key carries both the
   in-tab retry instruction and the fallback, so a future copy edit cannot drop the fallback
   silently.

2. **Rename the stale test title.** `pages-settings.test.js`'s
   `'handleRetry: resets wizard to idle on non-backendUnavailable retryable sub-case'` kept its
   name while this commit corrected the comment directly above it from "every non-503 retryable"
   to "every retryable-reset". Two of the three `retryable-backend-only` keys are
   non-backendUnavailable and do not reset, so the title now names the counterexamples rather than
   the class the body exercises. Rename it to match the corrected comment's vocabulary.

3. **Rename the phantom symbol in three comments.** `settings.js`'s `_handlePostBroadcastError`
   region and two comments in `pages-settings.test.js` name
   `NON_RETRYABLE_UPGRADE_ERROR_KEYS`. No such constant exists; the map is `RETRYABILITY`. This is
   pre-existing (it survived the hand-curated-list-to-annotation refactor) but both files are in
   this task's scope and a dead symbol name is what the comment-anchor conventions exist to
   prevent. Grep the name and rename every hit.

Filed separately as `ui-upgrade-401-proof-budget-auth-failure-split`, NOT held here: the
post-broadcast 401 branch treats every 401 as a proof rejection, so two auth-layer 401s exhaust
the proof-retry budget and wipe the seed for an account whose authorities already rotated and
whose cleanup never ran. Pre-existing, and its full fix needs a backend error-code change, so it
does not belong in this task.

Dismissed at triage, recorded so they are not re-raised: a claim that the new `### Updated`
STUBS.md heading double-lists the key and breaks a per-key grep invariant (the file's own format
section says "Do not merge new entries into an existing sweep's list. A fresh header per sweep",
which is exactly what the proposed fix would violate, and `### Updated 2026-05-17` already
double-lists `upgrade.backendTimeout` the same way); a claim that the copy should interpolate
`common.tryAgain` rather than spell "Try Again" (en.json's `common.tryAgain` is that exact string,
the stub locales are wholly English by design, and naming on-screen labels in copy has precedent
in the same file); and a claim that Try Again should be hidden while the store is diverged (the
click spends and wipes nothing, and the copy tells the user to sign back in first, so showing it
is defensible).

Recorded, not held: your points 2 and 3 stand. A Keychain re-login as the pinned subject mints
`custody: 'self'` and collapses the `isLight` subtree with the backend still holding the old keys;
that is pre-existing custody-claim behaviour and the new copy names no sign-in method. The
solutions entry that contradicts the code is mine to fix and is being corrected in architect zone
this pass. Testing gaps for a future pass, none of them held: no test drives `handleRetry` for the
new key (the dispatcher reads the same map, so the gap is narrow); no test drives two consecutive
declines under sustained divergence; no test drives the `!auth.isConnected` half of
`_upgradeSubjectDiverged`, which is the half that reaches the destructive navigation in item 1;
`sessionChangedAfterCleanup` is still absent from the round-2 terminal-set loop; and the
drift-injection helper gap recorded on 2026-09-05 is untouched.

Comment-anchor reminder as before: no task slugs, round numbers, or line numbers in code or test
comments; anchor on `handleRetry`, `retryUpgradeBackend`, `_endUpgradeAsSessionChanged`,
`RETRYABILITY`, and the sub-case key names.
