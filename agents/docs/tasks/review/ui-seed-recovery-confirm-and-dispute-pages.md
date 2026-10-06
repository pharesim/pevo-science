# Seed-phrase recovery cannot be completed: its mailed links have no page

**Owner:** ui
**Created:** 2026-10-05
**Priority:** high

## Why

Seed-phrase recovery has two phases (`api-contracts/auth.md` § POST
/api/auth/recover, `ARCHITECTURE.md` § 6.3 and § 6.4). Phase 1,
`POST /api/auth/recover` with `memo_key`, changes nothing on the account. It
answers `{ recovery: 'pending_verification', message }` and mails two links,
built in `backend/src/routes/recover.ts`:

- to the new address, `/recover/verify?token=...`, whose
  `POST /api/auth/recover/verify` applies the staged email and password swap,
  revokes every earlier session, and returns a reissued session in the login
  envelope;
- to the old address, `/recover/dispute?token=...`, whose
  `POST /api/auth/recover/dispute` voids a staged swap within 48 hours.

The SPA has neither route. `router.js` knows `/recover` only, so both links
fall through `parsePath`'s unmatched-path fallback to the home page, and
`api.js` has no client for either endpoint. A seed-phrase recovery started
from the app can never be completed, and the old address's owner cannot stop
one. The phase-1 done screen also says the account "has been recovered with
the new email and password" and asks the user to sign in with the new
credentials, which fails, because nothing has changed yet.

Surfaced while working `ui-recover-and-reset-leave-a-revoked-session-signed-in`;
the user chose to track it here, at high priority, on 2026-10-05.

## Scope

1. **Phase-1 done screen.** Say that the change waits for confirmation and
   that a link went to the new address, which must be opened within 24 hours.
   The current `recover.doneDescription` is used by this arm only (see
   `recoverPage.doneCopy`); reword it in place or replace it, per the
   `STUBS.md` Added/Updated rule.
2. **`/recover/verify` page.** Read the token from the query, post it to
   `POST /api/auth/recover/verify`, and on success hand the response to the
   auth store's `adoptRecoveredSession`, the same handling the ORCID arm of
   `recoverPage.handleSubmit` uses: a browser signed out or signed in to the
   recovered account takes up the reissued session, and a browser signed in to
   another account keeps it, with the switch `recoverPage.doneAction` offers.
   Show the outcome and a next step to match. Map
   `INVALID_TOKEN` (one generic message for unknown, used, disputed, expired),
   `DUPLICATE` (the new email was taken meanwhile) and the 503 to localized
   copy. Decide whether the page posts on load or behind a confirm button: a
   mail scanner that renders the page would consume the single-use token on
   load.
3. **`/recover/dispute` page.** Read the token, post it to
   `POST /api/auth/recover/dispute`, and show the uniform success copy (the
   response does not say whether a swap had already applied). Map
   `INVALID_TOKEN` and the 503.
4. Router entries and page titles for both routes, `api.js` clients, and the
   copy in all sixteen locales per the stub convention.

## Acceptance criteria

1. A seed-phrase recovery started on `/recover` completes through the mailed
   link: the account takes the new email and password, and the browser that
   opens the link ends up as `adoptRecoveredSession` decides.
2. The dispute link stops a staged recovery and says so.
3. The phase-1 done screen no longer claims the account was recovered.
4. Unit tests pin both pages and the phase-1 copy. An E2E over the mailed
   links is the real-path companion. Only SHA-256 digests of the verify and
   dispute tokens are stored, so it reads the links from the test stack's
   Mailpit sink.

## UI implementation signal (2026-10-06, commits d297d2e4, cb8b610f)

Landed on main in two commits, each verified with
`git merge-base --is-ancestor <sha> main`:

- `d297d2e4`: the change: `verifyRecovery` / `disputeRecovery` in `api.js`,
  the `recover-verify` and `recover-dispute` pages and routes, the phase-1
  done screen, 22 new `recover.*` keys in all sixteen locales with
  `recover.doneDescription` removed from all sixteen, one STUBS.md Added
  sweep, the unit suites and the Mailpit E2E.
- `cb8b610f`: copy and comment fixes from a verification pass (listed
  below), and the E2E fixture's `fullName` after it moved onto
  `seedLightAccount`.

**Decision taken with the user before implementing:** the E2E seeds the
account's encrypted memo key with `CUSTODY_ENCRYPTION_KEY` read from the
gitignored `frontend/.env.test` (process-env override
`E2E_CUSTODY_ENCRYPTION_KEY`), documented in `frontend/.env.test.example`
the same way as `SESSION_SECRET`. The fixture
(`tests/e2e/fixtures/recoverable-account.js`) copies the backend's HKDF +
AES-256-GCM `encryptKey`; drift fails phase 1, so the spec catches it.

**Decisions the task left to the implementer:**

1. **Both pages post only from a button.** Opening `/recover/verify` or
   `/recover/dispute` reads the token and sends nothing; "Confirm recovery" /
   "Stop the recovery" sends it. A mail scanner that renders the page would
   otherwise spend the single-use confirm link (and receive the reissued
   session), or stop every recovery from the old mailbox, the owner's own
   included. Unit tests pin "nothing sent on open"; the E2E asserts no
   `POST /api/auth/recover/verify` before the click.
2. **Phase-1 copy replaced, not reworded.** `recover.doneDescription` was
   translated in all fifteen locales and its meaning changes from "done,
   sign in" to "pending, confirm from the new mailbox", so it is removed from
   all sixteen files and the seed arm uses new `recover.seedPendingTitle` /
   `recover.seedPendingDescription` (Added sweep, no Updated entry). The seed
   arm also gets its own title and an envelope icon: `recover.doneTitle`
   ("Account Recovered") stays on the ORCID arm, where it is true. The
   button stays "Sign in": the old credentials still work until the link is
   opened, which the copy says.
3. **Error mapping.** `INVALID_TOKEN` -> one unusable-link state (also used
   for a link without a token, which sends nothing); `DUPLICATE` -> its own
   state with a way back to `/recover`; everything else, including the 503
   (it arrives as `INTERNAL_ERROR`, the same code as the 500, and
   `ApiRequestError` carries no status), `RATE_LIMITED` and network or
   timeout failures -> one retriable state that posts the same token again.
   The dispute page has no `DUPLICATE` arm.
4. **Session on the verify page.** The answer goes to
   `adoptRecoveredSession`, as in the ORCID arm: signed out or signed in to
   the recovered account -> signed in, "Go to Settings"; signed in to another
   account -> kept, with "Switch to the recovered account". The reissued
   session is taken up even if the page was left mid-request, since the
   server has already spent the link and revoked the other sessions.
5. **Dispute copy.** The page never shows the server's message ("No change
   has been made to your account" is false after an applied swap). Its done
   heading is "Request received" and the body covers both outcomes, with a
   Contact Us link for the already-confirmed case.

**Scope 1 / AC3.** `recoverPage.doneCopy` seed arm: `seedPendingTitle` +
`seedPendingDescription` ("Nothing has changed yet ... a confirmation link
to your new email address. Open it within 24 hours ..."). Pinned in
`pages-recover.test.js`; the E2E asserts the "Check your new email" heading
after a real phase 1.

**Scope 2 / AC1.** `recover-verify.js`. Unit: `pages-recover-verify.test.js`
(states, single post while in flight, error mapping, retry, teardown, every
template key resolves in en.json) and the real-store matrix added to
`pages-recover-session.test.js` (same account: token replaced, proof window
dropped, later bearer requests send the new token; signed out: signed in, no
bearer on the verify request; another account: kept until the switch). E2E
`seed-recovery-links.spec.js` test 1: phase 1 on `/recover`, confirm link
read from Mailpit, click, then the DB row has the new email and a new
password hash, `pevo_session` holds the reissued token, and
`POST /api/auth/login` with the new email and password answers 200.

**Scope 3 / AC2.** `recover-dispute.js`, `pages-recover-dispute.test.js`.
E2E test 2: stop link from the old address's mail, click, then the confirm
link answers 400 and shows the unusable-link state, and the account row is
unchanged.

**Scope 4.** Routes `recover-verify` / `recover-dispute` (bare and
locale-prefixed, `router.test.js`), titles "Confirm Recovery - PEvO" /
"Stop Recovery - PEvO" (hyphen, as the `admin` entry), registry rows in
`pages/index.js`, clients pinned in `api.test.js` (no Authorization header).
i18n: key sets identical across all sixteen files (1292 keys), every new key
equals the English in the fifteen others, 330 STUBS.md lines (15 per key).

**Verification run.** Full frontend unit suite: 94 files, 2222 tests, exit 0.
E2E on the test stack (fresh bundle via `./deploy.sh restart`):
`seed-recovery-links.spec.js` 2/2 and `orcid-no-password.spec.js` 7/7.
Stack restored to dev routing afterwards.

**Verification pass (five lenses, one refuter per finding; 21 agents, none
died).** Fixed in `cb8b610f`: the stop page's done heading "Recovery
stopped" was false when the recovery had already been confirmed (now
"Request received"); the retriable copy promised "in a moment", false for
the hourly limiter's 429 (now "later"); both unusable-link texts now include
an incomplete link, and the confirm page sends a user who started more than
once to the newest email rather than to start over; four comments narrowed
(fixture drift answers 500, not 401; the CSP excludes the Mailpit address
rather than all other origins; APP_URL need not differ from the base URL;
the api test's reason); the STUBS.md sweep prose no longer says `startAgain`
is on both pages. Three findings were refuted (no defect today: a
leak-sentinel assertion, template-wiring coverage, and a "dead end" on the
stop page's invalid state, which keeps the footer's Contact link). The
mutation lens killed all fourteen planned mutants. Some extra probes survive
the unit suites: template wiring (a state name, the done text binding, the
confirm button's handler; the E2E covers the latter two) and the dispute
page's `_mounted` check in its catch, whose only effect is a console line
on a destroyed page.

**Out of scope, for follow-up filing:**

1. `api-contracts/auth.md` drift: the `/recover/verify` `INVALID_TOKEN`
   entry says the causes "collapse to one generic message", but the handler
   has three messages (invalid or expired / already used / expired, start
   again); the 500 `INTERNAL_ERROR` ("Account recovery failed", "Dispute
   failed") is undocumented. The UI maps on the code only.
2. Backend `POST /recover/dispute` answers "No change has been made to your
   account" after an applied swap too, where it is false (the UI no longer
   shows it).
3. Backend `POST /recover/verify` consume is not atomic (no `FOR UPDATE`, no
   `AND consumed_at IS NULL`): two concurrent posts both apply, and the
   second revokes the first's reissued session. The page's in-flight guard
   covers one tab only.
4. The mailed password-reset link is `/auth/reset?token=`, which the SPA
   does not route (it lands on home); `password-recovery.spec.js` drives
   `/reset-password?token=` directly. Nothing tracks it.
5. `signup-verify.js` and `settings-verify-email.js` post their mailed
   tokens on load, so a scanner that runs the page spends them.
6. Pre-existing E2E failures, unchanged by this work:
   `password-recovery.spec.js` and `seed-phrase.spec.js` fail at their first
   `form button[type="submit"]` click on the known strict-mode clash with the
   always-rendered reauth modal form.
7. Pre-existing: on a cold load (every mailed link) `initI18n` replaces the
   route title with `metadata.title`, so route titles show only after
   in-app navigation.
