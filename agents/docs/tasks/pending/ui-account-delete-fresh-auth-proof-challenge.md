# UI-ACCOUNT-DELETE-FRESH-AUTH-PROOF-CHALLENGE — mint and send a fresh-auth proof with the delete-account DELETE

**Owner:** UI Agent
**Created:** 2026-05-26 (architect, split from `ui-account-delete-consequences-and-fresh-auth` — the consequences-copy + post-delete-logout half landed and is held separately for a test green-up; this is the deferred proof-challenge half)
**Priority:** P2

## Problem

`DELETE /api/settings/email` erases the entire PEvO account. The backend gate
`backend-settings-email-delete-fresh-auth-gate` will require a body
`fresh_auth_proof` on the JWT auth path (mirroring change-email and set-password),
bound to a **delete-account** action target distinct from change-email so a proof
minted for one action cannot be replayed on another. The current settings UI
(`frontend/src/pages/settings.js` `handleEmailDelete`) sends the DELETE with no
proof, so once the gate lands the JWT path will return `401 FRESH_AUTH_REQUIRED`.

## Goal

Before issuing the DELETE on the JWT path, mint a fresh-auth proof via the factor
the account supports and send it in the request body. Reuse the existing
change-email proof-challenge UI pattern (do not invent a new one) — the
Keychain/self-custody path is fresh at the middleware and needs no body proof.

## Requirements

- **Mint the proof via the account's registered factor**, matching the backend
  per-state contract: state A → password, state B → password or ORCID, state C →
  ORCID, state D → preserved factors (Keychain path, no body proof). Mint paths are
  `POST /api/custody/fresh-auth` (password issuance) and `POST /api/orcid/callback`
  `mode='fresh_auth'` (ORCID issuance) — the same paths change-email already uses.
- **Send `fresh_auth_proof` in the DELETE body** on the JWT path. Verify the proof
  target is the delete-account action (not change-email) so the backend's
  target-binding check passes.
- **Handle `401 FRESH_AUTH_REQUIRED`** (proof absent/expired) by re-prompting for
  the challenge, and a target-mismatch / `403` by surfacing a generic localized
  error (follow the existing sanitization pattern — raw error to `console.warn`,
  generic message to the DOM).
- **Keychain path unchanged:** a fresh signed request with no body proof still
  deletes (no regression for self-custody / state-D users).
- **i18n:** any new copy goes through `$t(...)` with keys in all 16 locales + the
  STUBS.md sweep. No emdashes in user-facing copy.
- **Tests:** unit coverage that the JWT path sends a delete-account-targeted
  `fresh_auth_proof`, and that a 401 re-prompts rather than silently failing.

## Dependency / coordination

**[BLOCKED by Backend] — RESOLVED 2026-05-27 (moved to `tasks/pending/`)** — depended on
`backend-settings-email-delete-fresh-auth-gate` landing (it defines the delete-account
action target value, the proof contract, and the `401 FRESH_AUTH_REQUIRED` /
target-mismatch error shapes). Do not start the wiring against an unimplemented
contract — the action-target value and error shapes must be read from the landed
backend code / contract doc, not guessed.

**Resolution (architect, 2026-05-27):** the backend gate landed (commit `6dd1f8b5`) and
was archived after a clean round-2 re-review. `agents/docs/api-contracts/settings.md`
DELETE /api/settings/email now documents the `delete_account` fresh-auth proof
contract, the mint paths (`POST /api/custody/fresh-auth action='delete_account'` and
`POST /api/orcid/start mode='fresh_auth' action='delete_account'` then
`POST /api/orcid/callback`), and the `401`/`403 FRESH_AUTH_REQUIRED` error shapes;
ARCHITECTURE.md § 6.4 row "Delete account data / right-to-erasure" carries the
per-state proof matrix (A: password; B: password or ORCID; C: ORCID; D: preserved
factors). Read the action-target value and error shapes from those now-current docs
and the landed `settings.ts` DELETE /email handler.

## Cross-references

- Sibling (held, in `tasks/pending/`): `ui-account-delete-consequences-and-fresh-auth`
  — the consequences-copy + post-delete-logout half, plus a test green-up.
- ARCHITECTURE.md § 6.3 (one-way account-erasure exit), § 6.4 (critical-action
  re-auth proof contract — delete-account row), § 6.5 invariant #1 (JWT-only on a
  critical action is a defect).
- `frontend/src/pages/settings.js` change-email handler — the proof-challenge UI
  pattern to reuse.
