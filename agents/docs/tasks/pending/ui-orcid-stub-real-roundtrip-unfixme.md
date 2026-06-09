# UI-ORCID-STUB-REAL-ROUNDTRIP-UNFIXME — drive the ORCID E2E specs through the real backend round-trip

**Owner:** UI (owns `frontend/tests/e2e/`)
**Created:** 2026-06-09 (architect handoff from the orcid-stub E2E standup)
**Priority:** P3

## Context

The E2E stack now ships a stub ORCID OAuth provider as a compose sidecar
(`orcid-stub` in `docker-compose.test.override.yml`). The real backend reaches
it over the compose network (`ORCID_BASE_URL=http://orcid-stub:8099`,
`ORCID_CLIENT_ID`/`ORCID_CLIENT_SECRET` set non-empty), so the real
`/api/orcid/callback` can now complete a genuine OAuth token exchange and mint a
real fresh-auth proof instead of being network-stubbed.

This unblocks the `test.fixme`'d real-backend blocks in the three ORCID specs.

## How the stub works (the contract you build against)

The stub serves a single endpoint, `POST /oauth/token`. It is **stateless**: it
reflects the form-body `code` straight back as the token response's `orcid`
field (plus a fixed `name` and `access_token`). So the spec controls which ORCID
iD the callback binds against by controlling the `code` it sends through the
flow. No browser ever reaches the stub — only the backend does.

The flow to drive, per spec:

1. Seed the account into §6.1 State C with a known per-run ORCID iD. The existing
   `seedStateCAccount()` helper in `settings-orcid-factor.spec.js` already inserts
   `accounts.orcid = <per-run-unique iD>` (forced unique by the partial UNIQUE
   index; do NOT use a fixed constant or retries collide). Capture that iD.
2. Trigger the ORCID action in the UI. The frontend calls `/api/orcid/start`,
   which returns `{ redirect_url }` containing `.../oauth/authorize?...&state=<S>`
   and navigates the browser there.
3. **Intercept the authorize navigation** with Playwright `page.route` on
   `**/oauth/authorize*`. Read the real `state=<S>` out of the intercepted
   request URL, then `route.fulfill` a 302 with
   `Location: ${baseURL}/orcid/callback?code=<seeded iD>&state=<S>`. (Echo the
   real `state` verbatim — the backend looks it up in Redis. Set `code` to the
   exact iD seeded in step 1.) The stub's authorize endpoint is intentionally
   absent; this in-page fulfil replaces it.
4. The browser lands on the real `/orcid/callback` page, which POSTs `{code,
   state}` to the real `/api/orcid/callback`. The backend validates `state`,
   exchanges `code` against the stub, gets back `orcid === <seeded iD>`, matches
   it against `accounts.orcid`, and mints a real `fresh_auth` proof
   (mechanism `orcid`, target-bound to the action).
5. Remove the existing network stubs of `/api/orcid/callback` (and, for the
   set-password specs, `/api/settings/set-password`) so the real routes run and
   the real proof is exercised end-to-end.

## Specs to un-fixme

- `frontend/tests/e2e/settings-orcid-factor.spec.js` — the `test.fixme` "ORCID-factor
  set_password succeeds end-to-end with a real backend-minted proof". **Start here**
  (it is the acceptance target below).
- `frontend/tests/e2e/orcid-no-password.spec.js` — its set-password real-backend
  block. (Blocks whose assertions are pure DB-state / no ORCID provider hop may be
  un-fixme'able independently of the stub; use judgement.)
- `frontend/tests/e2e/orcid-link.spec.js` — its real-backend ORCID block / the
  currently-stubbed-callback contract test, upgraded to a real round-trip.

## Acceptance

- `settings-orcid-factor.spec.js`'s set_password fixme is live and green: real
  `/orcid/start` → in-page authorize fulfil → real `/orcid/callback` (real proof
  mint) → real `/api/settings/set-password` (proof accepted, `password_hash`
  populated). Its `/api/orcid/callback` + `/api/settings/set-password` route
  stubs are removed.
- The other two specs' real-backend blocks are un-fixme'd, or any genuinely
  out-of-scope remainder is filed as its own follow-up with a one-line reason.
- Run the affected specs against the test stack and confirm green. (Per
  `MEMORY.md`: `./deploy.sh test-db-up` then `./deploy.sh test-up`; the override
  recreates the backend with the stub wired in.)

## References

- `docker-compose.test.override.yml` — the `orcid-stub` service + the backend
  `ORCID_*` env block (the contract above is documented inline there too).
- `backend/src/routes/orcid.ts` — real `/start` (builds the authorize redirect +
  stores `state` in Redis) and `/callback` (state validation, token exchange,
  ORCID-iD match, proof mint).
- `backend/src/routes/settings.ts` — the set-password `ORCID_REQUIRED` eligibility
  gate (account must be State C `orcid SET`) that fires before the proof gate.
- Parent: `architect-e2e-stub-orcid-oauth-provider` (the standup, now landed).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
