# State G rows: unverified-email lifecycle and token scoping

**Owner:** backend
**Created:** 2026-10-05
**Priority:** high

Surfaced by the state-G sweep on the account-state comments task (its signal block,
"Needs triage", items 1-11). The user triaged every item to "fix" on 2026-10-05 and
made two decisions:

- **Unverified G rows: verify the email first.** A state G row (ARCHITECTURE.md § 6.1)
  whose settings-registered email is still unverified may not acquire auth factors:
  setting a password and linking an ORCID are refused until the email is verified. An
  expired unverified G row then carries nothing but the email claim, so the hourly
  cleanup may keep deleting it (back to the no-row case, email released). Login never
  deletes a G row. Re-adding an email on an unverified G row re-sends its verification
  link instead of going through the change flow.
- **Include the two pending sibling tasks** in the same pass:
  `backend-signup-upsert-overwrites-finalized-row` and
  `backend-settings-verify-clears-any-row-token`. Each keeps its own task file, signal
  block and move to review.

The signup flow itself is unchanged: signup rows (E/F) have `username` NULL and never
reach the G-only branches. The one signup-visible change comes from the upsert task: a
signup for an email an unverified G row holds answers 409 until that claim expires and
is reaped (at most the 24h link expiry plus the hourly cleanup).

## Scope

1. **Login (`POST /api/auth/login`).** The pending-signup branch (PENDING_SIGNUP,
   PENDING_UNVERIFIED, the expiry DELETE and SIGNUP_EXPIRED) applies only to signup rows
   (`username` NULL). A G row with a password and an unverified email logs in normally
   and is never deleted here.
2. **Signup cleanup (`signup-cleanup.ts`).** Signup rows keep today's two expiry arms. A G
   row is deleted only when its email is unverified (hex `verify_token`), its link has
   expired, and it carries no password and no ORCID. A G row carrying a factor (a legacy
   row from before the gates in items 6-7) is never deleted by the job.
3. **Signup verify link (`POST /api/auth/verify`).** The token lookup is scoped to signup
   rows (`username` NULL). A G row's settings token answers exactly what an unknown token
   answers, and the row is untouched.
4. **Resend verification (`POST /api/auth/resend-verification`).** A row with `username`
   set (any finalized row, G included) is treated as not pending: uniform message, no
   token rewrite, no mail. Timing equalisation is preserved.
5. **ORCID recovery (`POST /api/auth/recover`, ORCID method).** Refused for any row whose
   custody claim is not light (`custodyClaimFor`), which excludes G as well as D, with the
   same 401 and generic message the upgraded and no-ORCID branches already return. This
   matches § 6.4 (ORCID recovery: B and C). The seed-phrase method already excludes G and
   D (no `memo_key_enc`).
6. **Set password (`POST /api/settings/set-password`).** Refuses a G row whose email is
   unverified (409 `PENDING_UNVERIFIED`, an existing error code).
7. **ORCID link and accredit (`/api/orcid` callback, `mode='link'` and `mode='accredit'`).**
   Refuse, before any broadcast, a caller whose row is a G row with an unverified email
   (409 `PENDING_UNVERIFIED`). A caller with no row is unaffected. Accredit is included
   because it writes the same `accounts.orcid` factor onto the row.
8. **Settings email.** (a) `POST /api/settings/email` on an existing unverified G row
   re-issues the add-flow verification (new `email`, `verify_token`, `expires_at`)
   instead of writing the pending-change fields; the JWT-path fresh-auth gate and the
   duplicate checks are unchanged. (b) The verify handler's change branch also clears a
   hex `verify_token`, since proving control of the new address verifies the row's email
   (legacy rows that used the change flow while unverified). (c) The add-flow lookup in
   the verify handler is scoped per `backend-settings-verify-clears-any-row-token`.
9. **Signup upsert** per `backend-signup-upsert-overwrites-finalized-row`.
10. **Login `NO_PASSWORD_SET` message.** One uniform message that is true for every
    passwordless row and leaks nothing per row (the branch is unauthenticated).
11. **Comments.** The JWT-path-equals-light-account comments (`admin-roster.ts`,
    `validation.ts`, `accreditation-metadata.ts`) and the "no-row-before-JWT invariant"
    comments (`settings.ts`, `settings-email-fresh-auth.test.ts`), plus every comment the
    code changes above make stale.
12. **Test data.** `settings-email-delete-fresh-auth` seeds a real § 6.1 shape; the
    migration 017 test title names G's NULL column.

## Acceptance criteria

1. Each behaviour in items 1-10 is pinned by a route or job test that fails against the
   pre-change code and passes after it.
2. No new error code: refusals reuse `PENDING_UNVERIFIED`; the recovery refusal reuses the
   existing 401 envelope.
3. Timing equalisation and uniform messages are preserved on every unauthenticated branch
   touched (login, resend, signup, recover).
4. No new writer of `accounts.updated_at`.
5. Comment-anchor conventions hold in everything written.

## Architect note (2026-10-05): item 10 and its comment

The `/login` `NO_PASSWORD_SET` comment in `routes/auth.ts` currently names one row whose
remedies the message misses: a state G row with no ORCID. That list is incomplete. A null-hash D
row (upgraded from C, or an ORCID-path `/link` D) cannot recover by seed phrase either (no
`memo_key_enc`) and is past ORCID recovery once `upgraded_at` is set. A pending ORCID-path F
row also reaches this branch, because the null-hash check runs before the pending checks. When
item 10 makes the message uniform, rewrite that comment so it lists no closed set of
exceptions. The architect updates the 403-versus-401 rationale in `api-contracts/auth.md` at
review. Say in the signal block what the final message is.

## Backend implementation signal (2026-10-05, commit d33792ce)

d33792ce verified as an ancestor of HEAD with `git merge-base --is-ancestor`. It carries this task
and the two sibling tasks the user folded into the same pass (the signup upsert task and the
settings verify-handler task, each with its own signal block). 49aa2c65, committed alongside, is
the held comments task's two items and touches nothing here.

**User decisions taken during the pass (2026-10-05), beyond the ones at the top of this file:**
- **Signup evicts a factor-less unverified G claim** instead of answering 409. Reason: the
  re-issue branch (item 8a) restarts the 24h expiry, and delete-then-re-add works too, so a 409
  let a Keychain user hold an unverified claim on someone else's address indefinitely. This
  supersedes the opening section's "answers 409 until that claim expires" for factor-less rows.
- **`POST /api/auth/verify` matches only an emailed hex token.** This is a security fix: a
  pending row's leaked `confirmed:` auth_token re-confirmed the row and minted the presenter a
  fresh signup binding.
- **The settings `POST /email` duplicate checks use `IS DISTINCT FROM`.** Previously an address a
  pending signup holds answered 500.
- **The upgrade's surviving consent proofs are noted only** (see Residuals).

**Per scope item:**
1. **Login.** The pending block is scoped to `username IS NULL`.
2. **Cleanup.** The predicate is `ABANDONED_ACCOUNT_ROWS`, exported as a WHERE fragment. The
   signup arms are scoped to username NULL. The G arm requires unverified, expired, no password
   and no ORCID.
3. **`/verify`.** The lookup adds `AND username IS NULL AND verify_token NOT LIKE 'confirmed:%'`.
4. **Resend.** A row with `username !== null` gets the uniform answer, after the argon2 verify.
5. **Recover.** The ORCID method refuses on `custodyClaimFor(account) !== 'light'`, with the
   same 401.
6. **Set password.** Answers 409 PENDING_UNVERIFIED 'Verify your email before setting a
   password.' It runs after PASSWORD_ALREADY_SET and before ORCID_REQUIRED and the proof
   consume.
7. **ORCID link and accredit.** `refuseUnverifiedEmailRow` runs at `/start` and in both callback
   handlers, before any HAF read, broadcast, cache write or row write. It answers 409
   PENDING_UNVERIFIED 'Verify the email you registered in settings, or remove it, before
   linking an ORCID.' In addition, `updateAccountOrcid` writes only where `verify_token IS
   NULL`, so a link that passed the gate cannot write onto a G row registered mid-broadcast.
8. **Settings.**
   - (a) The re-issue branch, with an SMTP-fail restore of email, token, expiry and the pending
     triple, scoped by token.
   - (b) The change-branch verify also clears `verify_token` and `expires_at`.
   - (c) Done per the sibling task.
   - Plus the `IS DISTINCT FROM` duplicate checks.
9. **Upsert.** Done per the sibling task, plus the eviction:
   - a conditional DELETE keyed on the state the pre-check read, in one transaction with the
     upsert, and only once the request is past the 422 gate;
   - `DO UPDATE ... WHERE accounts.username IS NULL AND accounts.verify_token NOT LIKE
     'confirmed:%'` on both upserts, with an upsert that writes no row answering 409.

   The `WHERE` term closes a window found in the final review. The caller's own settings
   add-flow INSERT could land while argon2.hash runs, and the upsert would then write a
   password onto an unverified G row. That would be a squat that can never be evicted or
   reaped.
10. **`NO_PASSWORD_SET` final message:** 'This account has no password. Use another sign-in
    method, such as ORCID or Hive Keychain.' Its comment lists no closed set, and notes the
    branch also answers pending signup rows.
11. **Comments.**
    - The JWT-path comments (admin-roster x2, validation x2, accreditation-metadata) describe
      the gate by auth mechanism. Their list of who holds a JWT is open and includes the
      `POST /api/auth/session` JWT.
    - The settings "no-row-before-JWT" comments are corrected: the header, handler-order item
      (4), the guard comment, and the `settings-email-fresh-auth.test` header and spec.
    - The `requireAdminLevel` docblock now says that on the JWT path `hiveUsername` is the
      verified JWT `sub`.
    - The `updated_at` canary docblock is rewritten against the new code.
    - The `recover.test.ts` headers, and every other comment the changes made stale, are
      corrected.
12. **Test data.** `seedSigUser` is now a real D row (`upgraded_at = NOW()`). The migration 017
    test title names G's NULL column.

**Tests.** Each was red before and green after. Where a behaviour already existed, the red was
observed by mutation.
- `auth-state-g-rows.test.ts` (new): login x4, resend x2 (one with a timing floor), signup x6:
  - eviction on the email path;
  - eviction on the ORCID path;
  - 409, argon2 burn and an unchanged row for a G row with a factor;
  - 422 keeps the G row;
  - ORCID_ALREADY_LINKED keeps it, through the rollback;
  - a G row written after the pre-check is left untouched and answers 409.
- `settings-state-g-unverified-email.test.ts` (new):
  - `/verify`: a G token, an expired G token, and an F `confirmed:` token;
  - set-password answers 409, and the same proof still works once the row is verified;
  - re-issue: the pending triple is cleared, the old pending token is dead, the new link
    verifies;
  - SMTP-fail restore puts the triple back;
  - `IS DISTINCT FROM` x2;
  - the verify task's E, F and add-flow specs;
  - the change branch clears a hex token.
- `orcid-state-g-unverified-email.test.ts` (new): refusal at `/start` (link and accredit),
  refusal at the callback with no broadcast, unaffected callers, and the `updateAccountOrcid`
  skip and write.
- `recover-orcid-state-g.test.ts` (new): ORCID recovery answers 401 for a verified G row that
  has an ORCID.
- `signup-cleanup.test.ts` (new): runs the job's predicate narrowed to the file's own rows,
  because vitest runs two files at once and the job's DELETE spans the table.
- `settings-email-fresh-auth.test.ts`: the add-flow JWT-rejection guard answers 401 and creates
  no row.
- Fixture fixes:
  - `recover.test.ts` and `auth-log-shape.test.ts` seeded a "pending" row with a username and
    custody 'light', a shape § 6.1 does not list; they now seed the signup shape.
  - The `settings-set-password-argon-error-translation` mock row gains `verify_token: null`.

**Verification.**
- Typecheck exits 0. Lint has 0 errors (one pre-existing warning, in `author-supersession.ts`).
- The pre-commit anchor matcher finds 0 hits on the added lines, and its control line fires.
- Full suite on this tree: 9 files failed.
  - 7 are the known clean-main red bar: cast-hardening, idempotency-real-haf,
    accreditation-idempotency, the accreditation cap specs, papers-enrichment-parity-gate,
    profile-auth-bypass and the reviews gate.
  - The other 2 pass when run alone: `signup-verify-activation-recovery` (the known lock spec
    that poisons itself, 9/9) and `fresh-auth-consent-op-burn-offline-queue` (4/4).

**Considered, not built.**
- A deterministic test for the eviction DELETE matching 0 rows. Code reading covers it.
- Restoring an evicted claim when the signup's verification mail fails after the commit. The
  signup row is deleted, and the G owner can re-add.
- Keeping the existing expiry on a same-address re-issue. With eviction, a held claim no longer
  blocks signup, only the victim's own settings add.

**Residuals for triage.**
- A G row's holder can still keep an unverified claim alive by re-issuing. That blocks the
  victim's settings add flow (409), not signup. A pending signup row E can likewise block a
  Keychain user's settings add, since a re-signup refreshes its expiry.
- Anyone who passes the accreditation gate can cancel a Keychain user's pending email
  registration (factor-less, unverified) by signing up with that address. They cannot verify
  it without the mailbox. This is the user's decision.
- The custody upgrade revokes JWTs and session proofs, but not single-use consent proofs. A
  password proof minted while the row was light stays consumable for its 5 minutes, given a
  JWT issued after the upgrade. The settings factor tables' D line says so. User: note only.
- `POST /api/auth/reset` can still add a password to any row with an email, an unverified G
  row included. The pending password-reset gating task owns that. The comments in this diff
  claim only what set-password and the ORCID link refuse.

**Test-isolation issues seen, not caused here.**
- `custody-session-auth.test.ts` and `custody-non-consent-fresh-auth.test.ts` seed the same
  fixed ORCID (`0000-0002-3456-7892`) under different usernames. When vitest runs them at the
  same time, one seed trips `accounts_orcid_unique`. Each passes alone.
- `recover.test.ts` cleans up with `username LIKE 'recover_%'`, which also matches the
  `recover2p_` rows of `recover-two-phase.test.ts`.
- `auth.test.ts` "accepts valid Bearer JWT on authenticated endpoints" times out at 30s with
  `--retry=0`, on `GET /api/notifications?since_block=1` against real HAF.

**[TODO Architect]** These come from the final review's list of statements the code now
contradicts.
- **ARCHITECTURE.md**
  - § 6.3 needs the eviction transition: `G (email unverified, no password, no ORCID)
    ──signup past the accreditation gate──> [no row]`, followed by the signup's own E or F
    row.
  - § 6.4 "Change email" says "Add-flow no-row branch is JWT-unreachable". A JWT does reach it
    (from `POST /api/auth/session`, or a session from before a deletion) and gets 401. The row
    should also name the re-issue branch.
  - § 6.4 "Recover (ORCID path)": the gate is now the derived custody claim, so G gets 401 too.
  - § 6.4 "Set password from null": an unverified G row gets 409 PENDING_UNVERIFIED before
    ORCID_REQUIRED.
- **auth.md**
  - The `NO_PASSWORD_SET` literal, its closed population and its rationale; and the signup
    `password` note ("sign in via ORCID or recover via seed phrase").
  - Signup `DUPLICATE` ("email already registered or pending ... BEFORE the accreditation
    gate"): an address a factor-less unverified G row holds is no longer a 409 (422 off-domain,
    evicted past the gate). A 409 can also now fire after the gate, when the claim changed or
    the upsert declined a row written after the pre-check.
  - Login: `PENDING_UNVERIFIED` and `SIGNUP_EXPIRED` apply to signup rows only, and login never
    deletes a G row. "Password-based login for light accounts" is too narrow.
  - Recover: "severed once ... state D" and the UNAUTHORIZED wording; the refusal now covers any
    non-light claim.
  - `/verify`: a `confirmed:` auth_token or a settings token gets BAD_REQUEST and no cookie.
- **settings.md**
  - set-password errors: add 409 PENDING_UNVERIFIED.
  - The `hasPassword` population, and "show a Set a password surface when false" (set-password
    is now refused unless the email is verified).
  - `POST /email`: "email is not switched until verify" (the re-issue branch writes it at
    once), and the re-issue branch itself is undocumented.
  - "Reachable only from the Keychain path (no JWT is minted before a row exists)", plus the
    missing 401.
  - `DUPLICATE` now also covers an address a pending signup holds.
  - The change-email and delete re-auth text: D is described by its preserved columns and G is
    missing. On the JWT path, D and G present ORCID.
- **orcid.md**
  - `/start` and `/callback` errors gain 409 PENDING_UNVERIFIED for link and accredit.
  - Accredit and link step 4, "Update orcid column ... (if light account)": the write now
    covers any row whose `verify_token` is NULL and skips an unverified G row.

**[TODO UI]** For the architect to file.
- The set-password section renders whenever `hasPassword === false`. It should also require
  `verified`, or map 409 PENDING_UNVERIFIED to copy.
- Map PENDING_UNVERIFIED on ORCID link and accredit (`/start` and callback), and
  `NO_PASSWORD_SET` on login, to localized copy. Today both fall through to generic errors.
- For 'self' sessions, the SPA sends settings email calls (add, change, delete, set-password)
  with the Keychain session JWT and never signs them with Keychain. A G or no-row user is
  therefore always on the JWT path: the add flow is refused (401), and an unverified G row
  cannot reach re-issue or delete, because it has no proof it can mint. This predates this
  work. The pending ui-state-d-session-settings-critical-actions task covers only D's change
  and delete.

## Architect note (2026-10-05), carried from the settings-verify review

For this task's review, not a hold. The settings-verify review of d33792ce raised one item
that belongs here: `POST /api/auth/resend-verification` reads the row, checks
`username === null`, runs an argon2 verify, and then writes the new hex token keyed on `id`
alone. A confirm plus finalize that completes inside that window would leave a signup hex
token on a finalized row. The ORCID `/start`, set-password and recover gates would then read
it as an unverified state G row, and nothing in normal use clears it: the mailed link goes to
`POST /api/auth/verify`, which now matches only username-NULL rows. The window is improbable
(a full Hive-broadcast finalize has to finish inside one argon2 verify). Triage it with this
task's other findings.

## Architect re-review (2026-10-05) — HELD PENDING FIXES:

Reviewed d33792ce with `/ce-code-review`, scoped to this task. Out of scope: the
`POST /api/auth/signup` handler (reviewed and held under the signup upsert task) and the
`GET /api/settings/email/verify/:token` handler (held under the settings verify task). Scope
items 1 to 8b and 10 to 12 and AC1 to AC5 are met. Two items are held.

1. **Delete the custody-oracle claim.** In `routes/recover.ts`, the comment above the
   ORCID-recovery refusal ends "The 401 + generic message matches the no-ORCID branch so the
   route does not become a custody-state oracle." The refusal answers 'Account does not have a
   verified ORCID' before the `orcid_token` is read. A light B or C row with an ORCID answers a
   bad token with 'Invalid or expired ORCID token'. So for an account that has an ORCID, the two
   messages tell a light row from a D or G row.
   - `routes/recover.ts`: delete "so the route does not become a custody-state oracle", keeping
     "The 401 + generic message matches the no-ORCID branch."
   - `tests/routes/recover-orcid-state-g.test.ts` header: delete ", which keeps the route from
     becoming a custody oracle", so the sentence ends at "...no-ORCID branches return."

2. **Key the resend's token write on the token it read.** `POST /api/auth/resend-verification`
   reads the row, runs the argon2 verify, and then writes the new token with `WHERE id = $3`. A
   confirm plus finalize that completes in between leaves a signup hex token on a finalized row.
   For that light account:
   - `POST /api/auth/recover` looks the account up with `verify_token IS NULL`, so neither
     recovery method finds it.
   - Set-password and the ORCID link and accredit modes refuse it as an unverified state G row.
   - The mailed link is redeemed by `POST /api/auth/verify`, which matches only username-NULL
     rows, so it does not clear the token.

   Add the token the handler read to the UPDATE's WHERE (`AND verify_token = <the token read>`).
   When the UPDATE matches no row, send no mail and return the same uniform message. Every
   interleaving then matches no row: the row moving from E to F, being finalized or being
   deleted, and a concurrent resend that already replaced the token (the resend whose write
   landed mails the live token). Only a caller who passed the password check reaches this write,
   so the no-mail answer adds no oracle. No new spec is required. An interleave spec was
   dismissed as preemptive hardening, as at the settings verify review.

Dismissed at this review (recorded so the archive keeps them):
- Reset plus login on an unverified G row (security). The validator rejected it as not
  introduced here. At d33792ce~1 whoever holds the mailbox could already click the settings
  verify link, reset the password and log in, and `reset-request` and `reset` are unchanged by
  this diff. An architect note on `backend-password-reset-gates-on-account-state` asks for that
  shape in its measurement.
- The re-issue UPDATE keyed on `username` alone. A verify click that lands in between is
  overwritten, but that is the caller's own requests racing, behind the fresh-auth gate, and
  recoverable.
- `updateAccountOrcid` not reading `rowCount`. It is already in the signal block, and re-linking
  the same ORCID passes the binding check.
- One shared helper for the unverified-G predicate, and `settings.ts` length. No project rule
  backs either.
- Specs for an expired, not yet reaped, unverified G row at the ORCID and set-password gates, for
  the re-issue restore's no-op branch, and for the `pending_email` duplicate check's
  `IS DISTINCT FROM` (no pending signup row carries `pending_email`). All are preemptive test
  hardening.
- The canary docblock's "declined rather than rewritten" clause is held under the signup upsert
  task, together with its `writeSignupRow` twin.

Filed at this review: `backend-signup-finalize-lookups-skip-finalized-rows`, for finalized rows
the old `POST /api/auth/verify` may have given a `confirmed:` token.

At archive: the `[TODO Architect]` doc updates and filing the `[TODO UI]` task.

When both items are in, `git mv` this file back to `tasks/review/`.

## Backend re-review signal (2026-10-07, commits 8f4a8287, 09e006ed)

Both SHAs verified as ancestors of HEAD with `git merge-base --is-ancestor`.

**Hold item 1 (8f4a8287).** `routes/recover.ts` now ends the comment at "The 401 + generic
message matches the no-ORCID branch.", and the `recover-orcid-state-g.test.ts` header sentence ends
at "...no-ORCID branches return.". Both are the prescribed literal forms.

**Hold item 2 (8f4a8287).** The resend UPDATE is `WHERE id = $3 AND verify_token = $4`, bound to
the token the handler's SELECT read. When `rowCount !== 1` the handler returns the uniform message
before the SMTP block, so it sends no mail. No new spec, per the hold.

**Found by verification, fixed after your triage (09e006ed).** The docblock of
`tests/eslint/no-accounts-updated-at-write-outside-signup-finalize.test.ts` credited the resend's
early return for a row with a username with keeping a hex token off a finalized row. That return
sees only the row as read before the argon2 verify. The clause now says the resend writes only where
the row still holds the hex token it read. User decision (2026-10-07): narrow it in this task.

**Verification.**
- Typecheck exits 0. Lint has 0 errors (the one pre-existing warning).
- Each route file run alone at 8f4a8287, all green: auth-state-g-rows 12/12, auth-log-shape 10/10,
  signup-verify-link-password 5/5, recover 32/32, recover-orcid-state-g 1/1,
  auth-argon-error-translation 18/18.
- `tests/eslint` alone: 9 files, 146/146, after each commit.
- The pre-commit anchor matcher finds 0 hits on the added lines, and its control line fires.
- An adversarial verification workflow ran against 8f4a8287: four lenses (race enumeration,
  real-path race probe, comment truth, oracle and timing) and two refuters per finding. All 6
  agents finished, none died.
  - Race lens: walked every `accounts` writer in `backend/src`. None moves a row the resend read
    as E to another state while keeping its hex token. No writer puts a prior token back on an
    E row, and ids are never reused.
  - Probe lens: scratchpad copies, a `pool.query` spy fires one write right after the resend's
    SELECT, SMTP mocked, every case `fired`.
    - Head: confirm, confirm plus finalize, delete and a concurrent token replacement each answer
      200 with the uniform message, send no mail, and leave the row as the interleaver wrote it.
      The uncontended case and an expiry-only bump still re-issue and mail once.
    - Base: the finalized light row gets a signup hex token and a mail (the hold's defect), a
      confirmed row reverts to hex, and a deleted row is still mailed.
    - A mutant without the `rowCount` guard mails a dead link in every race case.
  - Oracle lens: only a caller past the password check reaches the no-match return, the 503, 400
    and 500 paths are unchanged, and SMTP failure still cannot become a 500.
  - The one finding is the docblock above (1 of 2 refuters voted to refute it, on scope).
- Dev database, read-only: 0 rows with `username` set and a non-`confirmed:` `verify_token` under
  `custody` 'light', 'self' or NULL. No residue of the old race to repair here. Production not
  checked.
- This also closes the race the signup verify password task's verification noted: a resend racing a
  successful `/verify` could turn the confirmed row back into a hex-token row that keeps its binding.

**Out of scope, for follow-up filing (pre-existing, unchanged by this diff).**
1. The `/login` expired-E DELETE is keyed on `id` alone. A resend that refreshes the row between
   the SELECT and the DELETE loses its row, so the link it mailed is dead. (The `/verify` expiry
   DELETE twin is already listed in the signup verify password task.)
2. The `/resume-signup` UPDATE (`expires_at`, `signup_binding_hash`) is keyed on `id` alone. It can
   stamp those columns onto a row `/confirm` or `/link` finalized in between. Not probed for a
   reader that acts on them.
3. Anchor rot in tests, outside both the eslint canary and the added-lines gate:
   `auth-log-shape.test.ts` cites `auth.ts` line numbers for the two SMTP warn emissions and carries
   round ordinals, and `recover.test.ts` cites a task file slug.

**Learnings checkpoint.** Grepped `agents/docs/solutions/` for resend-verification, the
`WHERE id = $3` write and token-keyed writes. `timing-equalization-smtp-failure-mode-oracle` is not
contradicted (its uniform-200 goal holds; the new return is a 200). No new entry: item 3 of
`mailed-credential-token-dies-with-its-address-and-credential` already states the principle (the
write that issues the token re-checks the lookup's predicate).

**Simplify.** About 6 substantive changed code lines, under the `ce-simplify-code` threshold;
nothing to cut. Code review left to the architect at intake, per `agents/backend/CLAUDE.md`.
