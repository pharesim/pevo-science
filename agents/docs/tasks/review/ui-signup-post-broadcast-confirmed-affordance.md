# Signup finalize: surface the post-broadcast confirmed-outcome affordance (POST_BROADCAST_FAILED / POST_BROADCAST_OPERATOR_REQUIRED) and clear the stray username timer (ui)

**Owner:** ui
**Created:** 2026-06-15
**Related:** `ui-signup-broadcast-timeout-affordance` (the BROADCAST_TIMEOUT affordance this extends; archived 2026-06-15);
`frontend/src/pages/orcid-callback.js` (the full mirror); `api-contracts/auth.md` (`/confirm`, `/link` error lists);
`api-contracts/common.md` (POST_BROADCAST_* cross-resource client MUST)

## Problem
The prior task added `_handleAmbiguousBroadcastOutcome(err)` to `submitCreateAccount()` / `handleLinkAccount()`
in `frontend/src/pages/signup-verify.js`, branching on `err.code === 'BROADCAST_TIMEOUT'` to route to the
non-terminal `broadcast-pending` phase. It was specified to "mirror `orcid-callback.js`", but the mirror is
INCOMPLETE: `orcid-callback.js` also handles `POST_BROADCAST_FAILED` and `POST_BROADCAST_OPERATOR_REQUIRED`
with `details.outcome === 'confirmed'` (account already bound on chain; only a downstream cascade write failed),
routing both away from the retry/recover path. The signup create/link catches handle ONLY `BROADCAST_TIMEOUT`,
so for those two `POST_BROADCAST_*` confirmed codes the signup flow still falls through to the generic
"Could not create/link your account... try again" copy + a bounce to the username entry phase.

That is the exact misleading-copy + blind-retry failure mode the prior task existed to prevent, and it is arguably
worse here: on `POST_BROADCAST_*` with `outcome:'confirmed'` the account IS finalized AND the accreditation op
IS durable on chain, so "creation failed, try again" is plainly wrong. Both codes are reachable on `/confirm`
and `/link` (emitted by the shared `broadcastAccreditationAndSeed` cascade; see `auth.md` `/confirm` + `/link`
error lists and the orcid-callback.js handling at its `POST_BROADCAST_FAILED` / `POST_BROADCAST_OPERATOR_REQUIRED`
branches).

A small adjacent hygiene item rides along (architect review, bundled per user triage 2026-06-15): entering the
`broadcast-pending` phase does not clear the username debounce timer (`_usernameTimer`, armed in `watchUsername()`),
so a stale `_checkUsername` dhive call can fire ~400ms after the phase transition. It is harmless today (the
`_checkUsername` staleness guard suppresses any write and `broadcast-pending` never renders `usernameStatus`), but
it is a wasted live API call and `destroy()` already shows the one-line clear pattern.

## Acceptance criteria
1. In `submitCreateAccount()` and `handleLinkAccount()` (or inside the shared helper), handle
   `err.code === 'POST_BROADCAST_FAILED'` and `err.code === 'POST_BROADCAST_OPERATOR_REQUIRED'` when
   `err.details?.outcome === 'confirmed'`, routing to a non-terminal affordance instead of the generic
   failure + bounce. Branch ONLY on the contract code + the `outcome === 'confirmed'` discriminator (never on
   `details.failed_step` or `err.message` substrings) -- the same discipline `orcid-callback.js` uses. Per
   `common.md`'s cross-resource MUST, a client that handles `POST_BROADCAST_FAILED` MUST also handle the
   `POST_BROADCAST_OPERATOR_REQUIRED` sibling, so cover both in the same change.
2. Affordance copy: for both confirmed codes the account is set up and the accreditation op is durable, so the
   user should verify / log in, NOT retry. `POST_BROADCAST_OPERATOR_REQUIRED` carries the operator-contact framing
   (a permanent downstream failure; "give it a moment to sync" is misleading), matching the orcid-callback.js
   copy split (`orcid.postBroadcastFailedConfirmed` vs `orcid.postBroadcastOperatorRequired`). Reuse the
   `broadcast-pending` phase if its copy fits, or add a sibling phase/copy; decide against the orcid-callback.js
   precedent. Keep the sanitization posture: static i18n via `x-text` only, never raw `err.message`.
3. Do NOT regress the existing `BROADCAST_TIMEOUT` affordance or the terminal-error generic path (cross-account
   `409 ORCID_ALREADY_LINKED`, validation errors stay generic). The new branches fire only on the two
   `POST_BROADCAST_*` codes with `outcome === 'confirmed'`.
4. Add i18n strings for any new copy across all 16 locales (English stubs + STUBS.md sweep), following the
   `seedPhrase.*` key convention.
5. Clear the username debounce timer (`_usernameTimer`) when leaving the username-entry flow into the
   pending/confirmed affordance -- mirror the `clearTimeout(this._usernameTimer)` already in `destroy()`. Placing
   the clear inside the shared affordance helper covers the BROADCAST_TIMEOUT path too.
6. Component tests: a signup confirm (and link) finalize returning `POST_BROADCAST_FAILED` and
   `POST_BROADCAST_OPERATOR_REQUIRED` (`outcome:'confirmed'`) renders the verify/contact affordance and does NOT
   collapse to the generic failure or bounce to the entry phase.

## Out of scope
- The backend wire shapes for `POST_BROADCAST_FAILED` / `POST_BROADCAST_OPERATOR_REQUIRED` are unchanged and
  already documented in `auth.md` / `common.md`; this is a pure frontend consumer adoption.
- The missing `handleLinkAccount` negative-discriminator test (terminal code stays generic) was DISMISSED at the
  prior task's review -- the shared helper's discrimination is already pinned by the create-path test. Not part of
  this task unless the implementer is adding link-path coverage anyway and it is trivial to include.

## Notes
- Anchor any new code comment on behavioral semantics (e.g. "chain bind durable, app-side cascade failed -- verify,
  do not retry"), NOT on a task slug or round number (the pre-commit anchor gate rejects the latter).
