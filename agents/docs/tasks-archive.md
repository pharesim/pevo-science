## State G rows: unverified-email lifecycle and token scoping (archived 2026-10-07): two rounds; held on the recover oracle comment and the resend token write, clean re-review; [TODO Architect] docs applied, follow-ups filed, one dismissed

### Architect archive note (2026-10-07)

- **Re-review:** `/ce-code-review` full path on `8f4a8287` and `09e006ed` (branch-remote via a synthetic head holding the four backend files; base `9ca30584`; interleaved task-file commits excluded): correctness, security, adversarial (in-process, no cross-model peer), testing, project-standards, learnings. Verdict "Ready to merge", zero findings. Both hold items fixed: the oracle claim deleted in `recover.ts` and the test header, matching the hold's literal forms; the resend UPDATE keyed on the token read, with no mail on no match. A real-path race probe (base vs head, `pool.query` spy plus a held row lock) reproduced the hold's defect at base (a finalized light row left holding a signup hex token) and showed it gone at head for finalize, confirm, delete and a concurrent resend; the uncontended and expiry-bump cases still mail once. Testing re-ran the signal's seven green claims alone (all exit 0); mutants on the happy path were killed (the orchestrator re-ran one), and dropping the token conjunct survives, as the hold accepted.
- **Triage (user: "approved" as recommended):**
  - Filed: the resend comment's "the token read above" (P3 residual) and the anchor rot in `auth-log-shape.test.ts` and `recover.test.ts` -> `backend-test-comment-anchors-and-resend-comment` (low).
  - Filed: the shared custody ORCID, the `recover_%` cleanup wildcard and the `auth.test.ts` notifications timeout (first signal's test-isolation list) -> `backend-route-test-isolation-and-a-notifications-timeout` (low).
  - Folded: the `/login` expired-signup DELETE keyed on `id` alone -> `backend-verify-link-argon-spec-and-expiry-delete-key`.
  - Filed: `[TODO UI]` items 1 and 2 -> `ui-pending-unverified-and-no-password-set-copy` (normal).
  - Folded: `[TODO UI]` item 3 (every settings email call sends the Bearer JWT, so a Keychain user's add flow gets 401) -> `ui-state-d-session-settings-critical-actions`, widened to every `'self'` session and raised to high.
  - Dismissed: the `/resume-signup` UPDATE keyed on `id` alone. It does not fire today: `/confirm` and `/link` select by the `confirmed:` token, the login pending block and the cleanup's signup arms are scoped to `username IS NULL`, and its G arm needs a hex token.
  - Noted only: an unverified G row can be kept alive by re-issuing, blocking another Keychain user's settings add (409). Signup is not blocked, because signup evicts the claim.
- **[TODO Architect]:** applied in `8d27a8f3` (§ 6.3 eviction transition; § 6.4 change-email add-flow 401 and re-issue, ORCID recovery on the derived claim, set-password `PENDING_UNVERIFIED`; `auth.md`, `settings.md` and `orcid.md` per the list). Two oracle claims the code contradicts were deleted on the way (the recover 401 contract and the § 6.4 ORCID-recovery row). Overlap recorded on `architect-accreditation-docs-drift-sweep` (item 4 done, item 3 partly).
- **Learnings checkpoint:** no entry contradicted (learnings reviewer plus a grep for resend-verification, `WHERE id = $3`, custody oracle and token-keyed writes); no hold-time entries to refresh. No new entry: guidance 3 of `mailed-credential-token-dies-with-its-address-and-credential` already states the token-keyed write principle.

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
