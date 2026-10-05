# The sign-in modal has no way to ORCID sign-in

**Owner:** ui
**Created:** 2026-09-30
**Priority:** high

## Why

The sign-in modal (`signInModal`, opened by the auth store's `connect()`)
offers two options: email with password, and the browser extension. ORCID
sign-in exists only on the `/login` page (`handleOrcidLogin`), and the modal
links to sign-up and to the password reset, not to `/login`.

A light account with no password can therefore not sign in from the modal.
That was a minor gap while the modal only opened on the user's own click. It
is now the surface a revoked session lands on: the auth store's
`handleRevokedSession` tears the session down and opens this modal in place.
One of the causes of that teardown produces exactly the account the modal
cannot serve. A recovery through ORCID with no new password leaves the account
passwordless and revokes every other session. On the other device the modal
opens, email sign-in fails with the generic failure message because no
password exists, the extension option does not apply to a light account, and
nothing on screen points to ORCID.

## Scope

1. Give the modal's chooser a path to ORCID sign-in. Either an ORCID option
   that starts the same flow `/login` starts, or a link to `/login`. Prefer
   the option that does not leave the page when that is cheap, since the
   revoked-session teardown stays in place to keep unsaved work. If the ORCID
   round-trip leaves the page anyway, a link to `/login` is honest about it.
2. Reuse the login page's start flow rather than writing a second one,
   including the redirect-host allowlist check.
3. Add the copy to all sixteen locales per the stub convention.

## Acceptance criteria

1. A passwordless light account can reach ORCID sign-in from the modal.
2. The modal's existing email and extension paths are unchanged.
3. A unit test pins the new path.

## UI implementation signal (2026-10-06, commits dbc81a26, 25f3823b, 0b47e5ae, 2b9eb770)

Landed on main in four commits, each verified with
`git merge-base --is-ancestor <sha> main`:

- `dbc81a26`: the modal line, its two keys in all sixteen locales, the
  STUBS.md sweep, and the unit test.
- `25f3823b`: STUBS.md lines for the two ORCID button stubs that predate the
  ledger (decision 3).
- `0b47e5ae`: the simplification pass on the test.
- `2b9eb770`: the test reads each mode from the parsed markup (verification
  findings F1 and F2).

**Decisions taken with the user before implementing:**

1. **Same tab.** A link to `/login` in the same tab. Not a second ORCID start
   flow, and not a new tab. The new-tab variant was offered: the existing
   cross-tab storage sync would sign this tab back in with the page intact.
   The user chose the same tab.
2. **Both places.** The line appears in the chooser and in the email form. In
   this task's scenario the user tries email first and lands on the generic
   failure, where the email form showed only "Forgot password?" and Back.
3. **Old stubs now, own commit.** `login.orcidLogin` and `signup.orcidSignup`
   are English in all fifteen non-English locales and were never listed.
   They are appended under a fresh `### Added` heading for this task.

**Scope 1 / AC 1.**
- The chooser gets "Use ORCID to sign in?" with the link "Go to the sign-in
  page", under the two option cards and above the sign-up line.
- The link is `:href="$lp('/login')"` with
  `@click.prevent="cancel(); $store.router.navigate('/login')"`, the pattern of
  the sign-up and reset-password links.
- The email form carries the same line under "Forgot password?".
- On `/login` the signed-out store renders the ORCID button
  (`handleOrcidLogin`).
- The link text names the page it opens, because the link does not start
  ORCID itself.

**Scope 2.** No second start flow. `handleOrcidLogin` on `/login` stays the
only one, with its `ORCID_REDIRECT_HOSTS` check.

**Scope 3.** `signIn.orcidPrompt` and `signIn.orcidGoToLogin` are in all 16
locale files, right after `signIn.browserExtensionDescription`. The 15
non-English values are English stubs, listed under
`### Added 2026-10-06 (ui-sign-in-modal-has-no-orcid-path)`.

**AC 2.**
- The index.html diff adds lines only. The original `mt-4` paragraph now
  holds the ORCID line, and the sign-up line moved into a new `mt-2`
  paragraph.
- The email card, the extension card, the email form's inputs and buttons,
  and the unverified and extension modes are byte-identical.
- `sign-in-modal.js` is unchanged.

**AC 3.** The `ORCID sign-in line` describe in
`tests/unit/components-sign-in-modal.test.js` runs once for the choose mode and
once for the email mode. Each run parses index.html, takes the mode's x-if
template content, and finds the single link by its text key. Then:
- The `:href` binding is evaluated with a recording `$lp` stub and gives
  `/login`.
- The `@click.prevent` handler runs against a real modal instance after
  `prompt()`. The modal is closed, the mode is `choose`, the prompt resolves
  `null`, and the router is called with `/login`.
- Every `$t` key in the mode resolves in en.json.

**Verification:**
- **Unit suite.** The frontend unit suite at `2b9eb770` gives 92 files and
  2165 tests, exit 0.
- **Mutation probes.** Run on `2b9eb770` in scratchpad copies, one copy per
  mutant. These are killed: `cancel()` dropped, the href without `$lp`, the
  email line deleted, a key typo, `.prevent` dropped (a named assertion), the
  chooser line moved outside its x-if, the email line moved into the
  `emailError` template, the span and link keys swapped, and `cancel()` no
  longer resolving the prompt. Navigate-before-cancel survives by design,
  because the order makes no difference at runtime (F2).
- **Browser.** The working tree was served with vite dev against the dev
  backend and driven with headless Chromium through the repo's Playwright.
  agent-browser cannot open its socket directory in this sandbox. The modal
  was opened through `connect({ notice })` with the revoked-session notice,
  three times: en at 1280 and 390 px wide, and ar at 1280.
  - Each run showed one link per mode with href `/<locale>/login`.
  - Clicking it closed the modal and landed on `/<locale>/login` with the
    ORCID button visible.
  - There were no page errors.
- **E2E, not run.** No spec covers the chooser's copy. The selectors in
  `login-keychain.spec.js` are dialog-scoped button roles, and the
  `/login` ORCID click in `orcid-no-password.spec.js` uses an attribute
  selector. The new link matches neither (read, not run).

**Out-of-scope findings for follow-up:**

1. **Composer drafts on navigation.** `destroy()` on the publish and edit
   pages clears the pending 2 s draft debounce without writing it. Any in-app
   navigation away from a composer therefore drops the last 2 s of typing.
   That includes the modal's existing sign-up link and now this link.
   - ARCHITECTURE.md § 8 says work typed after a teardown "survives the trip
     to the sign-in page", which this partly contradicts.
   - It predates this task: the sign-up link did the same before.
   - Fix it in `destroy()`, or narrow the § 8 sentence.
2. **Overclaiming commit message.** The `dbc81a26` body says the test runs
   the link bindings against a real modal instance. Only the click handler
   does. `0b47e5ae` narrowed the source comment; history is left as is.
