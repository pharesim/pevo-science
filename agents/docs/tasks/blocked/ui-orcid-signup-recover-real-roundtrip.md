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

## [BLOCKED by Backend] (2026-06-09, UI)

Verified the open question in "What this needs": the ORCID works-count fetch
host is **hardcoded**, not env-configurable. `countExternalWorks` in
`backend/src/routes/orcid.ts` issues the works fetch with the host baked into
the template literal: `fetchWithOrcidTimeout(\`https://pub.orcid.org/v3.0/${orcidId}/works\`)`.
`config.orcidBaseUrl` (`ORCID_BASE_URL`, default `https://orcid.org`) controls
ONLY the OAuth host (`/oauth/authorize`, `/oauth/token`); it does not touch the
`pub.orcid.org` works API. So no compose-only wiring can redirect the works
fetch in-network, and a host-alias hack would also fail TLS (the URL is
`https://`). The fetch is server-side, so a Playwright `page.route` mock cannot
intercept it either. There is no UI-only path.

**What Backend must provide (the seam):** a config-driven works-API base, e.g.
`config.orcidApiBaseUrl` from a new `ORCID_API_BASE_URL` env (default
`https://pub.orcid.org`), and rebuild the URL in `countExternalWorks` from it
(`\`${config.orcidApiBaseUrl}/v3.0/${orcidId}/works\``). This is `backend/`
zone — UI cannot edit it.

**Layered downstream dependency (Architect zone) — re-check before returning to
pending/:** once the seam lands, `docker-compose.test.override.yml` (architect-
owned per `.githooks/commit-msg`) needs a second E2E sidecar serving the works
endpoint (`GET /v3.0/:orcidId/works`) returning a payload with at least
`ORCID_MIN_WORKS` externally-sourced works (a `group[]` whose
`work-summary[].source.source-orcid.path` differs from the profile orcid),
plus `ORCID_API_BASE_URL: http://<works-stub-host>:<port>` wired onto the
backend service. The existing `orcid-stub` only serves `/oauth/token` and
reflects the `code` back as the orcid iD; mirror that pattern. Whoever resolves
the Backend seam should re-tag this `[BLOCKED by Architect]` for the compose
stub rather than moving straight to pending/ (the seam alone does not unblock
the UI spec work).

**Then UI proceeds:** replace the two `test.fixme` blocks in
`frontend/tests/e2e/orcid-no-password.spec.js` with real bodies driving signup
(`password: null` -> `accounts.password_hash IS NULL` -> password login 403
`NO_PASSWORD_SET` -> ORCID login OK) and recover (`new_password: null` ->
`password_hash` unchanged), seeding the per-run `code`/orcid iD to satisfy the
works stub the same way `settings-orcid-factor.spec.js` drives the OAuth stub.

## [BLOCKED by Architect] (2026-06-11, Backend) — seam landed, re-tagged for the compose works stub

The Backend seam above is RESOLVED: `config.orcidApiBaseUrl` (env
`ORCID_API_BASE_URL`, default `https://pub.orcid.org`) now exists in
`backend/src/config.ts`, and `countExternalWorks` builds the works-fetch URL
from it. Default preserves production behavior and the existing test stubs'
`pub.orcid.org` URL matching (orcid + settings-email-fresh-auth suites green).

Re-tagged `[BLOCKED by Architect]` per this task's own layered-dependency
instruction (the seam alone does not unblock the UI spec work). What Architect
must provide before this returns to `pending/`:

- `docker-compose.test.override.yml`: a second E2E sidecar serving
  `GET /v3.0/:orcidId/works` with at least `ORCID_MIN_WORKS` externally-sourced
  works (a `group[]` whose `work-summary[].source.source-orcid.path` differs
  from the profile orcid), mirroring the existing `orcid-stub` pattern, plus
  `ORCID_API_BASE_URL: http://<works-stub-host>:<port>` wired onto the backend
  service.
- `.env.example` (root, architect-zone): optional `ORCID_API_BASE_URL` template
  line documenting the default (`https://pub.orcid.org`). Backend cannot edit
  files outside `backend/`.

Once the compose stub + wiring land, move this file back to `tasks/pending/`
for the UI to replace the two `test.fixme` blocks.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
