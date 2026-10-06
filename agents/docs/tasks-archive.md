## Decide how an institutional mailbox is bound to one accredited account (archived 2026-10-06) — seven questions decided with the user; design written to ARCHITECTURE.md § 2 Credential Bindings; 8 implementation tasks and 7 defect tasks filed

### Architect archive note (2026-10-06)

Decisions, the task list and the dismissals are in the "Decisions (2026-10-06)" section below. Design commit 30817bbe.

**Owner:** architect
**Created:** 2026-10-05
**Priority:** high

Filed from the accreditation and Web of Trust audit (finding 3). Two reviewers reported it and the
validator confirmed it from the code. The user chose a design task over accepting it for beta
(2026-10-05).

## Why

`POST /api/accreditation/request` checks an address only with `isInstitutionalEmail`, behind a
limiter keyed on the Hive account. `POST /api/accreditation/verify` never looks up earlier use of
the address: `evidence_hash` is salted with the token, so two accreditations from one mailbox
share no value on chain, and nothing in the app database records the address. A sanction is keyed
on the Hive username.

So one mailbox can accredit any number of Hive accounts, and a sanctioned researcher can accredit
a fresh account from the same mailbox. Every accredited account can vouch, and the threshold
number of vouches (3 by default) enrolls an account in the Web of Trust, so the WoT is only as
strong as this binding.

## Questions to settle

1. **The rule.** Does one verified mailbox back at most one accredited account at a time? Does a
   sanctioned account's mailbox stay bound, so that its holder cannot accredit another account?
2. **Where the binding lives.** An app-database table keyed by an HMAC of the normalised address
   needs a migration and is not reconstructible from the chain, which sits against design
   principles 2 and 6. A value on chain is public and linkable, which sits against principle 5.
   Name the trade and choose.
3. **Normalisation.** Case, plus-addressing, and subdomain variants of one institution.
4. **Rebinding.** A researcher who lost their keys, or who moves to another account.
5. **Other entry points.** Light-account signup already refuses a duplicate `accounts.email`. How
   do the signup-verify accredit path and the settings email add flow relate to the binding?
6. **Existing accreditations.** Past `evidence_hash` values cannot be compared, so the binding
   can only apply from its rollout on, apart from addresses the `accounts` table already holds.
7. **Enforcement points.** A refusal at `/request` is cheap; the check at `/verify` is the
   authoritative one and has to hold when two verifications race.

## Deliverable

Work the questions through with the user (`/ce-brainstorm`). Record the decisions in
`ARCHITECTURE.md` § 2 and file the implementation tasks with their priorities. A schema change
needs the user's explicit approval before any task is filed.

## Related

`backend-accreditation-verify-requires-the-account-session` makes a verification show control of
both mailbox and account. It does not limit how many accounts one mailbox can accredit.

## Decisions (2026-10-06)

Worked through with the user in a `/ce-brainstorm` dialogue, grounded by a read-only workflow over
the code, the open tasks and external sources (52 agents, every fact adversarially verified), and
written into `ARCHITECTURE.md` § 2 "Credential Bindings", § 2 "Revocation (custom_json)",
"Accreditation Lifecycle & Sanctions", § 6.4, § 7, `hive-schemas.md` § 2.1 and 2.2, `CONCEPTS.md`
("Credential Binding", "Release"), `.env.example` (`MAILBOX_BINDING_KEY`); commit 30817bbe. The
text passed a five-lens doc review with adversarial verification of each finding (45 applied).

| Question | Decision | Chosen over |
|---|---|---|
| 1. The rule | One verified mailbox backs at most one accredited account; a second account is refused, sanction or not, so a sanctioned account's mailbox stays bound. Extended to the ORCID iD: each credential binds one account, a sanction keeps every credential held. The principle is one researcher, one accredited account; two credentials on two accounts is an undetected breach, not a permitted arrangement (user correction mid-session) | sanction-only refusal; record-only registry; small per-mailbox cap; mailbox only |
| 2. Where the binding lives | Mailbox: app-database table `mailbox_bindings` keyed by HMAC-SHA256 of the canonical address under a dedicated secret, nothing on chain (schema change approved). ORCID: on chain as today, with sanction stickiness added to the read | keyed hash in the accredit op; table plus encrypted copy on chain |
| 3. Normalisation | Trim, lowercase, strip `+tag`, keep dots, the request schema's email rule, punycode domain; subdomains and aliases not folded; one shared function; the mail recipient is never derived from the folded form (architect, from evidence; confirmed in the synthesis) | |
| 4. Rebinding | The holder can release the account's own accreditation (new `revoke type: "release"`, admin-signed on the holder's fresh-auth request), which frees its mailboxes; lost keys go to an admin (`POST /api/admin/accreditation/release`). History of released bindings kept for admins, one year, no waiting period | admin-only; move by mailbox proof alone; no moves; waiting period |
| 5. Other entry points | Light-account signup claims the binding at finalize for the mailbox the signup link proved; `/signup` answers uniformly after the duplicate check; ORCID-path signups bind no mailbox; settings e-mail never binds; account deletion no longer frees a mailbox | |
| 6. Existing accreditations | Light accounts on file are bound by an operator script (mail-proven signup ops matched by hash); page-accredited Keychain accounts are left until their mailbox is next verified | asking the ten to verify again |
| 7. Enforcement | Uniform `/request` answer with the notice delivered by mail; authoritative claim at `/verify` after the session and the existing gates, 409 `MAILBOX_ALREADY_BOUND`, row before op, kept on ambiguous outcomes, partial unique index as race arbiter, fail closed without the app database | |

Tasks filed (2026-10-06): `backend-mailbox-binding-registry` (high),
`backend-accreditation-release-op` (high), `backend-orcid-binding-sanction-sticky` (high),
`backend-signup-finalize-claims-mailbox-binding` (high), `backend-mailbox-binding-backfill-script`
(normal), `backend-mailbox-binding-history-and-admin-view` (normal),
`ui-accreditation-binding-refusal-states` (high), `ui-accreditation-release-flow` (normal).

Defects found while grounding, triaged by the user "as recommended": `backend-signup-email-address-list`
(high), `backend-signup-finalize-evidence-hash-salted` (normal), `backend-verify-failure-may-have-landed`
(normal), `backend-registration-watch-masks-addresses` (normal),
`backend-academic-domains-case-and-stoplist` (low), `architect-accreditation-docs-drift-sweep` (low),
`ui-signup-duplicate-and-server-strings` (low); two stale-comment items appended to
`backend-accreditation-wot-comment-and-dead-code-pass`; `ui-light-account-vouch` moved from
`blocked/` to `pending/` (its blocker was archived 2026-10-01). Dismissed: `/verify` skipping its
HAF gates when HAF is unconfigured (every deployment configures HAF; the binding gate sits outside
that block by design).

The privacy and terms task (`tasks/hold/`, untracked) carries the notice items the binding needs.
Learnings: no `/ce-compound`; the design rationale is in `ARCHITECTURE.md`.

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
