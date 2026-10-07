## Recovery and password reset leave a queued email change alive, so the evicted attacker takes the account back (archived 2026-10-07): one round, clean review; two pre-existing findings filed as tasks, § 6.3 line applied

### Architect archive note (2026-10-07)

- **Review:** `/ce-code-review` full path on this task's hunks of `4196982f` and `e9f8214f` (branch-remote via a synthetic head holding only the three `pending_email` triple clears, the `/reset` comment line and the new spec; base `8d6bd4e5`; the sibling's hunks excluded): correctness, security, adversarial (in-process, no cross-model peer), testing, project-standards, learnings. Verdict "Ready to merge", no finding in the diff, every AC met. Testing's mutants m1/m2/m3 (triple removed from one statement) each turned exactly its spec red; the orchestrator's token-only-clear mutant turned 3/3 red on the `pending_email` NULL assertion. Baseline: the new spec and every AC 5 file green alone, exit 0, no Errors line. Adversarial's `pool.query` spy reproduced the accepted in-flight race end to end. The sibling's review (archived at `ba3b008f`) also killed the three triple mutants.
- **Triage (user: "as recommended"):**
  - Filed (security, pre-existing P1): `/orcid/start` modes `link` and `accredit` run on the session alone and plant an ORCID that survives every eviction (ORCID login and ORCID recovery give the account back) -> `backend-orcid-link-and-accredit-require-fresh-auth` (high) and `ui-orcid-link-and-accredit-acquire-fresh-auth` (high, blocked behind it). § 6.4 row rewritten to the decided re-auth.
  - Filed (adversarial, pre-existing): an attacker who completes the change before any eviction can beat an A owner's seed-phrase recovery by disputing it -> `architect-email-change-owner-notice-and-dispute-race` (high).
  - No action: the in-flight race (accepted by the task and the solutions entry; the attacker cannot stretch the window), the custody upgrade (Scope item 2), the solutions entry's missing custody-upgrade sentence (its eviction definition already excludes the upgrade).
  - Applied at archive: the § 6.3 "Evictions drop a queued email change." line, and a note on `architect-password-reset-gate-docs` to keep it.
- **Learnings checkpoint:** no entry contradicted; `conventions/mailed-credential-token-dies-with-its-address-and-credential.md` verified against `e9f8214f` by learnings and correctness. No new entry qualified.

**Owner:** backend
**Created:** 2026-10-06
**Priority:** high

Filed at the user's request from the pre-existing findings in the signal block of
`backend-settings-verify-clears-any-row-token` (its item 2), after a scoping pass that measured
the takeover end to end on 02c66d99. The scoping found that password reset has the same hole as
the two recovery routes.

## Why

The change flow of `POST /api/settings/email` writes `pending_email`, `pending_email_token` and
`pending_email_expires_at`, and mails the link only to the new address. Clicked within
`EMAIL_TOKEN_EXPIRY_MS` (24h, restarted by each re-queue), the link swaps the account email.

Three statements evict a password holder by replacing the password (and, for recovery, the
email) and stamping `sessions_invalidated_at`. None of them clears that triple:

- `routes/recover.ts`, `POST /recover`, ORCID method:
  `UPDATE accounts SET password_hash = $1, email = $2, sessions_invalidated_at = $3 WHERE id = $4`
- `routes/recover.ts`, `POST /recover/verify`, the apply transaction:
  `UPDATE accounts SET password_hash = COALESCE($1, password_hash), email = $2, sessions_invalidated_at = $3 WHERE id = $4`
- `routes/auth.ts`, `POST /reset`:
  `UPDATE accounts SET password_hash = $1, reset_token = NULL, reset_token_expires_at = NULL, sessions_invalidated_at = NOW() WHERE id = $2 AND password_hash IS NOT NULL`

Measured through the real routes: the real `verifyHiveSignature` JWT path, real login, real
fresh-auth. Only the SMTP transporter was mocked and the ORCID nonce seeded. The sequence:

1. An attacker who has only the password logs in, gets a `change_email` fresh-auth proof with
   that password, and queues a change to their own address.
2. The owner evicts them by ORCID recovery, seed-phrase recovery or password reset. The eviction
   works: the old JWT gets 401 SESSION_INVALIDATED and the old password is refused.
3. The queued link still answers 200 and sets `accounts.email` to the attacker's address.
4. `POST /api/auth/reset-request` mails the attacker a reset link. Reset and login then hand them
   the account.

After an ORCID recovery without a new password, the link still takes the email. The reset chain
completes once the owner sets a password through `POST /api/settings/set-password`.

The owner gets no warning. The change mail goes only to the new address, and nothing in
`frontend/src` reads the `pendingChange` field of `GET /api/settings/email`.

A planted fix that clears the triple in all three statements makes the stale link answer the
not-found 400, deep-equal to an unknown token's answer, and keeps the post-eviction email.

## Scope

1. Add `pending_email = NULL, pending_email_token = NULL, pending_email_expires_at = NULL` to the
   SET list of the three statements above. Write all three columns in the one statement, so that
   every write of `pending_email` or `pending_email_token` still writes both. The change-branch
   swap in `GET /api/settings/email/verify/:token` relies on that pairing.
2. Leave `POST /api/custody/upgrade`, the fourth writer of `sessions_invalidated_at`, unchanged.
   It replaces neither the password nor the email (ARCHITECTURE.md § 6.2: D keeps
   `password_hash`), so clearing the triple there evicts no one. A D owner evicts a password
   holder through `POST /api/auth/reset`, which this task covers. The upgrade docblock's sentence
   about "the same posture the password-reset and recovery writers take" concerns bearer JWTs and
   session-proof windows. It is not a contradiction for this task to fix.
3. Add no new response string, status or error code. A cleared link gets the existing not-found
   400.
4. Fix any comment the change makes false by deleting or narrowing it. At filing, the change made
   none false: the change-branch comments in `routes/settings.ts` and the docblock of
   `tests/eslint/no-accounts-updated-at-write-outside-signup-finalize.test.ts` both stay true
   under NULL-only writes. List the three changed writers in the signal block, so the architect
   can record in ARCHITECTURE.md § 6.3 that recovery and reset drop a pending email change.
5. Tests: one new real-path route spec file. The attacker queues the change through the real
   `POST /api/auth/login`, `POST /api/custody/fresh-auth` (action `change_email`) and
   `POST /api/settings/email`. Mock only the SMTP transporter and `config.smtpHost`, and seed the
   ORCID nonce. Use carve-out header items (a) and (c) as in `tests/routes/recover-two-phase.test.ts`
   and `tests/routes/recover-orcid-state-g.test.ts`. `verifyHiveSignature` runs real, so (b) does
   not apply.

## Acceptance criteria

1. The three named statements clear the triple. The custody upgrade is unchanged.
2. ORCID recovery spec: a state B row with a change queued through the real fresh-auth gate, then
   a 200 `POST /api/auth/recover` with `orcid_token`. The queued link answers a 400 deep-equal to
   an unknown token's answer, `accounts.email` equals the recovery's `new_email`, and the triple
   is NULL. The spec asserts the triple was non-NULL just before the recovery, and it fails
   against the pre-change code.
3. Seed-phrase recovery spec: the same, with `POST /api/auth/recover` (memo key) plus
   `POST /api/auth/recover/verify` as the eviction. It fails against the pre-change code.
4. Password reset spec: the same, with the owner's `POST /api/auth/reset-request` plus
   `POST /api/auth/reset` as the eviction. `accounts.email` stays the owner's address, and the
   spec fails against the pre-change code.
5. These stay green, judged by exit code and the Errors line: `tests/routes/recover.test.ts`,
   `recover-two-phase.test.ts`, `recover-orcid-state-g.test.ts`,
   `auth-reset-account-state.test.ts`, `session-proof-invalidation.test.ts`,
   `settings-state-g-unverified-email.test.ts`, `settings.test.ts`, and
   `tests/eslint/no-accounts-updated-at-write-outside-signup-finalize.test.ts`.
6. No new error code, response string or status. No emdash. No new writer of
   `accounts.updated_at`.

## Notes

- Land in one pass with `backend-reset-tokens-outlive-email-changes-and-recovery`. It edits the
  same two `recover.ts` UPDATEs (the `reset_token` clear) and the `POST /reset` UPDATE's predicate
  (its Scope item 3). `backend-reset-response-names-the-account` edits the same `POST /reset`
  handler's success data. Neither task closes this path: the reset-token one needs mailbox control
  or a pre-issued reset token, while this one needs only the password.
- Account-state check: `pending_email_*` is an overlay in ARCHITECTURE.md § 6.1, and clearing it
  changes no state dimension. Reset reaches A, B, D and G rows with a password, plus E rows and
  email-path F rows. E and F rows never carry a triple (`POST /api/settings/email` finds rows by
  username), so the clear is a no-op there.
- Accepted cost: a change the owner queued before their own recovery or reset is dropped. The
  owner re-requests it.
- Residuals, not proposed:
  - The owner is not told when a change is queued.
  - A change request already in flight can race the eviction. The window is server-side only and
    the attacker cannot stretch it.
- The custody upgrade path was not measured, because it needs on-chain keys. Its description
  above comes from code reading.
- Same statement family, different defect: both recovery paths check the new address against
  `accounts.email` only, not against other rows' `pending_email`. Filed in
  `backend-email-change-swap-500s-on-a-taken-address`.

## Backend implementation signal (2026-10-07, commits 4196982f, e9f8214f; learning 3611be12)

Landed in one pass with `backend-reset-tokens-outlive-email-changes-and-recovery`, which carries the
shared test-run detail.

- **AC 1.** The three statements write `pending_email = NULL, pending_email_token = NULL,
  pending_email_expires_at = NULL` in their one SET: `routes/recover.ts` `POST /recover` (ORCID
  method), `routes/recover.ts` `POST /recover/verify` (apply transaction), and `routes/auth.ts`
  `POST /reset`. `POST /api/custody/upgrade` is unchanged.
- **AC 2 to 4.** `tests/routes/recovery-and-reset-drop-queued-email-change.test.ts` (new, 3 specs).
  The change is queued through the real `POST /api/auth/login`, `POST /api/custody/fresh-auth`
  (`change_email`, password) and `POST /api/settings/email` on the real `verifyHiveSignature` JWT
  path, and the spec asserts the triple holds the attacker's address and the mailed token before
  the eviction. After it, the stale link answers a 400 deep-equal to an unknown token's,
  `accounts.email` is the recovery's `new_email` (ORCID, seed phrase) or the owner's (reset), and
  the triple is NULL. All three were red before the fix: the link answered 200 and swapped the
  email. Header: (a) the SMTP transporter and `config.smtpHost`, and the seeded ORCID nonce;
  (c) `recover.test.ts` [smtp-fail-test.invalid]; no auth middleware mocked.
- **AC 5.** recover, recover-two-phase, recover-orcid-state-g, auth-reset-account-state,
  session-proof-invalidation, settings-state-g-unverified-email, settings and `tests/eslint`
  (including no-accounts-updated-at-write-outside-signup-finalize) are green, each run alone, exit
  0, no Errors line.
- **AC 6.** This task's statements add no error code, response string or status (the reworded
  reset-request message belongs to the sibling), no emdash, and no writer of
  `accounts.updated_at`.
- **Comments.** None became false, as the filing found. The simplify pass deleted two `recover.ts`
  comments that only restated the SET lists.
- **For ARCHITECTURE.md § 6.3 [TODO Architect].** The three statements above drop a pending email
  change. The residuals stand as filed: a change request in flight still races the eviction (the
  change-flow write is keyed on `username` alone), and the owner is not told a change is queued.
- **Learnings checkpoint.** Covered by the sibling's new entry,
  `conventions/mailed-credential-token-dies-with-its-address-and-credential.md` (Guidance 1, and
  the in-flight residual under Guidance 3); no separate entry qualified.

## Reset tokens outlive email changes and recovery, and unverified G rows still get reset links (archived 2026-10-07): one round, clean on code; no hold, contract line applied, docs carried to the gate-docs task

### Architect archive note (2026-10-07)

- **Review:** `/ce-code-review` full path on `4196982f`, `e9f8214f`, `dbae925d` plus the learnings commits `3611be12`, `2230a1f8` (branch-remote via a synthetic head holding only the task's 11 files, base `8d6bd4e5`; the interleaved `9d1536a9` excluded): correctness, security, adversarial (in-process, no cross-model peer), testing, project-standards, learnings, plus a validator on three findings. Verdict "Ready with fixes", no P0/P1, no defect in production code. Every AC met, and the sibling's AC1 too. Testing ran the four task specs each alone (green) and `tests/eslint` at head and base (146 green both), and planted 15 mutants: 13 killed (each of the seven reset-token clears, the gate term at both ends, the token write's `email = $4`, the three `pending_email` triples), 2 survived (the token write's `password_hash` and gate re-check). Correctness, security and adversarial each re-measured the writer set by `git grep` and found the same seven. Project-standards checked every changed comment true. Adversarial's probe confirmed the race spec goes red against a token write keyed on id alone.
- **Triage (user: "approved", as recommended):**
  - Dismissed: the two surviving token-write terms (P2, preemptive test hardening; the `/reset` UPDATE's own password gate, pinned, still refuses such a token); the solutions-entry narrative finding (validator-rejected); the old reset message quoted in the illustrative snippets of `timing-equalization-smtp-failure-mode-oracle-2026-04-22.md`; out-of-scope 2 (re-issue keyed on `username` alone, dismissed before at the state G lifecycle review); out-of-scope 4 (a spec's leftover `password_reset` audit rows).
  - Accepted as behavior: a 0-row token write still mails and answers the same 200; both signup upserts clear the token on every retry over a row E. Accepted residual: reset tokens issued before deploy live out their hour.
  - Duplicate: out-of-scope 1 (row E with a NULL hash) is item 1 of `backend-signup-verify-requires-the-signup-password`, which landed in `c489e0ed` during this review.
  - Folded: out-of-scope 3 (`pending_email_token` has no index) into `backend-reset-token-lookup-has-no-index`.
  - Applied at archive: the `POST /api/auth/reset-request` message in `api-contracts/auth.md`. Carried: § 6.3/6.4/6.5 and the remaining contract sentence, as an architect note on `architect-password-reset-gate-docs` with the new per-state outcome list.
  - The learnings finding (the new entry's "the email signup upsert requires a password" false at `2230a1f8`) was moot at archive: `c489e0ed` made it true on `main`.
- **Process:** one reviewer tried `git checkout --detach`; the permission system denied it and the tree was verified unchanged. A follow-up to the adversarial reviewer ended on an API error; correctness and security covered its checks.
- **Learnings checkpoint:** `/ce-compound-refresh` scoped to `conventions/mailed-credential-token-dies-with-its-address-and-credential.md`: Keep (its Guidance 2 sentence matches `main` after `c489e0ed`). The `2230a1f8` edit to `credential-setting-token-redeem-must-not-name-the-account.md` was verified accurate by two reviewers. No new entry qualified.
- **Sibling:** `backend-recovery-and-reset-keep-a-queued-email-change` was covered by this review and has no finding of its own; it stays in `review/` pending the user's call.

**Owner:** backend
**Created:** 2026-10-05
**Priority:** high

Filed at the architect archive of the password-reset account-state gate (archived 2026-10-05),
from its signal block's out-of-scope findings and two residual risks from the review. User
triage: "as recommended".

## Why

1. **A reset token outlives the email it was mailed to.** Only `routes/auth.ts` writes
   `reset_token`: `POST /reset-request` sets it, and `POST /reset` clears it on use or expiry.
   No UPDATE that moves the row's `email` touches it. A grep at filing found four:
   `routes/recover.ts` `POST /recover` and `POST /recover/verify`, and in `routes/settings.ts`
   the change-flow confirm in `GET /email/verify/:token` (`SET email = pending_email`) and the
   re-issue branch of `POST /email` for an unverified state G row. `POST /reset` selects by
   token alone, so the token keeps working for the rest of its hour.

   Example: someone controls a user's mailbox and requests a reset. The user recovers through
   ORCID with a new email and a new password. The outstanding token still rotates the password,
   and the reset stamps `sessions_invalidated_at`, which revokes the user's sessions.

   A narrower case: ORCID recovery without a new password sets `password_hash` to NULL and
   leaves the token. The reset gate refuses that token while the row has no password. If the
   owner sets a password through `POST /api/settings/set-password` within the token's hour,
   the token rotates it.

2. **An unverified state G row with a password still gets a reset link.** A state G row
   (ARCHITECTURE.md § 6.1) whose settings-registered email is unverified has `username` set
   and a hex `verify_token`. `POST /api/settings/set-password` refuses such a row, so one with
   a password is a legacy row. Reset mails the link to an address the row never proved, so
   whoever holds that address sets the password, and `POST /api/auth/login` logs in a G row
   with a password whatever its email state. The user's state G decision is that an unverified
   G row may not acquire auth factors. A G account signs in with Keychain, so refusing it a
   reset leaves its owner a way in. `tests/routes/auth-reset-account-state.test.ts` pins this
   row as rotating ("G, email unverified, with a password (legacy shape)"); that spec flips.

3. **The reset-request answer promises a link that does not come.** `RESET_REQUEST_OK_MESSAGE`
   ("If an account exists with that email, a reset link has been sent.") is false for a
   passwordless account, and after item 2 for an unverified G row: the account exists and no
   link is sent. The answer must stay identical for every caller.

## Scope

1. Measure first: list every statement in `backend/src` that writes `accounts.email` or sets
   `accounts.password_hash` to NULL. The list under Why is from a grep at filing; go by your
   measurement.
2. Every UPDATE that changes `email` or sets `password_hash` to NULL also sets
   `reset_token = NULL, reset_token_expires_at = NULL`.
3. `POST /reset-request` and `POST /reset` refuse an unverified state G row the way they refuse
   a passwordless row, at both ends: the unknown-email answer and no token at `/reset-request`,
   the unknown-token `INVALID_TOKEN` answer and an unchanged row at `/reset`. Put the new term
   where the password gate sits (the lookup predicate and the UPDATE predicate), so a refusal
   stays the unknown-email and unknown-token code path.
4. Narrow `RESET_REQUEST_OK_MESSAGE` so it is true for every row reset-request refuses and
   identical for every caller. Suggested: "If an account with a password exists for that email,
   a reset link has been sent." (intent only: after Scope item 3 an unverified G row with a
   password gets no link either; write the sentence against the code). No emdashes. The UI
   shows its own copy, changed by `ui-reset-request-copy-promises-a-link`. Leave a TODO for the
   architect: `api-contracts/auth.md` quotes the message.
5. Comments these changes make false: fix each by deleting the claim or cutting it to what the
   code does, not by listing the new exceptions.
   - `routes/auth.ts`, the `/reset` UPDATE comment: "It also refuses a token that outlived its
     row's password: ORCID recovery without a new password drops the hash and leaves the token
     in place." After Scope item 2 the recovery clears the token.
   - "gates on no account state but the password", in `routes/signup-verify.ts` (the `/link`
     stuck-recovery rationale) and `tests/routes/signup-verify-stuck-recovery.test.ts`. Scope
     item 3 adds an account-state term. The lookup SQL in `signup-verify.ts` stays
     byte-identical.
   - The header of `tests/routes/auth-reset-account-state.test.ts`: "standing in for one issued
     before the gate existed or for a password dropped while the token was outstanding." After
     Scope item 2 a dropped password clears the token.
6. Route tests against real Postgres: for each writer from Scope item 1, a token issued before
