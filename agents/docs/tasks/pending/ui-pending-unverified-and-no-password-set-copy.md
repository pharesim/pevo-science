# Settings and ORCID flows: the unverified-email refusals and the no-password login answer

**Owner:** ui
**Created:** 2026-10-07
**Priority:** normal

Filed at the archive of the state G unverified-row lifecycle task (its `[TODO UI]` items 1 and
2). User triage: "as recommended".

## Why

The backend now refuses a state G row (ARCHITECTURE.md § 6.1: a Keychain account that registered
an email in settings) any new auth factor while that email is unverified, and login answers
every passwordless row with one message. The SPA does not handle either answer:

1. `POST /api/settings/set-password` answers 409 `PENDING_UNVERIFIED` ("Verify your email before
   setting a password.") for such a row. The settings page renders the set-password section
   whenever `emailStatus.hasPassword === false`, without looking at `verified`, so the section
   is offered to a row that will be refused.
2. `POST /api/orcid/start` and `POST /api/orcid/callback` answer 409 `PENDING_UNVERIFIED` for
   `mode='link'` and `mode='accredit'` on such a row. No ORCID link or accredit surface maps that
   code.
3. `POST /api/auth/login` answers 403 `NO_PASSWORD_SET` for a row with no password. The login
   page and the sign-in modal map `PENDING_UNVERIFIED` (a pending signup) but not this code.

See `agents/docs/api-contracts/settings.md`, `orcid.md` and `auth.md` for the current answers.

## Scope

1. Settings: offer set-password only when the status also says the email is verified, or map
   the 409 to copy that asks the user to verify the email first. Either way the user must not
   be left with a generic error.
2. ORCID link and accredit: map 409 `PENDING_UNVERIFIED` at `/start` and at the callback to copy
   that asks the user to verify, or remove, the email registered in settings.
3. Login and the sign-in modal: map 403 `NO_PASSWORD_SET` to localized copy that sends the user
   to another sign-in method. Say nothing about which methods this account has: the login form
   is unauthenticated.
4. New copy goes into every locale per the i18n convention.

## Acceptance criteria

1. Each of the three answers renders specific, localized copy, pinned by a unit test per
   surface.
2. No surface claims the account has a particular sign-in method or factor.
