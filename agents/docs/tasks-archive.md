## Real-path e2e coverage for the revoked-session teardown (archived 2026-10-07): one round, clean on the diff; the P3 and two residual risks filed with the implementer's follow-up, a pre-existing editor bug filed normal

### Architect archive note (2026-10-07)

- **Review:** `/ce-code-review` full path on `11b17105`, `c6956907` and `75e82606` (branch-remote via a synthetic head holding only the seven task files; base `c489e0ed`; interleaved sibling commits excluded): correctness, adversarial (in-process, no cross-model peer), testing, project-standards (re-tasked once after a shallow first pass), julik-frontend-races, learnings. Verdict "Ready to merge": Scope 1 to 4, the Notes, AC 1 and 2 and the architect note met; AC 1's live pass and the seven e2e mutants taken from the signal block and checked from source (no Playwright run in review). One P3 in the diff, validator confirmed. Correctness ran four unit files (122 tests) green in a scratchpad copy and re-derived the new solutions entry's counts and dates.
- **Triage (user: "approved" as recommended):**
  - Filed: the P3 (the toast stack clipped left of the screen below 25rem), the English-only uncaught-error toast and the implementer's follow-up 1 (the bridge queued title as banner and toast) -> `ui-toasts-now-render-follow-ups` (low).
  - Filed (pre-existing): the editor's image-upload toasts call `Alpine.store('i18n')?.t`, which the store lacks, so a signed-out paste and most upload failures show nothing -> `ui-editor-image-upload-toasts-call-a-missing-i18n-method` (normal).
  - Filed: the per-IP auth limiters against e2e retries (9 real logins per run against a limit of 10) -> `ui-e2e-auth-rate-limit-budget` (low).
  - Dismissed: the `custody-upgrade.spec.js` "Try Again" locator (no toast on that path), narrowing the expired-session clause (c) sentence (it claims only the shared `_endSession` teardown, which holds), the unpinned in-memory auth state (the unit suite pins it). Follow-up 2 (the standing e2e failures) is already covered by `ui-e2e-bare-submit-locators-clash-with-reauth-modal` and the rate-limit task.
- **Learnings checkpoint:** no entry contradicted (grep of every toast-mentioning entry for on-screen claims; `guard-report-dedupes-per-event-not-per-holder-2026-09-02.md` reasons from the store and holds). No new entry: the toast lesson is the implementer's `markup-outside-an-alpine-root-is-inert-and-store-assertions-cannot-see-it.md`, and the editor lookup lesson waits for its own task's archive.

**Owner:** ui
**Created:** 2026-09-30
**Priority:** normal

## Why

`frontend/tests/unit/session-revoked.test.js` drives the real request path,
auth store and teardown, but stubs `fetch` to produce the
`401 SESSION_INVALIDATED` answer. Its header states that no real-path
companion exists for the risk class (a second device's session outliving a
credential rotation). This task is that companion, per clause (c) of the
mocking carve-out in the root `CLAUDE.md`.

## Scope

One Playwright spec, two contexts, no mocked responses for the code under test.

1. Seed a light account (`fixtures/light-account.js`) and give a second
   browser context a session for it.
2. Revoke from "the other device" with a real password reset through the API
   request fixture. The reset token is read from the test database, as
   `password-recovery.spec.js` does.
3. Trigger a bearer request in the second context without reloading, for
   example an in-app navigation to the settings page.
4. Assert the response carried `SESSION_INVALIDATED`, the stored session entry
   is gone, the signed-out message is shown, and the sign-in modal is open
   with the reason inside it.

## Notes

- `seedUnaccreditedSession` uses an init script that re-seeds the stored
  session on every load. Seed once after the first navigation instead, or the
  "entry is gone" assertion is defeated.
- Do not install `installAuthedBootMocks` in the victim context. Those
  boot-time requests are a natural trigger.
- The always-rendered re-auth modal form makes a bare
  `form button[type="submit"]` locator ambiguous. Drive the reset through the
  request fixture and scope any form locator to its own page form.
- Keep trace, video and screenshot off: the spec handles a live token and
  passwords.

## Acceptance criteria

1. The spec passes against the test-mode stack and fails with the teardown
   hook removed.
2. The unit test header's clause (c) sentence is updated to name the spec.

**Architect note (2026-10-05):** `frontend/tests/unit/session-expired.test.js`
names this spec as its clause (c) real-path companion too, since the expired
session ends through the same `_endSession` teardown and sign-in offer. When
the spec lands, update that header's clause (c) sentence to name it as well,
alongside the `session-revoked.test.js` header in AC 2.

UI implementation signal (2026-10-07, commits `11b17105`, `c6956907`, `75e82606`):

- `c6956907`: `frontend/tests/e2e/session-revoked.spec.js`. A `browser.newContext()`
  context signs in to a seeded light account through `/login`. The `request` fixture,
  as the other device, resets the password (reset token read from the test DB). The
  header user menu's Settings link then navigates in-app, and the settings mount's
  bearer requests carry the revoked token. The spec asserts that the first 401 carrying
  that token is `SESSION_INVALIDATED`, that the signed-out toast (the `auth.sessionRevoked`
  copy read from `en.json`) is visible, that `pevo_session` is gone, and that the
  sign-in modal is open with the same copy in its notice. Nothing is stubbed and no boot
  mocks are installed. Trace, video and screenshots are off, and the login form locators
  are scoped to `[x-data="loginPage"]`.
- AC1: passes against the test-mode stack from the repo checkout with the baked bundle.
  Mutation runs from vite-dev scratch copies, with an unmutated control passing:
  - Removing the api.js `handleRevokedSession` hook fails at the toast assertion.
  - Dropping the sign-in offer fails at the modal.
  - Offering sign-in without the reason fails at the notice text.
  - Removing the teardown toast fails at the toast.
  - Keeping the storage entry fails at the storage check.
  - Reverting the toast root fails at the toast.
  - Using the expired copy fails at the toast.
- AC2 and the architect note: the clause (c) sentences in both `session-revoked.test.js`
  and `session-expired.test.js` now name `tests/e2e/session-revoked.spec.js`, and the
  spec's docblock names both unit suites, so the citation is two-sided.
- `11b17105` (asked first; the user approved fixing it in this task): the spec found
  that no toast has ever rendered. Since the SPA migration, the toast container in
  `frontend/index.html` sat outside every `x-data` root, so Alpine never initialized
  its `x-for`. A bare `x-data` fixes it.
  - Full-suite A/B: vite-dev copies differing only in that attribute, with the test DB
    re-prepared before each arm. Both arms show the same 13 failures and nothing new.
    The revoked-session spec went from failing to passing, and one test flaky in the
    baseline arm passed in the fixed arm.
  - A static sweep of e2e text locators against toast copy found one collision now that
    toasts render: the `bridge-import-queue.spec.js` 202 test's
    `getByText('Queued for publishing')` matched both the banner and the success toast
    `bridge.js` raises with the same key. It is now scoped to `[x-data="bridgePage"]`.
    That test times out earlier, at the Register button, in both arms (a pre-existing
    failure), so no live run reaches the rescoped locator.
- Pre-signal check: a four-lens, read-only verification workflow with a refuter per
  finding. Two findings survived. One was the bridge locator, fixed in `11b17105`. The
  other was a false retry-collision reason in the spec's `RUN_SUFFIX` comment, deleted
  before `c6956907`.
- All three SHAs are verified on main (`git merge-base --is-ancestor`), and their file
  lists match.
- Learnings checkpoint (`75e82606`, `[skip-zone-audit]`):
  - `/ce-compound` wrote
    `conventions/markup-outside-an-alpine-root-is-inert-and-store-assertions-cannot-see-it.md`.
  - `/ce-compound-refresh`, scoped to
    `completion-note-coverage-claim-run-suite-at-intake-2026-05-26.md`, narrowed
    "the account-deleted toast shown" to "queued on the toast store".
  - No other entry was contradicted.
- For the reviewer: toasts now render app-wide for the first time, so every existing
  `Alpine.store('toast').show` call site is user-visible as of `11b17105`.
- Out of scope, for follow-up filing:
  1. `bridge.js` shows `bridge.queuedTitle` as both the inline banner and a success
     toast, and `my-imports.js` also toasts it. Now that toasts render, users see the
     duplicate (a UX call).
  2. The 13 pre-existing e2e failures are unchanged by this task. Several are the
     bare-submit-locator class that `ui-e2e-bare-submit-locators-clash-with-reauth-modal`
     covers.

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
