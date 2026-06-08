# UI-SETTINGS-ACTION-FRESH-AUTH-PROOF-CHALLENGE — build the settings-action fresh-auth proof-challenge flow once and wire all three critical actions

**Owner:** UI Agent
**Created:** 2026-06-08 (architect; canonical re-scope of `ui-account-delete-fresh-auth-proof-challenge`, which is folded into this task per the 2026-06-08 triage)
**Priority:** P1 — confirmed live light-account lockout (see Evidence). All three JWT-path critical settings actions reject today; this is a functional gap, not preemptive hardening.

## Problem (confirmed live, 2026-06-08)

All three critical settings actions enforce a body `fresh_auth_proof` on the JWT
(light-account) auth path at the backend, but the SPA sends none — so JWT-path users
get `401 FRESH_AUTH_REQUIRED` and cannot change email, set a password, or delete their
account. Keychain/self-custody users are unaffected (their signed request is fresh at
the middleware and needs no body proof).

The original `ui-account-delete-fresh-auth-proof-challenge` task assumed it could "reuse
the existing change-email proof-challenge UI pattern." That pattern does not exist:
change-email and set-password are in the *same* unwired state as delete-account. This
task therefore builds the flow ONCE and wires all three, rather than three bespoke
implementations.

### Evidence

- Backend gates live: `backend/src/routes/settings.ts` — `POST /email` (change-email)
  reads `fresh_auth_proof` and 401s on absent/invalid; `POST /set-password` likewise;
  `DELETE /email` (delete-account) likewise. Each binds a distinct `action` target
  (`change_email` / `set_password` / `delete_account`) so a proof minted for one action
  cannot be replayed on another.
- UI sends nothing: `frontend/src/api.js` `submitEmail(email)` POSTs `{ email }` only,
  `setPassword(password)` POSTs `{ password }` only, `deleteEmail(confirm)` DELETEs with
  `{ confirm }` only. `frontend/src/pages/settings.js` imports none of the fresh-auth
  proof primitives for these actions (its lone fresh-auth reference is unrelated ORCID
  account-linking via `startOrcid('link')`).

## Goal

Build a single reusable settings-action proof-challenge flow and use it for all three
JWT-path critical actions. On the JWT path, before issuing the action request, mint a
fresh-auth proof via the factor the account supports, bound to the action's target, and
send it in the request body. The Keychain path stays unchanged (no body proof).

## Requirements

- **One reusable helper, three consumers.** Build the proof-challenge flow once (a
  `lib/`-level helper or settings-page primitive) parameterized by `action`
  (`change_email` | `set_password` | `delete_account`). `api.js` `submitEmail`,
  `setPassword`, and `deleteEmail` accept and forward the minted `fresh_auth_proof` in
  the body on the JWT path; the Keychain path passes nothing extra.
- **Mint via the account's registered factor**, matching the per-state contract in
  ARCHITECTURE.md § 6.4: state A → password; B → password or ORCID; C → ORCID; D →
  preserved factors (Keychain path, no body proof). Mint paths are
  `POST /api/custody/fresh-auth` (password issuance) and
  `POST /api/orcid/start { mode: 'fresh_auth', action: '<action>' }` then
  `POST /api/orcid/callback` (ORCID issuance) — read the exact action-target values and
  request/response shapes from the landed `settings.ts` handlers and
  `agents/docs/api-contracts/settings.md`, do not guess.
- **Per-action target binding.** The proof's `action` MUST match the action being
  performed (`change_email` for `POST /email`, `set_password` for `POST /set-password`,
  `delete_account` for `DELETE /email`). Verify a proof minted for one action is not
  reused on another — the backend target-binding check will 403 otherwise.
- **Error handling.** `401 FRESH_AUTH_REQUIRED` (proof absent/expired) re-prompts for the
  challenge; a target-mismatch / `403` surfaces a generic localized error (raw error to
  `console.warn`, generic message to the DOM — follow the existing sanitization pattern).
- **Keychain path unchanged.** A fresh signed request with no body proof still succeeds
  for self-custody / state-D users on all three actions (no regression).
- **Delete-account specifics (folded from the superseded task).** `DELETE /api/settings/email`
  performs one-way account erasure (ARCHITECTURE.md § 6.3); keep the existing `confirm`
  body field; the post-delete logout + consequences copy are tracked separately in the
  sibling `ui-account-delete-consequences-and-fresh-auth` (do not duplicate that half here).
- **i18n.** Any new copy goes through `$t(...)` with keys in all 16 locales + the STUBS.md
  sweep. No emdashes in user-facing copy.
- **Tests.** Per action: the JWT path sends an action-targeted `fresh_auth_proof`; a `401`
  re-prompts rather than silently failing; a target-mismatch `403` surfaces the generic
  error. Cover at least one password-factor mint and one ORCID-factor mint.

## Acceptance

- A JWT-path (light-account) user can change email, set a password, and delete their
  account end-to-end from the SPA — the `401 FRESH_AUTH_REQUIRED` lockout is closed for
  all three.
- The proof-challenge flow is implemented once and shared across the three call-sites
  (no three-way duplication).
- Keychain-path users continue to perform all three actions with no body proof (no
  regression).
- § 6.5 invariant #1 holds: no critical action is reachable with JWT-only and no proof.
- i18n keys present in all 16 locales; frontend build green; comment anchors clean.

## References

- `backend/src/routes/settings.ts` — the three handlers and their `fresh_auth_proof`
  enforcement + error shapes (source of truth for action-target values).
- `agents/docs/api-contracts/settings.md` — the documented proof contract, mint paths,
  and `401`/`403 FRESH_AUTH_REQUIRED` shapes for all three actions.
- ARCHITECTURE.md § 6.3 (one-way erasure), § 6.4 (per-state re-auth proof matrix),
  § 6.5 invariant #1 (JWT-only on a critical action is a defect).
- `frontend/src/api.js` — `submitEmail`, `setPassword`, `deleteEmail`,
  `authenticatedRequest`; `frontend/src/pages/settings.js` — the three handlers.
- `frontend/src/lib/fresh-auth.js` and `frontend/src/pages/orcid-callback.js`
  `_handleFreshAuth` — existing fresh-auth proof primitives (consent-op proof caching)
  to model the settings-action variant on.

## History

Supersedes `ui-account-delete-fresh-auth-proof-challenge` (was P2, blocked on an
architect re-scope). The 2026-06-08 triage confirmed all three settings actions are
unwired and that the backend gates are live (light-account lockout), so the work is
re-scoped to a single canonical pattern across change-email + set-password +
delete-account and elevated to P1.

## UI implementation note (2026-06-09)

Built the single reusable flow and wired all three actions:

- `frontend/src/lib/settings-fresh-auth.js` (new) — `withSettingsFreshAuth(action, ctx, run)`
  orchestrator: self-custody passes no proof; light path looks up the consent-op
  cache, else mints via the password factor (reauth modal + `POST /custody/fresh-auth`)
  when the account has a password and the action isn't `set_password`, else the ORCID
  factor (`beginSettingsActionOrcidFreshAuth` full-page round-trip). `401` missing/
  expired/malformed re-mints + retries once; `403`/`wrong_mechanism` → generic
  `settings.reauthFailed`; wrong password re-prompts once.
- `frontend/src/lib/fresh-auth.js` — added `beginSettingsActionOrcidFreshAuth` (sibling
  of `mintNonConsentProof`, `mode: 'fresh_auth'`); deduped the ORCID redirect-host
  allowlist into a shared module constant.
- `frontend/src/api.js` — `mintSettingsActionProof` (password factor) + threaded
  `fresh_auth_proof` through `submitEmail`/`setPassword`/`deleteEmail` (omitted on the
  Keychain path).
- `frontend/src/pages/settings.js` — `_freshAuthCtx()` + rewired the three handlers;
  set-password wipes the typed password on every exit (XSS hygiene).
- i18n: `settings.reauthPasswordPrompt` + `settings.reauthFailed` across 16 locales +
  STUBS sweep. The reauth modal (`index.html`, global) is reused as-is.
- Tests: unit (`lib-settings-fresh-auth.test.js` new, `api.test.js`, `pages-settings.test.js`)
  — full suite 1412 green. E2E `settings.spec.js` change-email test **un-fixme'd** and
  rewritten to drive the password-factor reauth modal end-to-end (it was disabled
  pending exactly this integration); both settings specs pass against the test-mode stack.

**For architect/backend (doc drift, out of UI zone):** `api-contracts/orcid.md` (the
"as of 2026-05-16" note) and `api-contracts/custody.md`'s action enum still say the
`change_email`/`delete_account` mint paths are "not live"/"a follow-up". The code
contradicts this — both routes allowlist all three settings actions today (the
`backend-change-email-mint-path-and-followups` follow-up has landed and is gone from the
task tree). These contract docs need updating to match the live code.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
