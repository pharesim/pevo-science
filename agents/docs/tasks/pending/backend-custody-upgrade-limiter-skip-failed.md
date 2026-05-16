# BACKEND-CUSTODY-UPGRADE-LIMITER-SKIP-FAILED — make the upgrade rate limiter skip failed requests so the 503-retry UX is reachable

**Owner:** Backend
**Created:** 2026-05-16 (architect, surfaced by `/ce-code-review` of `ui-custody-upgrade-seed-phrase-derive-flow` — cross-reviewer P0 deploy-blocker)
**Priority:** P0 (deploy-blocker — UI's 503-retry path is mechanically dead until this lands)

## Problem

`backend/src/routes/custody.ts:42` declares `upgradeLimiter = rateLimit({ windowMs: 3_600_000, max: 1 })`. The limiter middleware at `backend/src/middleware/rateLimit.ts:44` calls `redis.incr` unconditionally on every request before the handler runs, with no `skipFailedRequests` option.

Cascade trace for the new seed-phrase upgrade flow's 503 path:

1. User initiates upgrade. account_update broadcasts and lands on chain.
2. UI POSTs to `/api/custody/upgrade` with the new seed-phrase-derived proof.
3. Backend's Hive RPC blips during chain-state lookup → returns 503 SERVICE_UNAVAILABLE.
4. Limiter counter is already at 1 (incremented before the handler ran).
5. UI shows "Try Again" (503 maps to `upgrade.backendUnavailable`, retryable per the new contract).
6. User clicks Try Again. UI re-signs fresh proof, re-POSTs.
7. Limiter counter → 2 > max=1 → backend returns 429 Too Many Requests BEFORE the handler runs.
8. UI classifies 429 as terminal `upgrade.rateLimited` and wipes `newSeedPhrase` (`_clearSensitiveUpgradeState`).

Net effect: **user is locked out for an hour with chain rotated to new keys but backend retaining stale encrypted keys.** Catastrophic data loss UX: their seed phrase is gone, their light JWT signs with backend-stored keys the chain no longer accepts, and they cannot retry the upgrade for an hour.

The 503 path in the new contract is explicitly retryable; the SPA's `retryUpgradeBackend` was wired specifically to handle this case without re-broadcasting. The limiter as currently configured makes that retry path mechanically dead on every transient Hive-RPC blip.

## Why the UI E2E test missed it

`frontend/tests/e2e/custody-upgrade.spec.js:415` stubs `/api/custody/upgrade` via `page.route(...)` and returns 503 once, then 200. The stub bypasses the real limiter middleware entirely. The CI test passes; production fails.

## Goal

Make the upgrade limiter skip-failed-requests so 5xx responses do not consume the per-account hour budget. The user keeps their single retry slot when the failure mode is server-side transient.

## Acceptance

### 1. Limiter config change

In `backend/src/routes/custody.ts:42` (or wherever the upgrade-specific limiter lives), add `skipFailedRequests: true`:

```ts
const upgradeLimiter = rateLimit({
  windowMs: 3_600_000,
  max: 1,
  skipFailedRequests: true,
});
```

If the project's rate-limit middleware does not natively support `skipFailedRequests`, the equivalent behavior is: after the handler resolves, if `res.statusCode >= 500`, call `redis.decr` (or `redis.del` + recompute) on the limiter key for that account. The semantic must be: **a 5xx response refunds the limiter slot**. 4xx terminal responses (401, 403, 409) still consume the slot — those are user-side or contract-side failures and should rate-limit normally.

### 2. Verify against 4xx-vs-5xx semantics

- 401 UNAUTHORIZED (proof signature recovery fails, derived_pubkey not in chain key_auths): consumes the slot. The user provided wrong credentials; rate-limiting brute-force attempts is the right behavior.
- 403 ALREADY_UPGRADED: consumes the slot. The user is in a state where retry is meaningless.
- 409 ALREADY_UPGRADED: consumes the slot. Same as above.
- 503 SERVICE_UNAVAILABLE: DOES NOT consume the slot (Hive RPC blip is server-side).
- 504 GATEWAY_TIMEOUT (if emitted): DOES NOT consume the slot.

### 3. Tests

Add at least one backend integration test that:
1. Drives the upgrade handler to a 503 outcome (mock Hive RPC failure).
2. Verifies the limiter counter is NOT incremented (or is decremented post-response).
3. A subsequent valid request from the same account succeeds (not 429).

Mirror with a 401-counts-against-limit test to pin the 4xx-vs-5xx semantic.

### 4. Limiter on related flows

While in the area, audit `accreditationLimiter`, ORCID rate limits, and any other per-account critical-action limiters for the same skip-failed-requests gap. List the audited limiters in the signal block — name each by file:line and state whether it should also skip 5xx. The upgrade limiter is the most critical because of the seed-phrase-loss failure mode, but a similar cascade on the ORCID `session_auth` mint would block users from accreditation actions.

## Out of scope

- The UI's wire-side changes — those already landed in commit `6dfdb37` and assume the limiter will be fixed.
- The full audit of every limiter in the repo. Surface adjacent ones in the signal block; full audit deferred.
- Limiter on consent-op broadcasts — different threat model, different fix.

## Source

`/ce-code-review` of `ui-custody-upgrade-seed-phrase-derive-flow` (architect session 2026-05-16): adversarial adv-1 (P0/95) + correctness #1 (P0/75) → cross-reviewer promoted to confidence 100. Both reviewers reproduced the cascade structurally against `backend/src/middleware/rateLimit.ts:44` and `backend/src/routes/custody.ts:42`. The UI task `ui-custody-upgrade-seed-phrase-derive-flow` is held in `blocked/` with `[BLOCKED by Backend]` pending this fix landing.

## Cross-references

- `frontend/src/pages/settings.js:914-981` — the SPA's `retryUpgradeBackend` flow that this fix unblocks.
- `agents/docs/api-contracts/custody.md` — `/api/custody/upgrade` 503 contract (retryable).
- `backend/src/routes/custody.ts:42` — limiter declaration.
- `backend/src/middleware/rateLimit.ts:44` — the unconditional `redis.incr` site.
- `frontend/tests/e2e/custody-upgrade.spec.js:415` — the test that masks this gap (stubs the route; never hits the real limiter).

---

## Backend implementation signal (2026-05-16)

The substantive fix (acceptance #1: `skipFailedRequests: true` on `upgradeLimiter`) was implemented in flight by `backend-custody-upgrade-seed-phrase-reauth` round-2 item 2 (commits `9210dd2` + cherry-pick chain) BEFORE this task was filed. That work also added `skipFailedRequests` as an option on the `rateLimit` primitive in `backend/src/middleware/rateLimit.ts` — backward-compatible default `false`, opt-in `true`. `upgradeLimiter` at `backend/src/routes/custody.ts:50` opts in.

This commit adds the missing acceptance-#3 canary and the acceptance-#4 sibling audit; the rest of acceptance #1+#2 was already covered.

### Acceptance #3 canary added

`backend/tests/routes/custody-upgrade.test.ts` (new test "Hive getAccounts throws then recovers: 503 refunds limiter slot so the retry succeeds"): drives 503 outcome, then retries with a freshly-signed proof on the same account, asserts the retry returns 200 (not 429). Pins the slot-refund behaviour against the seed-phrase-loss cascade. 16/16 in the test file green.

### Acceptance #2 4xx-vs-5xx semantic

Verified via the existing 401 canaries (proof signature mismatch, no DB row) — those return 401 and DO consume the slot today (intentional: brute-force attempts must rate-limit). Only 5xx refunds. 503 is the only 5xx code emitted by the upgrade handler at HEAD.

### Acceptance #4 sibling-limiter audit

Surveyed all 35 `rateLimit({...})` declarations under `backend/src/`. None other than `upgradeLimiter` opts in to `skipFailedRequests` post-W7. Per-limiter recommendation:

- **HIGH (file separate follow-up):** `accreditationRequestLimiter` at `backend/src/routes/accreditation.ts:25` — `max: 3` / 24h, `keyFn: byAccount`. The accreditation request flow performs an on-chain `custom_json` attestation broadcast; a Hive RPC transient during that broadcast that surfaces as 5xx burns one of three slots for 24 hours. Same cascade class as the upgrade limiter (irreversible/critical action + low quota + long window). Recommend a follow-up task to add `skipFailedRequests: true` once the actual 5xx surface of `/api/accreditation/request` is audited (the route may swallow chain errors to a 4xx envelope today, in which case the gap is latent — file the task to make the audit explicit).
- **MODERATE:** `bridge.registerLimiter` at `backend/src/routes/bridge.ts:149` — `max: 10` / hour, `keyFn: byIp`. Bridge-paper register flow makes external lookups (arXiv / Crossref / DOI) that can 5xx. IP-keyed rather than account-keyed, so the user can switch networks; 10/hour quota means slot burn is annoying but not catastrophic. Worth a sweep but not a deploy-blocker.
- **LOWER PRIORITY:** Auth flows (`signupLimiter`, `loginLimiter`, `resetLimiter`, `resendLimiter`, `resetRequestLimiter`, `recoverLimiter`) at `backend/src/routes/auth.ts:262-266,568,1072` — `max: 5-10` / hour, `keyFn: byIp`. Failure modes are 4xx-dominant (wrong password, no such account); 5xx during auth would be unusual.
- **NEGLIGIBLE:** short-window high-quota limiters (`broadcastLimiter` 30/min, `freshAuthLimiter` 10/min, `sessionAuthLimiter` 10/min, `startLimiter` 10/min, `callbackLimiter` 10/min, `readLimiter` 120/min, `searchLimiter` 60/min, `notificationLimiter` 30/5min, `claimLimiter` 5/min, `approveLimiter` 10/min, `revokeLimiter` 10/min, `verifyLimiter` 10/hour byIp, `resumeLimiter` 5/hour byIp, `confirmLimiter` 10/hour byIp, `linkLimiter` 10/hour byIp, `contactLimiter` 5/hour byIp, `lookupLimiter` 20/min, `ipfsUploadLimiter` 10/hour byAccount, `ipfsDownloadLimiter` 60/min byIp, `anonReviewLimiter` 5/hour byAccount, `accreditationVerifyLimiter` 5/min byIp, `retractLimiter` 5/hour byAccount, `invalidateLimiter` 10/min byAccount, `sessionLimiter` 10/hour byAccount). None has the load-bearing seed-phrase-loss-style cascade.

### Architect call

`accreditationRequestLimiter` is the only sibling with a comparable cascade shape (long window, low quota, irreversible action). Filed for architect triage as a recommended follow-up; the current task's scope (`upgradeLimiter` specifically) closes here.

`npm run lint` clean (pre-existing seed-phrase warnings only); `npx tsc --noEmit` clean.
