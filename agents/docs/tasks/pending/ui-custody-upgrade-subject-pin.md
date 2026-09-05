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
