# Reset tokens outlive email changes and recovery, and unverified G rows still get reset links

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
   the write is refused after it and the password is unchanged. The unverified G row with a
   password is refused at both ends, with the answers deep-equal to the unknown-email and
   unknown-token answers and the timing floor the existing suite asserts.

## Acceptance criteria

1. No UPDATE in `backend/src` changes `email` or sets `password_hash` to NULL without clearing
   both reset-token columns.
2. `reset-request` and `reset` refuse an unverified state G row exactly as they refuse a
   passwordless row.
3. The reset-request answer is true for every refused row and identical for every caller.
4. The completion signal lists the writers Scope item 1 found and the per-state outcome changes,
   so the architect can update ARCHITECTURE.md § 6.3/6.4 and `api-contracts/auth.md`. Do not
   edit those yourself.

## Note (2026-10-06, backend): land with the pending-email-change sibling

`backend-recovery-and-reset-keep-a-queued-email-change` edits the same three statements: the two
recovery UPDATEs in `routes/recover.ts` and the `POST /reset` UPDATE in `routes/auth.ts`. It adds
`pending_email = NULL, pending_email_token = NULL, pending_email_expires_at = NULL` to their SET
lists. Land both in one pass so each statement is edited once. Neither task closes the other's
path.

## Backend implementation signal (2026-10-07, commits 4196982f, e9f8214f, dbae925d; learnings 3611be12, 2230a1f8)

Landed in one pass with `backend-recovery-and-reset-keep-a-queued-email-change`, as the note above
asks, so each shared statement was edited once.

**Scope item 1, measured writers.** Three independent read-only sweeps (SQL text, column-name
trace, route-by-route walk) and a critic found seven statements in `backend/src` that write
`accounts.email` or can set `password_hash` to NULL. The filing listed the first four:

1. `routes/recover.ts`, `POST /recover`, ORCID method UPDATE: moves the email; NULL hash when no
   `new_password` is sent.
2. `routes/recover.ts`, `POST /recover/verify`, apply UPDATE: moves the email (`COALESCE` never
   NULLs the hash).
3. `routes/settings.ts`, `GET /email/verify/:token` change swap (`SET email = pending_email`).
4. `routes/settings.ts`, `POST /email` re-issue branch for an unverified state G row.
5. `routes/settings.ts`, `POST /email` SMTP-failure restore of that re-issue: writes the earlier
   email back.
6. `routes/auth.ts`, `POST /signup` ORCID+email upsert:
   `ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash`, NULL when the ORCID
   signup sends no password. It reaches a pending row E, which can hold a reset token.
7. `routes/auth.ts`, `POST /signup` email upsert, the same SET: replaces the hash (and NULLs it on
   the path in out-of-scope finding 1).

All seven now set `reset_token = NULL, reset_token_expires_at = NULL`. The two upserts clear it
unconditionally rather than only for a NULL hash: the retry replaces the row's password either way,
so a token issued against the replaced one has nothing left to rotate legitimately. Ruled out: the
add-flow INSERT and the ORCID-only plain INSERT (new rows), set-password (a non-NULL hash on a
hashless row), every DELETE, the custody upgrade, both signup finalizes, `orcid.ts` and
`accreditation-metadata.ts` (neither column).

**Scope item 3.** The `/reset-request` lookup and the `/reset` UPDATE carry
`AND (username IS NULL OR verify_token IS NULL)` beside the password gate. Against ARCHITECTURE.md
§ 6.1 it refuses exactly (username SET, verify_token non-NULL), the unverified state G row; E, F,
A to D and verified G are untouched. A refused row takes the passwordless row's code paths.

**Beyond the listed scope, found by a self-review and fixed in place.** `/reset-request` wrote its
token in a second UPDATE keyed on `id` alone, so a recovery or swap that commits between its lookup
and that write left a live token on the moved row: an in-flight form of Why item 1. The write now
re-checks `email = $4` and the lookup's gate. A 0-row write still mails and answers the same 200.
Pinned on the real path by holding the row lock (spec "an email move committing between
reset-request's lookup and its token write"), red against a copy keyed on `id` alone.

**Scope item 4.** `RESET_REQUEST_OK_MESSAGE` is now "If that email belongs to an account whose
password can be reset, a reset link has been sent." The suggested "If an account with a password
exists for that email" is false for an unverified G row with a password, so the sentence keys on
whether reset is available. It is true for every refused row and for an unknown email, and stays
one constant on both branches. No emdash.

**Scope item 5, comments.** The `/reset` UPDATE comment's "token that outlived its row's password"
sentences are deleted. "gates on no account state but the password" is deleted from the
`signup-verify.ts` `/link` rationale and from spec (h) of `signup-verify-stuck-recovery.test.ts`;
the lookup SQL is byte-identical. The `auth-reset-account-state.test.ts` header loses "or for a
password dropped while the token was outstanding" and now names the unverified G refusal. Also
narrowed: the `RESET_TOKEN_INVALID_MESSAGE` comment (no longer lists the refused rows), and the
settings SMTP-failure comments that said the request's write "rolls back", which the reset-token
clear no longer does.

**Per-state outcome changes (AC 4).**

- State G, email unverified, with a password: was rotate, now refused at both ends.
  `/reset-request` gives the unknown-email 200 with the sentinel burn and writes no token. `/reset`
  answers the unknown-token 400 and leaves the row unchanged; an expired token still gets the
  expired answer, as on a passwordless row.
- Every other § 6.1 state: unchanged. A, B, D with a password, verified G with a password, E and
  F (email path) rotate; C, D and G without a password, unverified G without a password and F
  (ORCID path) are refused.
- A reset token no longer survives: ORCID recovery with or without a new password, the seed-phrase
  recovery apply, the change-email swap, the settings re-issue and its restore, or a signup retry
  over a row E.

**Tests, real Postgres and Redis.**

- `tests/routes/reset-token-cleared-by-account-writes.test.ts` (new, 9 specs): one per writer
  (ORCID recovery twice, the passwordless one followed by the real set-password route; seed-phrase
  apply; change swap; re-issue then the new address verified; restore then the earlier address
  verified; both signup upserts) plus the race spec. Each issues a token (through `/reset-request`,
  or written directly where it refuses the row), runs the writer through its route, then asserts
  the row holds no token, `/reset` answers deep-equal to an unknown token, and the password is
  unchanged. All eight writer specs were red before the clears.
- `tests/routes/auth-reset-account-state.test.ts`: a `rotates` field per shape. The unverified G
  row with a password flips to refused at both ends, with deep-equal answers and the
  `TIMING_ORACLE_FLOOR_MS` floor; the refused `/reset` spec asserts the hash unchanged. Both specs
  were red before.
- Carve-out header of the new file: (a) the hive client key lookup stub (the signature path an
  unverified G row has), the SMTP mock, and the ORCID nonce and set-password proof written
  directly; (b) `verifyHiveSignature` real; (c) `recover.test.ts` [smtp-fail-test.invalid].
- Green, each file alone, exit 0, no Errors line: recover, recover-two-phase,
  recover-orcid-state-g, auth-reset-account-state, auth-reset-session-match,
  auth-reset-request-shutdown, session-proof-invalidation, settings-state-g-unverified-email,
  settings, auth-state-g-rows, auth, signup-verify, signup-verify-stuck-recovery,
  settings-email-fresh-auth, settings-set-password-fresh-auth, auth-signup-dup-saturated,
  auth-signup-argon-error-translation, auth-log-shape, signup-verify-session-binding,
  signup-verify-orcid-binding-guard, `tests/eslint` (146), and both new files.
- Full suite after 4196982f: 7 files / 15 specs red, all in the standing set
  (accreditation-idempotency, profile-auth-bypass, reviews gate, idempotency-real-haf,
  papers-enrichment-parity-gate, cast-hardening-author-index-weight, and
  fresh-auth-consent-op-burn-offline-queue under full-suite load). Typecheck clean; lint 0 errors,
  1 pre-existing warning in `lib/author-supersession.ts`.

**Out-of-scope findings, for filing.**

1. A standard email signup can write a row E with `password_hash` NULL, a shape § 6.1 does not
   have (E carries a password). Validation keys on `hasOrcidToken` (any non-empty `orcid_token`),
   the branch on `verifiedOrcid`: a non-resolving `orcid_token`, an institutional email and no
   password pass the relaxed validation and reach the standard upsert with a NULL hash.
2. The settings re-issue UPDATE is keyed on `username` alone. A verify click that lands between
   its lookup and its write has its now-verified row's email rewritten and a fresh hex
   `verify_token` installed, unverifying the row again; if the re-issued mail then fails, the
   restore writes back the prior `verify_token` the click already consumed.
3. `pending_email_token` has no index, so the change-verify lookup scans `accounts` (the
   `reset_token` index is already filed as `backend-reset-token-lookup-has-no-index`).
4. `auth-reset-account-state.test.ts` deletes only `accounts` rows; the `password_reset` audit rows
   its rotating specs write stay behind. Predates this change.

**[TODO Architect]**

- `agents/docs/api-contracts/auth.md`, `POST /api/auth/reset-request` response example: quote the
  new `RESET_REQUEST_OK_MESSAGE`.
- ARCHITECTURE.md § 6.3 and § 6.4: reset serves A, B, D and verified G with a password, plus E and
  email-path F; an unverified G row is refused with or without a password. The § 6.3 Option C
  note's "`POST /api/auth/reset` gates on no account state" is now false. Record that the seven
  writers above clear the reset token. `architect-password-reset-gate-docs` lists "G with a
  password (email verified or not)" as rotating: email verified only, now.

**Learnings checkpoint.** `/ce-compound` wrote
`conventions/mailed-credential-token-dies-with-its-address-and-credential.md`, with its catalog row
under the updated_at canary (3611be12). `/ce-compound-refresh` updated
`conventions/credential-setting-token-redeem-must-not-name-the-account.md`, whose leak list still
named an old mailbox after an email change (2230a1f8).
