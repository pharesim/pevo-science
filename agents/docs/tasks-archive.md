## The sign-in modal has no way to ORCID sign-in (archived 2026-10-06) — clean review; two signal follow-ups and two residual risks triaged

### Architect archive note (2026-10-06)

Full `/ce-code-review` of dbc81a26, 25f3823b, 0b47e5ae and 2b9eb770 (correctness, project-standards,
testing, frontend races, in-process adversarial, learnings). Verdict: ready to merge, no findings at any
severity; S1 to S3 and AC1 to AC3 met. The frontend unit suite at 2b9eb770, run in an isolated copy, gave
92 files / 2165 tests, the claimed count; its one failure was the known absolute-cap flake in
lib-fresh-auth-session-window, which passed 2 of 3 standalone re-runs. The testing reviewer re-planted the
signal's nine mutants: all killed; navigate-before-cancel survives as the signal states.

Dispositions (user approved "as recommended"):

- Signal out-of-scope 1 (composer `destroy()` drops the pending 2 s draft save): filed as
  `pending/ui-composer-destroy-drops-pending-draft-save.md` (normal).
- Signal out-of-scope 2 (the `dbc81a26` commit body overclaims): dismissed; history is not rewritten and
  `0b47e5ae` narrowed the source comment.
- Residual 1 (from /review the link leaves an undrafted review, and ORCID login lands on /papers): note
  appended to `blocked/ui-composer-surfaces-navigate-over-undrafted-work.md`; no new task.
- Residual 2 (a second root inside a mode template would render nothing while the test stays green):
  dismissed as preemptive test hardening; the shipped markup has one root per mode.

Compound: no.

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

## The settings email-verify handler clears verify_token on whatever row carries it (archived 2026-10-06) — re-review of the token-keyed swap fix; one comment clause cut in place

### Architect archive note (2026-10-06)

Full `/ce-code-review` of 02c66d99, the hold fix (correctness, security, in-process adversarial,
testing, project-standards; one validator pass). Verdict: ready with one P3 fix. Both held items are
fixed. The change-branch swap matches `pending_email_token = $2` and returns the swapped email; a
miss answers the generic 400 and skips the `notification_preferences` UPDATE. The add-flow clear no
longer carries the `username` conjunct. AC1 to AC4 hold. On a copy of 02c66d99 the in-scope spec
file plus `settings.test.ts` gave 37/37, exit 0, and removing the add-flow SELECT's `username`
predicate failed exactly the three wrong-flow specs (measured twice). Security and adversarial found
nothing.
The one finding (P3, confirmed by the validator) was fixed in place by the architect with the
user's approval, in 6e3c3814: the comment over the add-flow clear still said a raced link gets the
not-found answer "it would get a moment later". That is false when the interleaving re-issue's mail
fails, because the SMTP-fail restore puts the earlier token back. The clause is cut, matching the
swap comment.
Not an archive gate, per the user: the signal's full backend suite (19 failed in 9 files) was not
re-checked on clean main, and none of those files touches the settings routes. The signal's four
pre-existing items and the locked-row repair are already filed as their own tasks. No `/ce-compound`.

**Owner:** backend
**Created:** 2026-09-14
**Priority:** high

Surfaced by the security lens during the round-4 review of the
`accounts.updated_at` writer canary, and confirmed by an independent validation
pass. Pre-existing and unrelated to that canary's own change, so it is filed
here rather than held there.

## Why

`GET /api/settings/email/verify/:token` looks the row up by the token alone:

```
SELECT id, expires_at FROM accounts WHERE verify_token = $1
```

and then clears it:

```
UPDATE accounts SET verify_token = NULL, expires_at = NULL WHERE id = $1
```

Neither statement scopes the row to the flow that issued the token. The
settings add flow is the intended issuer, and it writes `verify_token` only on a
row it INSERTs for a username that had none, which is state G per
ARCHITECTURE.md section 6.1. But the signup INSERTs in `routes/auth.ts` write
the same column on a pending row, and the signup verify-link step writes the
`confirmed:` form. Either of those tokens presented to this handler is accepted.

The row that results is `verify_token` NULL with `username` NULL, which section
6.1 does not enumerate, and it is terminal:

- `POST /api/auth/signup` answers 409 for an existing row whose `verify_token`
  is NULL, so the address cannot be signed up again.
- The resend route returns before its UPDATE when the token is already NULL, so
  no new link can be issued.
- Signup cleanup deletes only rows whose `verify_token` is NOT NULL, so the row
  is never reaped.

So anyone holding a leaked verification link, or the `confirmed:` auth_token,
can permanently lock that email address out of signup. That is the capability
the signup session binding exists to deny a leaked token, reached through a
different route. Worth tracing on the way in: the login handler's pending-state
branch keys on the token too, so a bricked row falls through to the active
branch, and what a session minted from a row with a NULL `username` does is part
of the blast radius rather than a separate question.

The two stuck-recovery lookups are NOT reachable from this row: both conjoin a
`custody` value no INSERT writes. The marker is not moved either. This is an
availability and account-state defect, not a binding bypass.

## Scope

1. Scope the add-flow lookup and its UPDATE to rows the add flow could have
   created, so a signup token presented here is not accepted. The add flow's
   rows always carry a `username` (the INSERT names it); the signup INSERTs
   leave it NULL. Verify that separation from the code before relying on it
   rather than from this description, and say what you verified.
2. A token that does not match after the narrowing must answer the same generic
   400 the not-found path already answers. Do not add a distinguishing message:
   the difference between "no such token" and "that token is not for this flow"
   is a signup-state oracle.
