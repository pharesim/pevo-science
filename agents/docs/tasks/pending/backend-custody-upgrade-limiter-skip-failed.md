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
