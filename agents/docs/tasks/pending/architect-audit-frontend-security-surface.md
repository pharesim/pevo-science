# Audit the frontend security surface

**Owner:** architect
**Created:** 2026-10-05
**Priority:** normal

## Why

No commit since 2026-08-01 has changed these files, so no current review has looked at them. Reviews of the code that tasks do touch keep turning up pre-existing defects there, among them the signup upsert that can overwrite a finalized account row and the settings verify handler that clears `verify_token` on whatever row carries it. This task reviews the files below as they stand.

Client-side key derivation and signing, the markdown renderer and URL/HTML escaping helpers, the ORCID redirect guard, and the verify, reset and accreditation-verify pages.

## Scope (line counts at filing)

- `frontend/src/pages/signup-verify.js` (649)
- `frontend/src/pages/reset-password.js` (185)
- `frontend/src/pages/settings-verify-email.js` (71)
- `frontend/src/pages/accreditation-verify.js` (191)
- `frontend/src/hive-keys.js` (106)
- `frontend/src/crypto.js` (32)
- `frontend/src/keychain.js` (41)
- `frontend/src/sign-request.js` (32)
- `frontend/src/password-policy.js` (20)
- `frontend/src/lib/orcid-redirect-guard.js` (83)
- `frontend/src/lib/safe-url.js` (23)
- `frontend/src/lib/escape-html.js` (15)
- `frontend/src/components/markdown-renderer.js` (75)
- `frontend/src/components/vouch-section.js` (201)

Total: 1724 lines.

## Method

`agents/architect/CLAUDE.md` "Audit tasks (existing code, no diff)". Audit the files at the HEAD current at pickup; a file that changed since filing is still audited whole.

## Done when

The findings are triaged with the user, accepted ones are filed as tasks with a priority or folded into an open task that covers them, the dispositions are recorded in this file, and the file is archived.
