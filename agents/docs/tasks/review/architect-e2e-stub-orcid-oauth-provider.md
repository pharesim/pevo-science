# ARCHITECT-E2E-STUB-ORCID-OAUTH-PROVIDER — stand up a stub ORCID OAuth provider in the E2E harness

**Owner:** Architect (design + harness/compose/env standup) — with Backend (orcid config plumbing if needed) and UI (un-fixme the specs) handoffs
**Created:** 2026-06-09 (architect, clause-(c) follow-up from the `ui-settings-orcid-factor-e2e` review)
**Priority:** P3

## Landed (architect, 2026-06-09)

Decisions taken (confirmed with the user): scope = `fresh_auth`/`set_password`
only; stub = hand-written Node script; fidelity = backend-only-real (browser
authorize hop fulfilled in-page by Playwright, not by the stub).

Shipped in `docker-compose.test.override.yml`: an `orcid-stub` sidecar
(node:20-alpine, ~20-line inline `POST /oauth/token` server reflecting the form
`code` back as the response `orcid` field) plus the backend `ORCID_BASE_URL=
http://orcid-stub:8099` / `ORCID_CLIENT_ID` / `ORCID_CLIENT_SECRET` env block and
a `depends_on`. The merged compose config validates and the inline server was
exercised standalone (token-exchange reflection + 404 fallback) before commit.

Backend handoff resolved with NO code change: `config.orcidBaseUrl` /
`orcidClientId` / `orcidClientSecret` are already env-overridable
(`backend/src/config.ts`), and the callback's token exchange + ORCID-iD match +
proof mint all run for the `fresh_auth` path without touching the hardcoded
`pub.orcid.org` works URL (that URL is reached only by `signup`/`accredit`,
which were declared out of scope). If real signup/accredit round-trips are
wanted later, file a `backend-` task to make `orcid.ts`'s works-fetch base
env-overridable.

UI handoff filed: `ui-orcid-stub-real-roundtrip-unfixme` carries the spec
un-fixme work and the end-to-end green criterion (acceptance items below that
require driving/greening a spec are tracked there, since the architect cannot
edit `frontend/`). The architect-owned deliverable — stub stood up, reachable,
config confirmed env-overridable, handoff filed — is complete.

## Problem

Three ORCID E2E specs cannot exercise their real-backend round-trip because the local/E2E stack
has no ORCID OAuth provider to exchange against. The real `/api/orcid/callback` performs a live
OAuth token exchange against `config.orcidBaseUrl/oauth/token`; ORCID is unconfigured locally
(empty `ORCID_CLIENT_ID`, no ORCID keys in `frontend/.env.test`), and the harness ships no mock
provider. So every ORCID E2E spec network-stubs the backend callback and `test.fixme`s its
real-backend assertions:

- `frontend/tests/e2e/settings-orcid-factor.spec.js` — the `test.fixme` "ORCID-factor
  set_password succeeds end-to-end with a real backend-minted proof".
- `frontend/tests/e2e/orcid-link.spec.js` — its real-backend ORCID `test.fixme`.
- `frontend/tests/e2e/orcid-no-password.spec.js` — its real-backend ORCID `test.fixme`(s).

This is the deferral half of the test-mock carve-out clause (c): the convention wants a tracked
follow-up task, not just an in-file `test.fixme`. This file is that follow-up. It converts the
in-file deferrals into a single tracked work-item and, once landed, lets the real-backend ORCID
round-trip (the genuine §6.5 invariant #1/#2 enforcement) be exercised at E2E.

## Goal

Add a controllable stub ORCID OAuth provider to the E2E test stack so the REAL backend
`/api/orcid/callback` can complete a token exchange + userinfo fetch against it and mint a genuine
fresh-auth proof. Then un-fixme the three specs' real-backend round-trips.

## Design questions (resolve first)

- **Which mock provider / topology?** Options: an off-the-shelf mock OAuth2 server as a compose
  service in `docker-compose.test.override.yml` (no PEvO application code), vs a tiny in-harness
  stub served from E2E global-setup. Prefer the off-the-shelf compose-service route if it can mint
  the token + userinfo shapes the backend's ORCID client expects, to avoid maintaining a stub.
- **Config wiring:** point `config.orcidBaseUrl` (and `ORCID_CLIENT_ID`/secret) at the stub in
  test mode via env/compose. Confirm `orcidBaseUrl` is env-overridable without backend code change;
  if not, that's the backend sub-step.
- **Userinfo/iD binding:** the stub must return an ORCID iD that matches the seeded account's
  `orcid` column so §6.5 invariant #2 (registered-factor match) is actually exercised.

## Acceptance

- The E2E stack stands up a stub ORCID OAuth provider the backend can reach.
- At least one ORCID E2E spec (start with `settings-orcid-factor.spec.js` set_password) drives the
  REAL `/orcid/start` → stub provider → REAL `/orcid/callback` (real proof mint) → real
  `/api/settings/set-password` (proof accepted, `password_hash` populated) round-trip, green.
- The corresponding `test.fixme` blocks in the three specs are un-fixme'd (or the remaining ones
  filed as their own follow-ups if out of scope for a first cut).
- The seeded account is a genuine §6.1 State C (`orcid SET`) so the real route clears its
  `ORCID_REQUIRED` eligibility gate.

## Cross-role breakdown

- **Architect:** design decision (provider/topology), `docker-compose.test.override.yml` service,
  `.env.example` / `.env.test.example` keys.
- **Backend:** ensure `config.orcidBaseUrl` / client id are test-overridable (likely already env);
  any code change lands as a backend task.
- **UI:** un-fixme the specs against the real round-trip; owns the `frontend/tests/e2e/` changes.

## References

- `backend/src/routes/orcid.ts` — the real callback's token exchange against
  `config.orcidBaseUrl/oauth/token` and the userinfo fetch.
- `backend/src/routes/settings.ts` — the set-password `ORCID_REQUIRED` eligibility gate that fires
  before the proof gate (so the seeded account must have `orcid SET`).
- `frontend/tests/e2e/settings-orcid-factor.spec.js`, `orcid-link.spec.js`,
  `orcid-no-password.spec.js` — the three specs with real-backend `test.fixme`s.
- `agents/docs/solutions/conventions/test-mock-carve-out-clause-c-2026-05-04.md` — why the in-file
  `test.fixme` deferral wants a tracked follow-up.
- Origin: `ui-settings-orcid-factor-e2e` review (architect, 2026-06-09).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
