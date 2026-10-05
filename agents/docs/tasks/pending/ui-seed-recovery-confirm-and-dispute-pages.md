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
