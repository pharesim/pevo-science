# SPA must treat the /signup ORCID_ALREADY_LINKED 409 as terminal (ui)

**Owner:** ui
**Created:** 2026-06-14 (architect, from the Option-2 resolution of `backend-signup-orcid-dup-nonce-retry`)
**Priority:** P3 (UX correctness; no security impact)

## Problem

`POST /api/auth/signup` returns `409 ORCID_ALREADY_LINKED` when the supplied ORCID is
already bound to another account row (the `accounts_orcid_unique` index). This 409 is
**terminal**: the ORCID is genuinely taken, so a resubmit can never succeed, and the
single-use ORCID verification nonce is already consumed by the time the 409 is returned.
A blind same-`orcid_token` resubmit therefore falls through to the missing/invalid-token
`422` — a confusing dead-end for the user.

The backend deliberately does NOT extend the nonce lifetime (Option 2, decided 2026-06-14):
the SPA owns recovery. See the `ORCID_ALREADY_LINKED` (409) entry in
`agents/docs/api-contracts/auth.md` for the contract.

## Acceptance criteria

1. On a `/signup` response with `error.code === 'ORCID_ALREADY_LINKED'`, the SPA surfaces a
   clear terminal message — e.g. "This ORCID is already linked to a PEvO account. Log in
   instead." — and offers a path to log into the existing account (and/or to restart the
   ORCID OAuth flow from `/api/orcid/start` for a different ORCID).
2. The SPA MUST NOT blindly resubmit the same `orcid_token` after this 409 (that yields the
   confusing `422`). Mirror how the SPA already handles the `/orcid/callback`
   durable-binding 409 (it restarts the flow / routes to recovery rather than resubmitting).
3. Verify against the running backend: a duplicate-ORCID `/signup` shows the terminal copy
   and the recovery affordance, not a generic error or a silent retry loop.

## References

- `agents/docs/api-contracts/auth.md` — the `/signup` `ORCID_ALREADY_LINKED` (409) entry
  (includes the terminal-recovery semantics).
- Backend mapping: `backend/src/routes/auth.ts` `/signup` handler (the 23505 ->
  `accounts_orcid_unique` -> 409 branch). The SPA already handles the equivalent
  `/orcid/callback` durable-binding 409 — reuse that pattern.
- Origin: `backend-signup-orcid-dup-nonce-retry` (Option 2 resolution, archived 2026-06-14).

## UI delivery (2026-06-14, working tree) — moved to review/

Implemented in `frontend/src/pages/signup.js`:

- **AC1 (terminal copy + recovery affordance).** `handleSubmit`'s catch now
  branches on `err.code === 'ORCID_ALREADY_LINKED'`, setting a reactive
  `orcidAlreadyLinked` flag and the new terminal message
  `signup.orcidAlreadyLinked` ("This ORCID is already linked to a PEvO account.
  Log in to that account, or verify with a different ORCID."). The error panel
  renders a recovery row when the flag is set: a "Sign in" link to `/login`
  (reuses `signup.signIn`) and a "Verify with ORCID" restart button (reuses
  `signup.orcidVerifyButton`, runs `handleOrcidVerify`).
- **AC2 (no blind resubmit).** `canSubmit` returns false while
  `orcidAlreadyLinked`, so the gated `handleSubmit` cannot re-POST the consumed
  `orcid_token` (which falls through to the confusing 422). Mirrors the
  `/orcid/callback` durable-binding 409 handling. The flag clears on
  `handleOrcidVerify` (restart OAuth for a different ORCID) and `clearOrcid`
  (revert to the password branch).
- **i18n.** One new key `signup.orcidAlreadyLinked`, added to all 16 locales
  (English stub in the 15 non-en, tracked in `STUBS.md` under the
  `UI-SIGNUP-ORCID-ALREADY-LINKED-TERMINAL-409` sweep). No emdash, no crypto jargon.

Tests (`tests/unit/pages-signup.test.js`, 4 new; full frontend unit suite green
at 1529): terminal flag + message set with `submitted` staying false; canSubmit
false + a second submit does NOT re-POST; `handleOrcidVerify` and `clearOrcid`
both clear the flag.

**AC3 (verify against the running backend) — status.** The SPA contract is
unit-verified deterministically (the four cases above). The live duplicate-ORCID
round-trip (real 409 -> terminal copy in a browser) needs an account already
bound to the same ORCID, which requires the orcid-stub test stack to drive ORCID
OAuth in-network; it is not reproducible in a plain dev browser. Flagging for the
architect: if a live/E2E check is wanted, it shares the orcid-stub infra with the
`orcid-no-password.spec.js` round-trips and can be added as a follow-up E2E case.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
