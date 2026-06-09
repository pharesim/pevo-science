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

## UI completion note (2026-06-09, commit 66a46ec1 on main)

Done:
- **settings-orcid-factor.spec.js** (acceptance target): the `test.fixme` is now a
  live, green test, "ORCID-factor set_password succeeds end-to-end with a real
  backend-minted proof". It drives the State-C set_password ORCID factor against
  the orcid-stub: real /orcid/start -> in-page fulfil of the authorize hop -> real
  /orcid/callback (genuine proof mint, orcid == seeded iD) -> real
  /api/settings/set-password (200). Asserts the real cached proof shape,
  password_hash populated (State C -> State B), the set-password section gone on
  reload, and password login with the new password returning 200. The header's
  stale "no stub provider / test.fixme" mocking-justification notes were updated.
- **orcid-link.spec.js**: its real-backend block (the 403 cross-user state-hijack
  test) was already a live `test(...)` with a skip guard that fired only when
  /start returned non-200 (ORCID unconfigured). With the stub setting
  ORCID_CLIENT_ID/SECRET it no longer skips and runs for real (green). The two
  other tests there are frontend request-header contract tests (deliberately
  stubbed; not proof round-trips), left as-is.
- **orcid-no-password.spec.js**: the set-password real round-trip (its fixme #2)
  is a duplicate of the settings-orcid-factor test above; consolidated to a
  pointer rather than a second Docker-backed round-trip. The signup/recover fixmes
  stay fixme'd: both drive ORCID *signup* mode, whose handler fetches a works
  count from a hardcoded pub.orcid.org URL the token-only orcid-stub does not
  serve. Filed as follow-up `ui-orcid-signup-recover-real-roundtrip`.

Redirect-host bridge (non-obvious; not in the task recipe): the backend builds
redirect_url from `config.orcidBaseUrl` = `http://orcid-stub:8099`, and
`beginSettingsActionOrcidFreshAuth` validates the host against the frozen
`ORCID_REDIRECT_HOSTS` allowlist (orcid.org / sandbox.orcid.org) BEFORE navigating,
so an orcid-stub host throws before the browser leaves the app. The test passes
/orcid/start through to the real backend (real Redis state) and rewrites only the
redirect_url host to orcid.org so the guard passes and `**/oauth/authorize*` can be
intercepted. The recipe assumed the SPA would navigate to the stub host directly;
the allowlist makes that impossible, hence the bridge.

Pre-existing failures surfaced (NOT introduced here, NOT fixed here): three tests
in orcid-no-password.spec.js (lines 99/166/307) fail a Playwright strict-mode check
— `page.locator('form button[type="submit"]')` matches two elements because the
global reauth modal (password fresh-auth factor) renders its own submit "Confirm"
button in the layout. The SPA is built from current main and these tests'
selectors are untouched by this task. The fix is to scope the submit selector to
the page form; flagged for separate triage.

Verification: settings-orcid-factor 3/3 green in isolation; orcid-link green; the
three pre-existing orcid-no-password failures are the reauth-modal selector
collision above.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
