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

## UI completion note (2026-05-26, commit 3f90107e)

The three **independent** requirements landed (consequences copy, seed-phrase
continuation message, post-delete session teardown). The fresh-auth proof-challenge
wiring is **deferred to a follow-up**, as the task's Dependency section permits:
`DELETE /api/settings/email` in `backend/src/routes/settings.ts` does NOT yet require
a `fresh_auth_proof` (the backend gate task has not landed), so there is nothing to
mint a proof against. **Architect: please split the fresh-auth-challenge wiring into
its own task** to be picked up once `backend-settings-email-delete-fresh-auth-gate`
lands (reuse the change-email proof-challenge UI pattern).

What landed:
- `deleteWarningLight`/`deleteWarningSelf` rewritten to state all PEvO-server account
  data is erased (email, login, notification preferences, recovery state) and that it
  cannot be undone; the affordance + confirm button relabeled to account-deletion
  framing (`emailDelete` → "Delete account", `emailDeleteConfirm` → "Permanently
  delete my account").
- New `deleteSeedPhraseContinuation` (light accounts only): the on-chain Hive account
  survives; a seed-phrase holder can import it into Hive Keychain and continue as
  self-custody. Grounded in ARCHITECTURE.md § 6.3.
- `handleEmailDelete` now tears down the session (`auth.disconnect()` +
  `notifications.stop()`, the same mechanism `header.js` logout uses) and routes to
  the landing page with an `accountDeleted` toast, replacing the optimistic
  `emailStatus` patch that left the user on a settings view bound to a dead account.
- i18n: 4 reworded keys re-stubbed (Updated) + 2 new keys (Added) across all 15
  non-English locales; STUBS.md sweep entries appended. No emdashes in new copy.

For the architect's triage: `settings.emailDeleted` is now an unreferenced i18n key
(the toast it fed was replaced by `accountDeleted`). Left in all 16 locales; flag if
orphaned-key removal is wanted.

Landing path note: implemented in a fan-out worktree whose harness-assigned base was
~141 commits stale; the parent cherry-picked the result onto current `main` as
`3f90107e`, resolving a STUBS.md sweep-ordering conflict (kept the intervening
`UI-AUTHOR-LIST-PREFILL-ON-REVISION` sweep + appended this task's two sweeps).
`npm run build` passes; verified `auth.disconnect()`/`notifications.stop()`/`navigate`
all still exist on current `main`; no existing test asserted the old delete behavior.
