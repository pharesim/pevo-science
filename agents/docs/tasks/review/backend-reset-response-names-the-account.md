# The password reset response does not name the account it reset

**Owner:** backend
**Created:** 2026-10-05
**Priority:** high

## Why

`POST /api/auth/reset` revokes every session of the account (the UPDATE
stamps `sessions_invalidated_at`) and answers with only a message. A browser
that is signed in when its user completes a reset there keeps the revoked
token until its next bearer request. That request, possibly the notification
poll minutes later, then tears every tab down with the signed-out message and
opens the sign-in prompt, unprompted.

The SPA should end that session at the moment of the reset, but only when it
belongs to the account that was reset: a session for another account must
survive. The response does not say which account was reset, and the reset
link carries only the token, so the SPA cannot tell. The user chose this fix
over a client-side probe on 2026-10-05. The UI task
`ui-recover-and-reset-leave-a-revoked-session-signed-in` waits on it in
`blocked/` for its reset half.

## Scope

1. Add `username` to the success `data` of `POST /api/auth/reset`: the reset
   row's `username`, which the handler already selects. The row type declares
   it nullable; check against `ARCHITECTURE.md` § 6.1 and § 6.3 (the reset
   transitions name states A and B only) whether a row without a username can
   reach a successful reset, and document the field as always present or as
   nullable to match.
2. Record the field in the `POST /api/auth/reset` section of
   `agents/docs/api-contracts/auth.md` (architect zone; the commit that edits
   it needs `[skip-zone-audit]`, or hand the line to the architect).
3. Move `agents/docs/tasks/blocked/ui-recover-and-reset-leave-a-revoked-session-signed-in.md`
   back to `pending/` once the field lands (root `CLAUDE.md` rule 6; a ui-slug
   move needs `[skip-zone-audit]`).

## Acceptance criteria

1. A successful reset answers `data.username` with the account's username.
2. The error paths are unchanged.
3. A test pins the field on the success response.

## Backend implementation signal (2026-10-07, commits 0aa0bf78, c1f23108, dccc0064, b56695ab, b5066a6b)

User decisions on 2026-10-07 replace scope item 1 and add one fix:

- **The response does not name the account.** A read-only check of every
  reset-token leak path (a skeptic pass could not refute it) found that
  `data.username` hands a party holding only the token the login identifier
  it lacks: the access log, the proxy log, browser history and sync, or an
  old mailbox after an email change. With the password it just set, that is
  a takeover of a light A/B account. The user chose a bearer match instead.
  The SPA may send its stored session token as `Authorization: Bearer`, and
  the success `data` carries `session_ended: boolean`, true only when the
  bearer verifies and names the reset account. A missing, foreign, forged or
  malformed bearer answers false and never fails the reset.
- **A reset token rotates a password once.** The rotating UPDATE also keys
  on `reset_token = $3` and returns `username`. Before, two redemptions that
  both passed the lookup both rotated the password and both answered 200.

Scope item 1's nullability question: rows with no username do reach a
successful reset (state E and email-path F, pinned by
`auth-reset-account-state.test.ts`). Under the boolean shape such a row
always answers `session_ended: false`.

What landed (0aa0bf78):

- `backend/src/routes/auth.ts`: `bearerNamesAccount`, and the UPDATE with
  `reset_token = $3 ... RETURNING username`. The fresh-auth sweep, the audit
  row and the session match read the returned username, and the token lookup
  no longer selects it.
- `backend/tests/routes/auth-reset-session-match.test.ts` (new): a bearer for
  the reset account answers true. Another account, another secret and not a
  JWT answer false, with the password still rotated. Two redemptions held at
  a row lock give one 200 and one invalid-token 400, and the stored hash
  matches the winner. Red before the fix: the field was missing, and both
  redemptions answered 200.
- `backend/tests/routes/auth-reset-account-state.test.ts`: the success `data`
  is asserted whole (`{ message, session_ended: false }`) for every
  resettable state.

Acceptance criteria, against the decided shape:

1. Replaced by the decision: a successful reset answers `session_ended`, not
   the username.
2. Error paths unchanged: same codes and messages. A second redemption of a
   spent token gets the existing invalid-token answer.
3. Pinned by the two test files above.

Verification: the two reset files 22/22 with `--retry=0`; the other
reset-route files plus `tests/eslint` 216/216; typecheck and lint clean. Full
backend suite: 15 failed, 2802 passed, all 15 in the six standing
pre-existing files (idempotency-real-haf 2, accreditation-idempotency 6,
papers-enrichment-parity-gate 1, profile-auth-bypass 3, reviews gate 2,
cast-hardening 1), none on the reset route. Simplify pass: one local test
helper (`hexToken`), five optional items skipped.

UI: `ui-recover-and-reset-leave-a-revoked-session-signed-in` moved from
`blocked/` to `pending/` with a note on the changed shape (b5066a6b).

[TODO Architect] `agents/docs/api-contracts/auth.md`, `POST /api/auth/reset`:

- Request: optional `Authorization: Bearer <session token>`. Never required,
  never answered with 401.
- Response `data`: `{ "message": "...", "session_ended": false }`.
  `session_ended` is true only when the bearer verifies and names the
  account the reset revoked.
- Errors: unchanged. A token redeems once, so a concurrent second redemption
  gets `INVALID_TOKEN`.
- The § 6.3 and § 6.4 reset rows still name A and B only; that gap is
  already filed as `architect-password-reset-gate-docs`.

Out of scope, for filing if wanted:

- The expired-token branch of `/reset` clears by `id` alone, so it could in
  theory clear a fresh token issued between its lookup and its clear.
  Considered and not built: the window is one round trip and the cost is one
  re-request.
- `accounts.reset_token` has no index, so the token lookup scans the table
  (pre-existing).
- `POST /api/auth/recover/verify` returns `username` with a session token,
  signup `POST /api/auth/verify` returns `email`, and accreditation
  `POST /verify` returns `username`. Not assessed against the
  identifier-disclosure question this task raised; the first hands back a
  session for the account anyway, and the last is authenticated.
- `auth-reset-account-state.test.ts` has no row for the combined
  ORCID+email+password F shape (email, password and ORCID set, no username),
  which resets like email-path F.

Learnings checkpoint: new
`conventions/credential-setting-token-redeem-must-not-name-the-account.md`
(c1f23108; the same commit widens the CONCEPTS.md Session Invalidation entry
from light accounts to any account). New
`conventions/real-postgres-race-test-holds-the-row-lock-and-follows-the-blocker-chain.md`
(b56695ab). `/ce-compound-refresh` narrowed
`conventions/auth-gate-revives-pre-existing-read-side-oracle-2026-05-17.md`,
whose claim that a stolen JWT alone can broadcast no longer holds
(dccc0064). Other entries naming the reset route were checked; none is
contradicted.
