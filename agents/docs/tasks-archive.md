## The signup verify link finalizes a signup without its password (archived 2026-10-07): one round, clean on the diff; the P3 and follow-ups filed, a pre-existing P1 filed high, contract and § 6.1 / § 6.3 applied

### Architect archive note (2026-10-07)

- **Review:** `/ce-code-review` full path on `c489e0ed` and `8e6a79cc` (branch-remote via a synthetic head holding only the six task files; base `c739f26c`; the interleaved ui commits excluded): correctness, security, adversarial (in-process, no cross-model peer), testing, project-standards, api-contract, reliability, learnings. Verdict "Ready with fixes": every Scope item, the architect note and AC 1 to 6 met; one P3 in the diff (no route-level argon2 error-class spec on `/verify`), validator confirmed. Baseline: the three verify suites, 3 files / 32 tests, exit 0. Testing's mutants: 7 of 10 killed; the three survivors are all Scope 3 (the unkeyed UPDATE the Notes allow, the 0-row branch, the cookie set before the UPDATE). `tests/eslint` 9 files / 146 tests green.
- **Triage (user: "as recommended"):**
  - Filed (security, pre-existing P1, merged with follow-up 3 and adversarial's reset detour): reset serves an ORCID-path F row with a password and row E, so an address owner can finish a signup someone else started -> `backend-reset-refuses-orcid-path-and-unverified-signup-rows` (high). `architect-password-reset-gate-docs` got a correction note and is deferred behind it.
  - Filed (the architect's own read, not probed): an ORCID-path signup can hold an address its owner never gave and block the owner's signup -> `architect-orcid-path-signup-holds-an-unproven-address` (normal).
  - Filed: the P3 argon2 spec, follow-up 2 (the expiry DELETE keyed on the id only) and a comment nit at the `/signup` refusal -> `backend-verify-link-argon-spec-and-expiry-delete-key` (low).
  - Filed: follow-up 1 (the SPA keeps a spent ORCID token after the new 400) -> `ui-signup-keeps-a-spent-orcid-token` (normal).
  - Dismissed: follow-up 4 (refusal position and 0-row branch unpinned), the state G `/verify` specs' unpinned unknown-token baseline, `verifyLimiter` being per IP only, and moving the ORCID branch's checks ahead of the nonce lookup.
  - Applied at archive: `api-contracts/auth.md` (the `/verify` body, rate limit and errors; the `/signup` unresolved-token 400; the stale 422 line), ARCHITECTURE.md § 6.1 (row E's password and the legacy NULL-hash shape) and § 6.3 (the E -> F edge needs the password). § 6.4 has no signup verify row.
- **Learnings checkpoint:** no entry contradicted; `conventions/mailed-credential-token-dies-with-its-address-and-credential.md` and the timing-equalization, wrapping-primitive and token-redeem entries are honored (learnings and correctness). No new entry now: the reset gate's proxy-column lesson waits for the reset task's archive, whose Notes carry it.

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

## Backend implementation signal (2026-10-07, commits c489e0ed, 8e6a79cc)

Both SHAs are ancestors of `main` (`git merge-base --is-ancestor` checked).

**Scope 1.** `POST /api/auth/signup` answers an `orcid_token` that is present, non-empty and does
not resolve with 400 `BAD_REQUEST` "Your ORCID verification is no longer valid. Please verify your
ORCID again." It runs right after the nonce lookup and before the duplicate-email pre-check, and
writes no row. Past it, the standard email path is reached only when no `orcid_token` was sent, so
the required-field checks (password policy included) have run and every row that path writes
carries a password. An empty-string `orcid_token` is not refused; it takes the standard path as
before.

**Scope 2.** `POST /api/auth/verify` takes `{ token, password }`. A missing or non-string password
answers 400 `VALIDATION_ERROR` "Password is required" before any lookup. The lookup and expiry
answers are unchanged. A pending row with `password_hash` NULL answers 401 `UNAUTHORIZED`
"Incorrect password" (architect note), and so does a wrong password, checked with `argon2.verify`
inside `runWithArgon2Slot` with the request abort signal; `handleArgonError` runs first in the
catch. Neither 401 writes the row or sets a cookie.

**Scope 3.** The confirm UPDATE is `WHERE id = $3 AND verify_token = $4` (the presented token).
A 0-row UPDATE answers the unknown-token 400. The binding cookie is set only after a 1-row UPDATE.

**Scope 4.** Both mails (signup and `/resend-verification`, which carry the same text) now say
"The link asks for the password you chose when you signed up. It expires in 24 hours."

**Acceptance.** New suite `backend/tests/routes/signup-verify-link-password.test.ts` (5 specs,
SMTP transporter mocked per the carve-out header; Postgres, Redis, argon2 and the routes real):
AC 1 (wrong password: 401, no cookie, whole row `toEqual` before; signup password: 200 `choose` +
cookie), AC 2 (missing and non-string password), the architect note's NULL-hash row, AC 3, and
both mail texts. The AC 1 401 half, AC 2 and AC 3 were observed red against the pre-change code
before the implementation. AC 4: the only backend callers of `/verify` were
`signup-verify.test.ts` (the log-shape spec) and three specs in
`settings-state-g-unverified-email.test.ts`; all now send a password. No backend spec builds a
passwordless E row for `/verify`, and none relied on an unresolved `orcid_token` falling through
`/signup` (the literal unresolvable tokens in other suites go to `/recover`). AC 5: `verifyLimiter`
(10 per hour per IP) is unchanged; no sentinel burn was added. AC 6: no new error code, no new
writer of `accounts.updated_at`.

**Verification.** `npm run typecheck` and lint clean. 7 route files (signup-verify-link-password,
signup-verify, settings-state-g-unverified-email, auth, auth-state-g-rows,
signup-verify-session-binding, signup-verify-orcid-binding-guard): 85/85 at c489e0ed;
`tests/eslint` 9 files / 146 specs green; after 8e6a79cc the new suite plus `tests/eslint`,
10 files / 151 specs, exit 0. A four-lens adversarial verification workflow ran against c489e0ed
in scratchpad copies: mutants deleting the `/signup` refusal, the wrong-password branch, the
missing-password check or the NULL-hash branch, reverting either mail sentence, or answering the
wrong password 400 are all killed. Dropping the `AND verify_token = $4` key survives every spec,
as the Notes allow; a race probe (a `pool.query` spy rewriting the row's token and hash between
the SELECT and the UPDATE) got the unknown-token 400 with no cookie and no confirm on c489e0ed,
and 200 plus a confirmed row with the unproven hash on the mutant.

**Fixed after that workflow (8e6a79cc), comment truth only.** `POST /api/auth/reset-request` and
`/reset` accept a pending row E (pinned as `rotates: true` in `auth-reset-account-state.test.ts`)
and rotate its password without touching `verify_token`. So the first commit's comments overclaimed:
a mailbox holder can reset the row's password and then pass `/verify`, and a reset landing between
the password check and the UPDATE still matches the token key. The `/verify` comments now claim only
what the gate proves (the mailed link alone does not confirm; the token key catches a signup
retry's rewrite), and the `signup-session-binding.ts` scope note keeps its mailbox-read caveat,
through the reset flow. The task's threat stays closed: a reset replaces the signer's password and
stamps `sessions_invalidated_at`, so the signer cannot log in to the finished account.

**Dev database (Notes).** No finalized light row came from a passwordless E row. The one row with
`username` set, `custody = 'light'`, no password and no ORCID is `login_nullhash_1776818046871`
(`@example.com`, created 2026-04-22), a leftover login-spec fixture. There are 0 pending rows with
a NULL `password_hash` and no ORCID.

**[TODO Architect] at review.**
- `agents/docs/api-contracts/auth.md`: the `/verify` request is `{ token, password }`; new errors
  400 `VALIDATION_ERROR` (missing or non-string password), 401 `UNAUTHORIZED` "Incorrect password"
  (wrong password, or a pending row with no password), and the 503 the argon2 semaphore can
  answer. `/signup`: the 400 `BAD_REQUEST` refusal of an unresolved `orcid_token`, which now
  precedes the duplicate-email 409; the line saying a same-`orcid_token` resubmit falls through to
  the 422 is stale.
- `agents/docs/ARCHITECTURE.md` § 6.1: row E lists `password_hash` SET only, while `/verify` now
  defends (hex token, username NULL, password_hash NULL), the shape `/signup` wrote before Scope 1
  for up to 24 hours after deploy. A note, or a decision to retire the NULL-hash branch once such
  rows are gone. § 6.3: the E → F edge is labelled as a link click; it now also needs the row's
  password. § 6.4 has no row for the signup verify link.

**Out of scope, for follow-up filing.**
1. UI: `frontend/src/pages/signup.js` `handleSubmit` has no branch for the new `/signup` 400
   `BAD_REQUEST`. On the ORCID branch it shows the generic `signup.submitFailed`, keeps the spent
   `orcidToken`, leaves `canSubmit` true, and every resubmit gets the same 400; the only exit is the
   clear-ORCID button. Two SPA comments there still say a same-`orcid_token` resubmit yields a 422.
   The SPA's wrong-password copy at `/signup/verify` points to a new signup and not to the reset
   flow, which also works on a pending row.
2. Backend, pre-existing: the `/verify` expiry branch deletes `WHERE id = $1` only. A signup retry
   that refreshes an expired E row between `/verify`'s SELECT and that DELETE loses its fresh row
   (reproduced in a scratchpad probe); the user has to sign up again. Same race class as Scope 3,
   which the task left out for the expiry branch.
3. Design question: should the reset flow serve pending rows E and F at all? It lets a mailbox
   holder take over a legitimate user's pending signup (reset, then `/verify`, then `/confirm` or
   `/link`). This predates the task.
4. Not pinned by any spec: the Scope 1 refusal's position before the duplicate-email pre-check, and
   the 0-row branch of the Scope 3 UPDATE (dropping it answers 200 with an `auth_token` no row
   carries; no security effect).

**Learnings checkpoint.** Grepped `agents/docs/solutions/` for `/api/auth/verify`, verify link,
mailbox, `signup_binding`, `orcid_token` and token-keyed writes. No entry is contradicted:
`mailed-credential-token-dies-with-its-address-and-credential.md` says the email signup upsert
requires a password, which was false before Scope 1 and is true now. No new entry: the reset-flow
interaction is carried by the `signup-session-binding.ts` scope note, and keying a write on what its
lookup read is already that entry's item 3.

**Simplify.** About 20 substantive changed code lines, under the `ce-simplify-code` threshold; a
manual pass found nothing to cut. Code review: left to the architect at intake, per
`agents/backend/CLAUDE.md`.

## Recovery and password reset leave this browser's revoked session in place (archived 2026-10-07): recovery and reset halves, one hold, clean re-review; one signal item folded, two dismissed, teardown-boundary entry refreshed

### Architect archive note (2026-10-07)

- **Review:** `/ce-code-review` full path on `9ca30584` alone (branch-remote, base `ba3b008f`; the five earlier commits were reviewed at the hold): correctness, project-standards, testing, julik-frontend-races, adversarial (in-process, no cross-model peer), learnings. Verdict "Ready to merge", no finding. The three mid-tier reviewers returned fast first passes and were re-tasked with explicit check lists. Testing's 10 mutants: 8 killed (each done-screen read put back on `method`, the seed write dropped, the arms' writes swapped, both writes reading the live tab, the `doneAction` seed branch removed); m8 and m10 (the seed write moved into `finally` or before the request) survive as behavior-equivalent, since `phase` flips only on success. Correctness confirmed both new specs fail against `ba3b008f`. Baseline: the two recover specs 40/40 in a `9ca30584` copy.
- **Hold item 1:** FIXED at `9ca30584` (`doneMethod`).
- **Signal triage (user: approved as recommended):**
  - Folded: `handleOrcidVerify` ignores `isSubmitting` -> scope item 4 and AC 5 on `ui-recover-orcid-start-subject-pin` (`18038620`).
  - Dismissed: a seed recovery started while signed in ends on a Sign in button (`/login` shows the signed-in screen); `handleSubmit` clears `error` before its guard (cosmetic, the submit button is disabled while a request is in flight).
  - Already done: the `POST /api/auth/reset` contract section documents the optional bearer and `session_ended`.
- **Learnings checkpoint:** `/ce-compound-refresh` on `conventions/await-is-not-a-teardown-boundary-unless-it-yields-to-a-macrotask-2026-09-03.md` (Update: its scrub-trigger paragraph now names `endResetSession`, `adoptRecoveredSession`, `handleRevokedSession` and the pre-send `endSessionIfExpired` path) and CONCEPTS.md Subject Teardown refined (`8119ab4e`). No new entry qualified: the `doneMethod` rationale lives in its comment.

**Owner:** ui
**Created:** 2026-09-30
**Priority:** high

## Why

`pages/recover.js` and `pages/reset-password.js` complete their flow without
touching the auth store. Both recovery arms await the API call and move to the
done phase, discarding the reissued token in the response. The reset route
returns no token at all. Each of these revokes every earlier session for the
