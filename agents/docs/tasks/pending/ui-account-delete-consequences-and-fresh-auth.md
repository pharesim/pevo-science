# UI-ACCOUNT-DELETE-CONSEQUENCES-AND-FRESH-AUTH — make account-deletion consequences clear, log out after, and present the fresh-auth challenge

**Owner:** UI Agent
**Created:** 2026-05-26 (architect, from the user decision to gate `DELETE /api/settings/email`)
**Priority:** P2

## Problem

`DELETE /api/settings/email` erases the **entire** PEvO account (the `accounts` row, `notification_preferences`, `pending_recovery`; `custody_audit_log` is anonymized) — not just the email column. The current settings UI (`frontend/src/pages/settings.js` `handleEmailDelete`) under-represents this:

1. The confirmation copy frames it as removing an email, not erasing the account.
2. After a successful delete it optimistically sets `emailStatus = { hasEmail: false, custody, hasPassword }` and shows an "email deleted" toast — but the account row no longer exists, so the session is dead. The user is left on a settings page bound to a deleted account.
3. It does not present a fresh-auth challenge, which the backend will soon require on the JWT path (see Dependency).

## Goal

Rework the delete-account flow so the user understands what they're doing and the post-delete state is correct.

## Requirements

- **Clear consequences in the confirmation step** (the `showDeleteConfirm` affordance): state plainly that this erases all PEvO-server account data (email, login, notification preferences, recovery state) and that it cannot be undone. Verify the actual current copy first — do not assume; the UI agent confirms what `settings.js` renders today before rewriting.
- **Seed-phrase continuation message:** make clear the on-chain Hive account is NOT deleted. A user who still holds their BIP39 seed phrase can import it into Hive Keychain and continue using PEvO as a self-custody account. (Grounded in ARCHITECTURE.md § 6.3 account-deletion note: light accounts are seed-phrase-derived, so the Hive account is independent of the deleted PEvO row.) Frame as guidance, not a precondition.
- **Post-delete session teardown:** on success, log the user out / clear the session and route to a terminal state (landing or a "your account was deleted" page), instead of mutating `emailStatus` in place. The account is gone; the UI must not present a logged-in settings view afterward.
- **i18n:** all new copy goes through the existing `$t(...)` translation pipeline with keys, matching the surrounding settings strings. No emdashes in user-facing copy (root `CLAUDE.md`).

## Dependency / coordination

The backend gate `backend-settings-email-delete-fresh-auth-gate` will require a body `fresh_auth_proof` on the JWT path (mirroring change-email). The **fresh-auth challenge UI** (mint the proof via the password or ORCID path the account supports, then send it with the DELETE) integrates once that backend task lands — reuse the change-email proof-challenge UI pattern. The consequences-copy + post-delete-logout requirements above are **independent of the backend gate** and can land first. If you reach the proof-challenge wiring before the backend endpoint is ready, split it to a follow-up rather than blocking the rest.

## Non-goals

- Changing the backend deletion behavior or the endpoint name (backend-owned; tracked separately).
