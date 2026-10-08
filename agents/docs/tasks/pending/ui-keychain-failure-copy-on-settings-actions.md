# Settings critical actions: say what went wrong when Keychain fails

**Owner:** ui
**Created:** 2026-10-08
**Priority:** normal

Filed at the architect review of `ui-state-d-session-settings-critical-actions` (the
implementer's follow-up 4). User triage: "as recommended".

## Why

A self-custody session now signs change-email, delete-account and the accreditation metadata
edit with Keychain (`settingsActionRequest` in `frontend/src/api.js`). When the sign fails
(Keychain is not installed, holds no posting key for the account, or the user cancels the
prompt), or when the user approves after the request's signature window has passed and the
backend answers 401, the page shows the action's generic failure copy
(`settings.emailUpdateFailed`, `settings.emailDeleteFailed`, `settings.metadataUpdateFailed`).
On a device without Keychain or without the key, trying again cannot help.

## Scope

1. Find what `signMessage` / `signRequest` reject with in each case, and what the backend
   answers for an expired request timestamp. Show localized copy for each case that names the
   next step (install or open Keychain, add the account's posting key, try again). If two cases
   cannot be told apart, give them shared copy and say so in your signal.
2. The copy says nothing beyond what the client observed.
3. New copy goes into every locale per the i18n convention.

## Acceptance criteria

1. Each distinguishable failure renders its own copy on each of the three actions, pinned by a
   unit test.
2. Frontend unit suite green; `npm run build` clean.
