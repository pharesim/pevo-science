# UI-ORCID-SIGNUP-RECOVER-REAL-ROUNDTRIP — drive the ORCID signup/recover E2E specs through a real backend round-trip

**Owner:** UI (owns `frontend/tests/e2e/`)
**Created:** 2026-06-09 (split out of ui-orcid-stub-real-roundtrip-unfixme)
**Priority:** P3

## Context

`ui-orcid-stub-real-roundtrip-unfixme` un-fixme'd the ORCID **fresh_auth /
set_password** real round-trip against the `orcid-stub` OAuth sidecar (see
`settings-orcid-factor.spec.js`'s third test). Two `test.fixme` blocks in
`frontend/tests/e2e/orcid-no-password.spec.js` remain, both driving the ORCID
**signup** mode:

- `ORCID signup with password: null creates an account with password_hash = NULL`
- `ORCID recovery with new_password: null preserves password_hash = NULL`

## Why the existing stub does not unblock them

The signup-mode backend handler (`handleSignup` in `backend/src/routes/orcid.ts`)
calls `countExternalWorks(orcidId, ...)`, which fetches from a hardcoded
`pub.orcid.org` works URL and gates on `config.orcidMinWorks`. The `orcid-stub`
sidecar in `docker-compose.test.override.yml` only serves `POST /oauth/token`
(reflecting the submitted `code` back as the `orcid` field). It does NOT serve
the `pub.orcid.org` works endpoint, so the signup-mode works-count gate cannot be
satisfied in-network. The fresh_auth/set_password round-trip does not hit that
endpoint, which is why it was un-fixme'able and these are not.

## What this needs

A second in-network stub for the ORCID works API (the `pub.orcid.org` works URL
`handleSignup` reads), wired so the backend reaches it in the compose network the
same way `ORCID_BASE_URL` points at `orcid-stub`. Then drive both specs:
- signup ORCID branch end-to-end -> real `/api/auth/signup` accepts `password:
  null` -> `accounts.password_hash IS NULL` -> password login 403
  `NO_PASSWORD_SET` -> ORCID login succeeds.
- recover ORCID branch with `new_password: null` -> `password_hash` unchanged.

Confirm whether the works fetch host is configurable (env) or hardcoded; if
hardcoded, the stub wiring will need a backend-side seam (coordinate with the
backend agent before changing route code — UI does not edit `backend/`).

## References

- `frontend/tests/e2e/orcid-no-password.spec.js` — the two `test.fixme` blocks.
- `backend/src/routes/orcid.ts` — `handleSignup` / `countExternalWorks`.
- `docker-compose.test.override.yml` — the `orcid-stub` token sidecar to mirror.
- Parent: `ui-orcid-stub-real-roundtrip-unfixme` (the fresh_auth/set_password half).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
