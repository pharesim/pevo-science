# Signup client swallows the ambiguous BROADCAST_TIMEOUT envelope; surface a verify/retry affordance (ui)

**Owner:** ui
**Created:** 2026-06-15
**Related:** `backend-signup-finalize-timeout-extended-lock-409` (backend wire-shape (c));
`api-contracts/auth.md` (`/confirm`, `/link` 504 `BROADCAST_TIMEOUT`)

## Problem
`submitCreateAccount()` and `handleLinkAccount()` in `frontend/src/pages/signup-verify.js`
have code-blind catch blocks: they ignore `err.code` / `err.details`, collapse EVERY error
into the generic `seedPhrase.createAccountFailed` / `seedPhrase.linkAccountFailed` string,
and bounce back to the entry phase (`create-username` / `link-keychain`).

The backend signup-finalize path ALREADY returns a 504 `BROADCAST_TIMEOUT` ambiguous
envelope (`outcome: 'uncertain'`, `verify_before_retry: true`) on its genuine
broadcast-timeout and Redis-`unavailable` branches. Once
`backend-signup-finalize-timeout-extended-lock-409` (wire-shape (c)) lands, it ALSO covers the
self-held binding-lock case (a retry inside the ~120s lock-extension window after a timed-out
first attempt). Today the client swallows all of these into "account creation failed",
telling the user their bind failed when the broadcast outcome is actually uncertain and may
have landed (they might already be accredited).

The `orcid-callback.js` page already handles this shape (it branches on
`err.code === 'BROADCAST_TIMEOUT'`); the signup page never adopted it. The API client
(`frontend/src/api.js`) already populates `err.code` / `err.details` / `err.retryAfterSeconds`
on the thrown error for any non-2xx response, so the data is present — the signup handlers
just discard it.

## Acceptance criteria
1. In `submitCreateAccount()` and `handleLinkAccount()`, branch on
   `err.code === 'BROADCAST_TIMEOUT'` (optionally also `err.details?.outcome === 'uncertain'`)
   and render a distinct, non-terminal affordance — e.g. "We're confirming your accreditation.
   This can take a moment. Verify your accreditation or log in shortly." — instead of the
   generic failure copy and the bounce to the entry phase. Mirror the existing
   `orcid-callback.js` `BROADCAST_TIMEOUT` handling for consistency.
2. Preserve the existing sanitization posture: do NOT surface raw `err.message` (the create
   path derives keys from the BIP39 mnemonic; raw messages risk leaking key-adjacent material).
3. Do not regress the generic failure path for genuinely terminal errors (e.g. the
   cross-account terminal `409 ORCID_ALREADY_LINKED`, validation errors). Only the
   `BROADCAST_TIMEOUT` / ambiguous-outcome shape gets the new affordance.
4. Add i18n strings for the new copy, following the existing `seedPhrase.*` key convention.
5. Real-path / component test: a signup confirm (and link) whose finalize returns the 504
   `BROADCAST_TIMEOUT` envelope renders the verify/retry affordance and does NOT collapse to the
   generic failure or bounce to the entry phase.

## Notes
- This fixes the pre-existing genuine-timeout swallow too, not just the new held-lock case — so
  it has standalone value and is parallelizable with the backend task. Build/test against the
  genuine-timeout shape now; the held-lock trigger is covered automatically once backend (c)
  ships.
- Do NOT anchor code comments on this task's slug or a round number (the pre-commit anchor gate
  rejects it). Anchor on behavioral semantics (e.g. "ambiguous broadcast outcome — verify before
  retry").
- Out of scope unless trivial: the terminal cross-account `409 ORCID_ALREADY_LINKED` on the
  signup path is also swallowed into the generic message; clearer "this ORCID is already linked
  to another account" copy would help, but is separate copy debt.
