# The signup verify link finalizes a signup without its password

**Owner:** backend
**Created:** 2026-10-05
**Priority:** high

Surfaced as a residual risk in the architect review of
`backend-signup-upsert-overwrites-finalized-row`. The user asked for this task on 2026-10-05.
The UI half is `ui-signup-verify-asks-for-the-signup-password`.

## Why

`POST /api/auth/signup` accepts any address. On the email path it stores the caller's password on
a pending signup row E and mails the address a verification link. `POST /api/auth/verify` takes
only the token from that link. It confirms the row, mints the signup session binding for the
browser that presents the token, and returns the `auth_token`. Neither `/confirm` nor `/link`
asks for the password, and both keep the row's `password_hash`. In ARCHITECTURE.md § 6.3,
`/confirm` finalizes the email-path row into A, a light account that keeps its signup password,
and the `/link` finalize writes neither `password_hash` nor `orcid`.

So anyone can sign up with someone else's address and a password of their own choosing. If the
address owner clicks the mailed link and finishes the signup, through `/confirm` or `/link`, the
person who signed up can log in to the finished account with the address and that password. The
state G eviction, which `/signup` performs for a factor-less unverified settings address, makes
this easier to aim: the evicted Keychain user is waiting for a verification mail, and settings and
signup both mail the subject "PEvO - Verify your email".

Requiring the password the row was created with at `/verify` closes this. The person who signed up
knows it. An address owner who never signed up does not know it, so a link sent to them can no
longer finalize the signup. `/resume-signup` already gates the confirmed-but-unfinished row the
same way.

The requirement only holds if every row `/verify` can match has a password. ARCHITECTURE.md § 6.1
lists E with `password_hash` SET, but `/signup` can write an E row without one. A request with an
`orcid_token` that no longer resolves leaves `verifiedOrcid` NULL. That happens when the nonce has
expired (`ORCID_VERIFIED_TTL` is 30 minutes) or was spent by an earlier submit, because the
lookup deletes it on read. Such a request skips the standard path's required-field checks, since
those run only when no `orcid_token` was sent. An institutional address passes the accreditation
gate, and the request falls through to the standard email upsert. When no password was sent,
`passwordHash` is NULL there.

## Scope

1. **`POST /api/auth/signup`: refuse an `orcid_token` that does not resolve.** When `orcid_token`
   is present and non-empty and `verifiedOrcid` is NULL after the lookup, answer 400 before the
   duplicate-email pre-check. Use an existing error code and a message that tells the user to
   verify their ORCID again. Write no row. The refusal does not depend on the address, so it is
   not a registration-status signal. After this change, every row the email path writes carries
   a password.
2. **`POST /api/auth/verify`: require `password`.** The body is `{ token, password }`.
   - A missing or non-string `password` answers 400 `VALIDATION_ERROR`, as `/resume-signup` does.
   - The token lookup and the expiry branch keep their current answers.
   - Then verify the presented password against the row's `password_hash` with `argon2.verify`
     inside `runWithArgon2Slot`, with argon errors going through `handleArgonError`, as in
     `/resume-signup`.
   - A wrong password answers 401 `UNAUTHORIZED` with a message saying the password is
     incorrect, and leaves the row as it was: no confirm, no new binding, no delete, no
     `Set-Cookie`. 401 gives the SPA a status it can tell apart from the 400 token answers, so it
     can keep the link usable and let the user retry.
3. **Key the confirm UPDATE on the presented token.** The UPDATE that writes the `confirmed:`
   token and the binding hash currently matches `WHERE id = $3` only. A re-signup for the same
   address can rewrite the row's `password_hash` and `verify_token` (the upsert's `DO UPDATE` on
   E) after the password check read it. The confirm would then finalize the row with a password
   the presenter never proved. Add `AND verify_token = <presented token>`. When it matches no row,
   answer what an unknown token answers.
4. **Verification mail text.** The email-path signup mail in `routes/auth.ts`, and the
   `/resend-verification` mail if it uses separate text, should say that the link asks for the
   password chosen at signup.

## Acceptance criteria

1. A route spec signs up an address with password P1, then calls `/verify` with the mailed token
   and a different password. It asserts 401 `UNAUTHORIZED`, no `pevo_signup_session` cookie, and
   the row unchanged (same hex `verify_token`, same `signup_binding_hash`). The same spec with P1
   gets today's 200 `choose` answer and the cookie. The 401 half fails against the current code.
2. A route spec posts `/verify` without `password` and gets 400 `VALIDATION_ERROR` with the row
   unchanged.
3. A route spec posts `/signup` with an institutional address, no password, and an `orcid_token`
   that does not resolve. It asserts the 400 refusal and that no row was written for the address.
   This spec fails against the current code.
4. Every existing spec that calls `/verify` sends the signup password. Where a spec built its E
   row without a password, it now builds one with a password.
5. Timing: no address is sent to `/verify`, so the new branches carry no email-enumeration oracle.
   The token is 32 random bytes (`crypto.randomBytes(32)`), so a fast answer for an unknown token
   tells nothing to anyone who does not already hold a valid one. No sentinel burn is needed on
   the unknown-token branch. State in the signal block whether the existing `verifyLimiter`
   (10 per hour per IP) is unchanged.
6. No new error code. No new writer of `accounts.updated_at`.

## Notes

- The UI half landed first (`e2334dd4`, archived 2026-10-06): the SPA already sends
  `{ token, password }`.
- A spec for the scope 3 interleave is not required.
- **[TODO Architect] at review:** update `agents/docs/api-contracts/auth.md` (`/verify` request
  and errors, the `/signup` refusal) and the § 6.4 row for the signup verify link, if § 6.4 lists
  one.
- Out of scope: finalized light rows that already came from a passwordless E row (no password, no
  ORCID). Report in the signal block whether the dev database has any. Do not repair them here.

**Architect note (2026-10-06), from the review of the UI half:** a pending row with `password_hash`
NULL can reach `/verify`. `/signup` writes one when an `orcid_token` no longer resolves and no
password was sent. Scope 1 stops new ones, but a row written before it deploys keeps its mailed
token until the row expires, 24 hours after the signup that wrote it. `argon2.verify` throws a
`TypeError` on a NULL hash; `/resume-signup` guards the same case. Answer such a row with the
wrong-password 401 and leave the row unchanged. On a 401 the SPA shows its wrong-password copy,
which points to a new signup with the same address. On a 500 it shows its retry message on every
attempt.
