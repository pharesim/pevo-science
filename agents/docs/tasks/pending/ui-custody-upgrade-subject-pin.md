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
