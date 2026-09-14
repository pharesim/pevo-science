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

UI implementation signal (2026-09-14, commit 027c1b32):

- Landed in commit `027c1b32` on main. Self-verified: `git merge-base
  --is-ancestor 027c1b32 main` passes, and `git show --stat` lists
  index.html, STUBS.md, en.json and the nine re-stubbed locale files.
- Scope 1. `header.disconnect` now reads "Sign out" in English; the key name is
  unchanged.
- Scope 2, decision to flag. The key carried a real translation in every
  locale (born translated in the SPA import; never under an `### Added`
  heading), so the ledger entry is `### Updated 2026-09-14
  (ui-header-disconnect-label-signout)`. Rather than re-stub all fifteen
  locales, each prior translation was judged against the locale's own sign-in
  label (`signIn.signInButton`). Six already rendered a consistent sign-in /
  sign-out pair and keep their translation: da (Log ind / Log ud), de
  (Anmelden / Abmelden), fa (ورود / خروج), fr (Se connecter / Se déconnecter),
  he (התחברות / התנתקות), nl (Inloggen / Afmelden). The nine that paired a
  login verb with a connection-cutting verb (ar cs es it pl pt sv tr zh) are
  re-stubbed to "Sign out" and listed; the per-key grep of STUBS.md yields
  exactly those nine. This narrows the "re-stubbed with the new English"
  sentence in `agents/ui/CLAUDE.md` § Internationalization on purpose:
  re-stubbing a locale whose label was already right would swap a correct
  native string for English with nothing for a translator to fix. If the
  literal rule is preferred, the flip is mechanical: re-stub the six and add
  their lines under the same heading.
- Scope 3. Grepping en.json for disconnect / sign out / log out turns up only
  `header.disconnect` and the two upgrade strings; both now name a control
  the header renders, with no copy change (AC 2). No other user-facing copy
  names the action.
- Scope 4. No aria-label, title, unit-test assertion or e2e locator bound to
  the old visible text (`components-header.test.js` mocks the store method;
  the only header text locator in e2e is "Sign in"). The stale
  `<!-- Disconnect -->` markup comment was updated. `handleDisconnect()` and
  the `auth.disconnect()` store API are internal names and were left alone.
- Verification. Frontend unit suite: 85 files, 1890 tests green; three
  unhandled rejections from `tests/unit/pages-edit.test.js` (`$refs.abstractEditor`
  in the editor mount) reproduce in isolation and are unrelated. Header-touching
  e2e subset (10 specs, 32 tests, test-mode stack, DB reset by global-setup):
  21 passed, 11 failed. Ten failures are the documented pre-existing
  strict-mode clash (`form button[type="submit"]` also matches the global
  re-auth modal); the eleventh, `settings-orcid-factor.spec.js:207`, is a
  pre-existing assertion drift (the cached proof now carries `authorIndex` /
  `claimer`, written by committed `fresh-auth.js`) and reproduces alone. No
  failure output mentions the label. Browser check (Playwright against the
  rebuilt bundle): the desktop user menu and the mobile menu render "Sign out"
  in English, and de renders "Abmelden".
- Independent verification workflow (8 agents, 0 errors): three judges
  unanimously classified all fifteen prior translations (four sign-out verbs,
  eleven connection metaphors); the ledger and file-integrity lenses came back
  clean; the copy lens raised the fr / he pair point, which produced the
  pair rule above.
- Not done, per the Notes: the copy-contract test in
  `tests/unit/pages-settings-custody-upgrade-subject-pin.test.js` still pins
  the sign-out step with `toMatch(/sign out/i)`. Now that label and verb agree
  it can pin `messages.header.disconnect` the way the sign-in half pins
  `signIn.signInButton`; one-line change for whoever touches that test next.
