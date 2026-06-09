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

## Architect re-review (2026-06-09) — HELD PENDING FIXES

`/ce-code-review` ran on the implementing commit (10 personas). Strong positives:
project-standards clean (no emdash in the two new keys; both keys present in all 16
locales + STUBS; comment anchors clean; commit stays in the UI zone; account-state
branching maps to §6.1 states A/B/C), and security found no exploit (§6.5 #1 holds; the
cross-action target binding is defended in depth at both the cache and the backend;
password wiped on every exit path). Held on the following:

1. **(P1) The 401 re-mint+retry-once path is dead code, and the unit test masks it.**
   In `withSettingsFreshAuth`, the retry guard tests `err.status === 401`, but
   `ApiRequestError` (api.js) never sets a `status` field — it carries `code`,
   `details`, `data`, `retryAfterSeconds`. So the guard is always false: every
   `FRESH_AUTH_REQUIRED` short-circuits to `{ freshAuthFailed: true }` and the
   re-mint+retry-once behavior the task requires never runs. The `codedError` helper in
   `lib-settings-fresh-auth.test.js` fabricates a `status` field, so the test exercises a
   shape production never emits and passes green. Fix: gate the retry on
   `REMINTABLE_REASONS.includes(err.details?.reason)` — the preceding
   `err.code === 'FRESH_AUTH_REQUIRED'` check already establishes the class, and the
   reason set ({missing,expired,malformed}) is the retryable discriminator, so the broken
   `err.status === 401` conjunct can be dropped. Then remove the fabricated `status` from
   the test helper so the suite runs against the real `ApiRequestError` shape, and assert
   the retry path actually fires for an error constructed the way `api.js` throws it (the
   test must fail if a `status`-based gate is reintroduced). (A status-carrying
   `ApiRequestError` is the alternative, but it widens the error contract for all
   consumers; the reason-based gate is the smaller change and matches how the handler
   already discriminates by `code`.)

2. **(P2) `beginSettingsActionOrcidFreshAuth` re-inlines the redirect-host allowlist.**
   It uses the literal `['orcid.org', 'sandbox.orcid.org']` instead of the
   `ORCID_REDIRECT_HOSTS` module constant this same commit introduced and that
   `mintNonConsentProof` adopts. Replace the inline literal with the constant. (This is
   exactly the failure mode in the `convention-enforcing-fix-must-audit-its-own-new-code`
   learning: the dedup commit missed its own new call site. Same two hosts today, so it's
   divergence-prevention, not an active open-redirect.)

3. **(P2) Second wrong-password mint in `mintViaPassword` is unwrapped.** After a
   wrong-password re-prompt, the second `mintSettingsActionProof` call is outside the
   try/catch, so a second `UNAUTHORIZED` (or any transport error on it) escapes the
   orchestrator and surfaces the action's generic message (`emailUpdateFailed` /
   `emailDeleteFailed`) instead of `settings.reauthFailed`. Wrap the second attempt and
   map a second auth failure to the same cancelled / freshAuthFailed outcome the first
   attempt yields.

4. **(P2, test) `beginSettingsActionOrcidFreshAuth` has no direct unit test.** Its
   open-redirect host-allowlist rejection and `pevo_orcid_mode` / return-path
   cleanup-on-error run only behind the mock boundary in `lib-settings-fresh-auth.test.js`.
   Add a direct test mirroring `mintNonConsentProof`'s coverage: redirect to an
   allowlisted host; rejection of a non-allowlisted host without navigating; sessionStorage
   cleanup when `startOrcid` throws.

5. **(P2, test) Action-specific coverage is `change_email`-only.** The passwordless
   (State-C) `delete_account` ORCID-factor route and the 401/403 paths are not exercised
   for `set_password` or `delete_account`, so an action-name typo in a future refactor
   would go undetected. Add at minimum: a passwordless `delete_account` → ORCID-factor
   assertion, plus one 401-reprompt and one 403-generic case on an action other than
   `change_email`.

   Fold into item 1: once the retry branch is live, decide the ORCID-factor behavior on a
   401-on-arrival. Re-running `resolveProof` would re-trigger a full-page ORCID redirect,
   risking a re-OAuth loop near the 5-minute proof TTL. Prefer a terminal `freshAuthFailed`
   ("re-auth expired, try again") for the ORCID factor over a silent second redirect. This
   only manifests after item 1 restores the retry path.

**Verify (confirm; no change if already correct):** (a) `orcid-callback.js` dispatches on
the new `pevo_orcid_mode = 'fresh_auth'` value and lands the proof in the consent-op cache
keyed `(action, username, '')` — the settings ORCID-factor path has no E2E, so this is the
only guard that the round-trip resumes. (b) Test-stub `expires_at` is an ISO-8601 string,
not an epoch integer, per the `wire-contract-shape-pinned-on-backend-not-stub` learning.

**Considered and dismissed (P3, no action):** concurrent-action-while-modal-open silent
no-op (the refuse-while-open guard is a correct anti-cross-contamination safety; only the
missing feedback is suboptimal); `mintSettingsActionProof` one-line delegation wrapper
(harmless indirection); single-slot consent-op cache eviction by an unrelated action
(pre-existing by-design trait, not introduced here).

**Architect-handled (not your concern):** the `api-contracts/orcid.md` + `custody.md`
drift you flagged (`delete_account` enum + stale `change_email` "not live" note) was
corrected in this same review pass.

Re-review acceptance: items 1-5 landed; unit suite green against the real `ApiRequestError`
shape. `git mv` back to `tasks/review/` when done.

## UI re-review signal (2026-06-09, commit 41509a53)

All five hold items plus the item-5 fold-in landed in 41509a53. Per item:

1. (P1 dead 401 retry) `withSettingsFreshAuth` now gates the re-mint+retry on
   `REMINTABLE_REASONS.includes(err.details?.reason)`; the always-false
   `err.status === 401` conjunct is gone (`ApiRequestError` carries no `status` field,
   only `code`/`details`). The `codedError` test helper no longer fabricates a `status`
   field, so the suite runs against the real error shape — re-injecting a `status`-based
   gate fails the retry tests (verified empirically during the adversarial pass).
2. (ORCID host allowlist) `beginSettingsActionOrcidFreshAuth` now uses the shared
   `ORCID_REDIRECT_HOSTS` constant instead of an inline `['orcid.org','sandbox.orcid.org']`
   literal.
3. (second password mint unwrapped) The retry mint in `mintViaPassword` is wrapped; a
   second auth failure or any transport error on it maps to a new `MINT_FAILED` sentinel
   → `{ freshAuthFailed: true }` (surfaces `settings.reauthFailed`), instead of escaping
   as the action's own generic error. The first-attempt non-UNAUTHORIZED throw is left
   as-is (out of the flagged scope).
4. (no direct ORCID test) New `frontend/tests/unit/lib-fresh-auth-settings-orcid.test.js`:
   allowlisted-host redirect (sets `window.location.href`, returns the pending sentinel),
   sandbox host accepted, non-allowlisted + unparseable rejection WITHOUT navigating,
   sessionStorage mode-marker/return-path cleanup when `startOrcid` throws.
5. (action coverage) Added passwordless `delete_account` → ORCID factor, a 401-reprompt
   and a transport-fail second-mint on `delete_account`, a 403 on cached `set_password`,
   and the ORCID-factor 401-on-arrival terminal-`freshAuthFailed` guard (no silent second
   ORCID redirect — re-OAuth-loop near the 5-minute TTL). Factor selection is centralized
   in `usesPasswordFactor` so the initial mint and the retry gate cannot drift.

Verify checks confirmed, no change needed: (a) `orcid-callback.js` dispatches
`pevo_orcid_mode = 'fresh_auth'` into `_handleFreshAuth`, caching the consent-op proof
keyed `(action, root_author, root_permlink)` = `(action, <username>, '')` for settings
actions, retrieved by `getCachedConsentOpProof(action, username, '')`; (b) the `fresh_auth`
callback tests stub `expires_at` as an ISO-8601 string (`'2099-01-01T00:00:00.000Z'`).

Full frontend unit suite green (1426 passed, deterministic across 5/5 repeat runs);
production build green. An independent 4-lens adversarial verification pass (control-flow,
auth/§6.5-bypass, error-propagation, test-rigor) found no refutation of the production
logic; §6.5 invariant #1 holds (no critical action reachable JWT-only with no proof).

Out-of-scope note for triage (NOT fixed here): `settings.js` `handleOrcidLink` and
`accreditation.js` still use an inline `['orcid.org','sandbox.orcid.org']` literal for
their own (non-settings-action) ORCID redirect flows. Pre-existing and outside hold item
#2's scope (which targeted `beginSettingsActionOrcidFreshAuth`). Adopting the shared
allowlist there would require exporting `ORCID_REDIRECT_HOSTS` from `fresh-auth.js` and
touching two more files in separate flows — flagging as a possible follow-up, not part of
this task.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>

## Architect re-review (2026-06-09, round 2) — 5 held items VERIFIED; HELD for one comment fix

Re-reviewed commit `41509a53` via `/ce-code-review` (9 personas; correctness/security/adversarial on
the session model). **All 5 held items landed and verify** with strong cross-persona consensus: the
dead 401 retry is now live and correctly gated on `REMINTABLE_REASONS` (the `err.status === 401`
conjunct is gone; the test no longer fabricates `status` and fails if a status-gate is reintroduced —
the `test-fabricated-error-shape-masks-dead-branch` convention is satisfied); `ORCID_REDIRECT_HOSTS` is
adopted and confirmed in scope; the second password mint is wrapped (`MINT_FAILED` → `freshAuthFailed`,
handled at both call sites); the new ORCID unit test covers allowlist-reject-without-navigating +
cleanup; action coverage is extended; `usesPasswordFactor` centralizes factor selection so the initial
mint and the retry gate cannot drift. **Security is clean** — §6.5 invariant #1 holds (no critical
action reachable JWT-only without a proof), the per-action target binding can't be bypassed, the cache
is cleared on every consume, and the password never leaks.

**HELD PENDING FIX — one in-scope item:**

1. **(P2) Correct the false clause-(c) claim in the new test header.**
   `frontend/tests/unit/lib-fresh-auth-settings-orcid.test.js` (header, the `Clause-c real-path
   companion` sentence) claims "the settings-action ORCID factor is driven end-to-end against the real
   backend by the E2E settings spec." It is NOT — `settings.spec.js` drives only the PASSWORD factor;
   the ORCID-factor settings path (`set_password`, passwordless `change_email`/`delete_account`) has no
   E2E. Per the test-mock carve-out, clause (c) needs EITHER a real-path companion OR a filed follow-up.
   Rewrite the sentence to state honestly that the ORCID-factor settings path has no E2E companion yet
   and that follow-up coverage is tracked — WITHOUT citing a task slug in the comment (the slug lives in
   the task tree, not the test source, per the comment-anchor convention). The filed follow-up
   `ui-settings-orcid-factor-e2e` is what formally satisfies the carve-out's clause (c).

**Out-of-scope follow-ups filed (NOT part of this task):**
- `ui-settings-orcid-factor-e2e` — E2E coverage for the ORCID-factor settings actions; closes the
  clause-(c) gap above.
- `ui-orcid-redirect-host-allowlist-sweep` — replace the two remaining inline
  `['orcid.org','sandbox.orcid.org']` literals in `pages/settings.js` `handleOrcidLink` and
  `pages/accreditation.js` with the shared `ORCID_REDIRECT_HOSTS` constant (the broader sweep you
  flagged; hold item #2 from the first round only targeted `beginSettingsActionOrcidFreshAuth`).

**Reviewed and dismissed (no action):** the first-attempt non-`UNAUTHORIZED` password-mint error
escaping `withSettingsFreshAuth` raw (4 reviewers agree it is acceptable — no proof obtained, the action
never runs, §6.5-safe; the asymmetry vs the wrapped second mint is cosmetic); the `CANCELLED` sentinel
comment (it claims "no error toast," which is accurate for both sentinels — the differing outcome shapes
are a separate matter). **Flagged for separate investigation (not blocking, pre-existing, outside this
commit's diff):** `orcid-callback.js` `destroy()` removes `pevo_orcid_return_to` while the fresh_auth
flow writes `pevo_fresh_auth_return_to` — needs a look at the two-key design before deciding if it is a
bug.

When the comment fix lands, `git mv` this file back to `tasks/review/` for a quick re-review.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
