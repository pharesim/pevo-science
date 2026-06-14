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
