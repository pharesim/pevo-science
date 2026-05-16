# BACKEND-EXPIRES-AT-ISO-CONFORMANCE — emit `expires_at` as ISO-8601 string per the documented wire contract

**Owner:** Backend
**Created:** 2026-05-16 (architect, surfaced by `/ce-code-review` of `ui-non-consent-broadcast-fresh-auth-wiring` — cross-reviewer P0 deploy-blocker)
**Priority:** P0 (deploy-blocker — UI's fresh-auth proof cache is 100% non-functional today; every light-account broadcast triggers a full ORCID OAuth round-trip)

## Problem

`backend/src/lib/fresh-auth.ts:290` emits `expires_at` as **epoch SECONDS (number)**: `Math.floor(issuedAt / 1000) + FRESH_AUTH_TTL_SECONDS`. The TypeScript type `IssuedFreshAuth.expires_at` is `number`.

Two contract documents say `expires_at` is an **ISO-8601 string**:
- `agents/docs/api-contracts/custody.md:108`
- `agents/docs/api-contracts/orcid.md:208`, `agents/docs/api-contracts/orcid.md:239`

The frontend reads the wire value via `new Date(expiresAt).getTime()` (e.g., `frontend/src/lib/fresh-auth.js:30` and almost certainly `frontend/src/auth.js`'s `loginFromResponse` for the JWT expiry). When `expiresAt` is the number `1746535500` (epoch seconds, May 2026), `new Date(1746535500)` is interpreted as **milliseconds** → resolves to January 21, 1970 → comparison `Date.now() >= 0` is always true → cache is treated as expired on every read.

### Catastrophic UX impact (today, on every deploy)

- **Fresh-auth proof cache:** 100% non-functional. Every light-account broadcast (vote/comment/publish/edit/vouch/claim) triggers a full ORCID OAuth round-trip (orcid.org redirect + return-to-callback + state-token roundtrip) instead of reusing the cached 5-minute proof. Every. Vote.
- **JWT expiry check (latent):** if `auth.js` `loginFromResponse` or any other client-side JWT-staleness check consumes `expires_at` the same way, the SPA treats every JWT as immediately expired. This may force a re-login on every page load, or — worse, depending on the read path — silently never expire because the comparison is inverted in a way the test corpus doesn't trigger.

### Why E2E missed it

`frontend/tests/e2e/non-consent-fresh-auth.spec.js:57` synthesizes `expires_at` as an ISO string via `new Date(...).toISOString()`. `new Date('<iso>')` parses correctly, so the cache check works in the test. Backend emits epoch seconds (number); test stubs ISO string. Test passes, production fails.

### Cross-reviewer convergence

Four independent reviewers in the `ui-non-consent-broadcast-fresh-auth-wiring` review hit the same finding:
- correctness #1 (P0/90)
- security sec-1 (P2 — under-graded, the security lens looked at it as XSS-uplift; the bigger issue is functional)
- adversarial adv-001 (P0/95)
- api-contract AC-1 (P0/100)

Synthesis promoted to confidence 100.

## Goal

Make backend emit `expires_at` as an ISO-8601 string matching the documented wire contract. Frontend reads via `new Date(<iso>).getTime()` continue to work; sessionStorage cache survives its 5-minute TTL; ORCID OAuth round-trips happen once per session, not once per broadcast.

## Acceptance

### 1. Backend emission change

In `backend/src/lib/fresh-auth.ts:290` (and any other site that constructs an `IssuedFreshAuth`-like response), change `expires_at` from `Math.floor(issuedAt / 1000) + FRESH_AUTH_TTL_SECONDS` to `new Date((issuedAt + FRESH_AUTH_TTL_SECONDS * 1000)).toISOString()`.

Update the TypeScript type `IssuedFreshAuth.expires_at` from `number` to `string`.

Audit all `expires_at`-emitting paths:
- `/api/custody/upgrade` response (line 361 — same code path)
- ORCID callback `session_auth` proof issuance
- JWT mint paths (`auth.ts loginFromResponse` etc.)
- Anywhere else `IssuedFreshAuth` or its peer types appear

### 2. Verify the auth.js latent bug

Read `frontend/src/auth.js` (`loginFromResponse`, `_saveSession`, the `expires_at`-handling code) and audit whether the same numeric-vs-string interpretation gap exists. If yes (likely), this fix lands the SPA-side correctness fix simultaneously. If the SPA somehow handles both shapes (defensive parsing), document that and confirm both new and old formats work during the deploy transition.

### 3. Tests

Add backend integration tests for at least:
- `POST /api/orcid/start` → `mode: 'session_auth'` issuance returns `expires_at` parseable by `new Date(...).getTime()` and lands at `Date.now() + FRESH_AUTH_TTL_SECONDS * 1000` (±2s).
- `POST /api/custody/upgrade` success response: same.
- JWT mint paths if they share the same field.

Backend test should NOT just assert the field is "truthy" — it should assert `typeof expires_at === 'string'` AND `Date.parse(expires_at) > Date.now()`.

### 4. Documentation alignment

After the fix lands, confirm:
- `agents/docs/api-contracts/custody.md:108` says ISO-8601 ✓ (no change)
- `agents/docs/api-contracts/orcid.md:208,239` says ISO-8601 ✓ (no change)
- Add an inline comment in `backend/src/lib/fresh-auth.ts` documenting the wire format ("ISO-8601 string per api-contracts/custody.md") so future contributors don't regress.

### 5. Deploy strategy

Because the SPA bundle may be HTTP-cached on long-lived tabs at deploy time, consider:
- Either: ship the SPA bundle change to defensively parse BOTH formats (`typeof expiresAt === 'string' ? new Date(expiresAt).getTime() : expiresAt * 1000`) BEFORE the backend change deploys. Then deploy the backend change. Then in a follow-up, drop the defensive parsing.
- Or: deploy backend change at a low-traffic window and accept a brief window of stale-bundle-tab breakage.

User-visible impact during transition: if backend emits ISO and an old bundle is still cached, the bundle's `new Date(<iso>).getTime()` works correctly (ISO is parseable), so the worst case is the same as today — every broadcast triggers ORCID round-trip. No new regression.

If backend continues emitting number and a new bundle ships: the new bundle's defensive parse path correctly handles both. Compatible.

### 6. Audit related limiter-counter resets

The fresh-auth proof TTL gate is what gives users the 5-minute reuse window. With today's broken cache, every ORCID OAuth round-trip burns the user's per-account `/api/orcid/start` rate limit (if any). Audit `orcidStartLimiter` and similar limiters for cost/blast-radius; if a transient mass-cache-bust would lock users out, surface the secondary risk.

## Out of scope

- The UI's wire-side changes — those already landed in commit `6dfdb37` and assume ISO-8601 per the contract docs.
- A full PEvO-wide audit of `expires_at` / `expiresAt` shapes across other APIs (separate task if needed).
- Frontend's defensive-parse fallback if the deploy strategy is "ship SPA first" — separate task or fold into this if convenient.

## Source

`/ce-code-review` of `ui-non-consent-broadcast-fresh-auth-wiring` (architect session 2026-05-16): correctness 90 + security 60 + adversarial 95 + api-contract 100 → cross-reviewer synthesis confidence 100. All four reviewers reproduced the bug structurally against `backend/src/lib/fresh-auth.ts:290` ↔ `frontend/src/lib/fresh-auth.js:30`. The UI task `ui-non-consent-broadcast-fresh-auth-wiring` is held in `blocked/` with `[BLOCKED by Backend]` pending this fix landing.

## Cross-references

- `agents/docs/api-contracts/custody.md:108` — the documented contract.
- `agents/docs/api-contracts/orcid.md:208,239` — the documented contract.
- `frontend/src/lib/fresh-auth.js:30` — the SPA-side `getCachedSessionProof` consumer.
- `frontend/src/auth.js` — the latent-bug audit site.
- `frontend/tests/e2e/non-consent-fresh-auth.spec.js:57` — the test that masks this gap.
- `agents/docs/tasks/blocked/ui-non-consent-broadcast-fresh-auth-wiring.md` — the blocked UI task.
