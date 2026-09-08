# Retire the "Disconnect" label in favour of "Sign out"

**Owner:** ui
**Created:** 2026-09-08

Routed out of the architect round-6 re-review of `ui-custody-upgrade-subject-pin`.
Recorded there, not held: the before-cleanup recovery copy tells the reader to
"Sign out" while the only sign-out affordance renders `header.disconnect`
("Disconnect"). Keeping the verb was the right call for that task; retiring the
jargon is the better fix and is bigger than that task's scope.

## Why

Two user-facing strings already instruct the reader to sign out using the verb
rather than the rendered label: `upgrade.sessionChangedBeforeCleanup` and
`upgrade.backendTimeout` ("Sign out and sign back in"). No control anywhere in
the app is labelled "Sign out". The header renders `header.disconnect` on
desktop and again in the mobile menu, and that is the only way to end a session.

So a reader following either instruction has to infer that "Disconnect" is the
sign-out control. In the before-cleanup flow that inference happens while the
user holds a freshly rotated seed phrase that exists nowhere else, which is the
worst moment to make someone guess. The sibling instruction in the same message
does not make them guess: it names the sign-in control by the label the header
renders and a test pins it.

"Disconnect" is also wallet jargon inherited from the Keychain-only era. Light
accounts sign in with an email and a password and never connect anything, so the
label describes the minority path. Relabeling removes the jargon and makes both
existing strings accurate, rather than pushing the jargon into more copy.

## Scope

1. Change the English value of `header.disconnect` to "Sign out". Keep the key
   name; renaming it churns every locale file for no reader benefit and breaks
   the ledger's per-key history.
2. Update the fifteen locale stubs and record the change in
   `frontend/public/messages/STUBS.md`. This key has been translated in the
   past, so this is a genuine `### Updated` entry, unlike the case the
   custody-upgrade task is fixing. Follow
   `agents/docs/solutions/conventions/i18n-stubs-added-vs-updated-scope-never-translated-keys-2026-06-09.md`
   and check which locales carry a real translation before deciding what each
   stub line should say.
3. Audit for other copy that names the control or the action. Grep the message
   files for "disconnect", "sign out", and "log out" and reconcile whatever
   turns up so the app uses one term for the action.
4. Check the aria-label, title, and any test selector bound to the old label.
   `components-header.test.js` and the e2e specs locate controls by visible
   text in places, so a label change can break a selector that has nothing to
   do with this work.

## Acceptance criteria

1. The header's sign-out control renders "Sign out" on desktop and in the
   mobile menu.
2. `upgrade.sessionChangedBeforeCleanup` and `upgrade.backendTimeout` name a
   control the app actually renders, with no copy change needed in either.
3. All sixteen locale files and the ledger agree, and the ledger entry is
   scoped correctly for a previously-translated key.
4. The frontend unit suite and the header-touching e2e specs pass, including
   any selector that matched the old label.

## Notes

Deliberately NOT in scope: pinning the sign-out step in the custody-upgrade
copy-contract test. Once the label and the verb agree, that assertion can pin
the rendered label the way the sign-in half does, but that is a one-line change
on the custody-upgrade task's own test and belongs with whoever touches it next.
Raise it in the signal if you land this first.
