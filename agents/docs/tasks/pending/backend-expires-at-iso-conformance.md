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

## Backend implementation signal (2026-05-16, worktree)

Acceptance items 1-3 + 5-6 landed; item 4 flagged as [TODO Architect].

### Item 1: emission change

- `backend/src/lib/fresh-auth.ts:264` — `IssuedFreshAuth.expires_at` type changed from `number` to `string`. Doc-comment expanded to call out the wire-format contract and link the catastrophic-failure path so future contributors don't regress.
- `backend/src/lib/fresh-auth.ts:301-305` (`issueFreshAuthToken`) — emission changed from `Math.floor(issuedAt / 1000) + FRESH_AUTH_TTL_SECONDS` (epoch seconds, number) to `new Date(memExpiresAtMs).toISOString()` (ISO-8601 string). Reused the already-computed `memExpiresAtMs` so the value is derived from a single source.
- `backend/src/lib/fresh-auth.ts:374-378` (`issueSessionFreshAuthToken`) — same change. The two issuance paths are the only sites that constructed `IssuedFreshAuth`, so all four downstream call sites (`custody.ts:787`, `custody.ts:872`, `orcid.ts:1148`, `orcid.ts:1214`) now pass through an ISO string without any change at the route layer.

Audit summary: no other backend route constructs an `IssuedFreshAuth`-like response with a buggy `expires_at`. All sibling JWT mint paths (`auth.ts:278`, `auth.ts:493`, `auth.ts:552`, `auth.ts:834`, `auth.ts:1258`, `custody.ts:1124`, `orcid.ts:695`, `signup-verify.ts:531`, `signup-verify.ts:749`) already emit ISO via `.toISOString()`. Audit was exhaustive across `backend/src/` via grep.

### Item 2: frontend audit findings (READ-ONLY, no code changes)

- `frontend/src/lib/fresh-auth.js:30` reads `Date.now() >= new Date(expiresAt).getTime()` for the SPA cache check. Confirmed: with the pre-fix backend emitting `1746535500` (epoch seconds), JavaScript interprets the number as milliseconds → `new Date(1746535500).getTime() ≈ 1.7e9 < Date.now() ≈ 1.7e12` → cache always treated expired. With the fix emitting `'2026-05-16T...'`, `new Date('<iso>').getTime()` parses to ~5 min in the future, cache works.
- `frontend/src/auth.js:147` (`_restoreSession`) reads `new Date(expiresAt) > new Date()` for the JWT-staleness check. Same comparison shape as the fresh-auth cache, **but** the JWT mint paths (`auth.ts:278` etc.) already emit ISO. The latent bug never reached `_restoreSession` because no JWT mint path emitted numeric `expires_at`. Today's fix doesn't change `_restoreSession`'s observable behavior.
- `frontend/src/auth.js:114-117` (`loginFromResponse`) stores `data.expires_at` verbatim into `this.expiresAt`, then `_saveSession` JSON-serializes it. ISO string serializes as string, round-trips correctly through `localStorage`. No frontend change needed.

Net: backend fix is sufficient to restore the SPA's fresh-auth cache. No defensive parsing required (item 5 below for deploy strategy).

### Item 3: tests

Updated 4 existing assertion blocks (no new test files — the existing surfaces already had the right route coverage, just the wrong shape assertion):

- `backend/tests/routes/custody-consent-ops.test.ts:258-262` — `/api/custody/fresh-auth` (password mechanism). Now asserts `typeof === 'string'`, `Date.parse(...)` finite, `parsed > Date.now()`, `parsed ∈ (Date.now() + 60s, Date.now() + 301s]`.
- `backend/tests/routes/custody-session-auth.test.ts:240-243` — `/api/custody/session-auth` (password mechanism, State A users). Same assertion block, ±2s tolerance on the 5-min TTL.
- `backend/tests/routes/orcid.test.ts:3047-3051` — `/api/orcid/callback` mode=`fresh_auth` (orcid mechanism). Same assertion block.
- `backend/tests/routes/orcid.test.ts:3155-3158` — `/api/orcid/callback` mode=`session_auth` (orcid mechanism). Same assertion block.

Each updated block includes an inline comment naming the P0 deploy-blocker and pointing to this task, so a future numeric-regression PR fails the test with a clear pointer to the rationale.

`custody-upgrade.test.ts:265` (JWT mint surface, custody-upgrade) was already asserting `string` — unchanged. `recover.test.ts:213` uses `toBeDefined()` (shape-agnostic) — unchanged.

### Item 4: [TODO Architect]

- `agents/docs/api-contracts/custody.md:108` already says ISO-8601. No change needed; architect to verify on re-review.
- `agents/docs/api-contracts/orcid.md:208,239` already says ISO-8601. No change needed; architect to verify on re-review.
- No `agents/docs/` writes performed (backend zone).

### Item 5: deploy strategy

**Backend-first deploy is safe.** Analysis:

- Old-bundle-still-cached scenario: backend emits ISO string. `frontend/src/lib/fresh-auth.js:30` does `new Date('<iso>').getTime()` which parses correctly. **Same or better behavior than today** — today the old bundle treats every proof as expired (number→ms gap); tomorrow it treats them as valid.
- Old-backend-still-running scenario: irrelevant — single backend instance, no rolling-deploy ordering ambiguity. Backend swaps atomically on `./deploy.sh restart`.
- New bundle + new backend: ISO end-to-end, cache works as designed.

Worst case during transition: in-flight broadcast requests with proofs minted under the old backend (numeric) reach the new bundle. The new bundle reads `new Date(<number>).getTime()` → ms-interpretation → 1970 → "expired" → re-mint via fresh-auth/orcid. Same as today's broken state. Brief degradation, no regression.

No SPA-first deploy required. No defensive parsing follow-up needed in the SPA.

### Item 6: related limiter findings

Quick survey of the limiter table on the affected routes:

- `freshAuthLimiter` (`custody.ts:56`): 10/min per account on `/api/custody/fresh-auth`. With the broken cache, every consent broadcast burned 1 mint. Users could legitimately hit 10 in a busy editing/review session. Limiter is per-account so users self-throttle, not global.
- `sessionAuthLimiter` (`custody.ts:61`): 10/min per account on `/api/custody/session-auth`. Same blast radius as above.
- `startLimiter` (`orcid.ts:202`): 10/min per IP on `/api/orcid/start`. Per-IP not per-account — a user behind a corporate NAT sharing the IP with other PEvO users could hit this faster.
- `callbackLimiter` (`orcid.ts:203`): 10/min per IP on `/api/orcid/callback`. Same per-IP concern.
- `broadcastLimiter` (`custody.ts:42`): 30/min per account on `/api/custody/broadcast`. Independent of the bug; mint-retry doesn't burn broadcast budget.

Once the fix lands, the cache reuse drops the steady-state mint rate to ~1 per session per mechanism. No limiter changes recommended — the budgets are sized for the cache-working steady state, and the fix restores it.

### Verification

- `npm run lint`: clean (2 pre-existing seed-phrase warnings only, unchanged by this task).
- `npx tsc --noEmit`: clean. Type change `number → string` would surface any caller doing numeric arithmetic on `expires_at`; none surfaced — the four downstream call sites (`custody.ts:787,872`, `orcid.ts:1148,1214`) all just pass the value through to `sendOk(...)`.
- Vitest not run in worktree (parent serializes).
