# BACKEND-ACCREDITATION-LIMITER-SKIP-FAILED — make `accreditationRequestLimiter` skip 5xx so SMTP transients don't burn one of three daily slots

**Owner:** Backend
**Created:** 2026-05-16 (architect, surfaced by `/ce-code-review` of `backend-custody-upgrade-limiter-skip-failed` — reliability persona reproduced the cascade by code inspection)
**Priority:** P1 (live gap — confirmed by code inspection of the route's SMTP failure path; not deploy-blocking but user-visible)

## Problem

`backend/src/routes/accreditation.ts:25` declares `accreditationRequestLimiter` with `max: 3` / 24h, `keyFn: byAccount`. The `/api/accreditation/request` handler performs a real `nodemailer.sendMail(...)` call on lines 343-365. When SMTP fails (relay down, network blip, DNS timeout, transient mail-provider hiccup), the route's catch block at line 353 calls `sendError(res, 500, ...)`.

Because the limiter has no `skipFailedRequests` option, the eager `redis.incr` in `backend/src/middleware/rateLimit.ts:44` already consumed one of the user's 3 slots before the handler ran. The 5xx response does NOT refund it. Net effect: a single SMTP outage burns one of the user's daily quota; three outages in a 24h window lock them out of accreditation requests entirely, with no recourse until the window expires.

The cascade class is the same shape the recently-landed `backend-custody-upgrade-limiter-skip-failed` task fixed for `upgradeLimiter`: irreversible / quota-protected critical action + 5xx-on-transient-failure + long limiter window. The `upgradeLimiter` fix flipped on `skipFailedRequests: true` (added to the `rateLimit` primitive in the same task); this task applies the same flag to `accreditationRequestLimiter`.

## Why now

Surfaced as the audit's HIGH-priority sibling-limiter finding in `backend-custody-upgrade-limiter-skip-failed` (acceptance #4). The reliability persona reviewing the closing commit `f99d201` reproduced the SMTP-failure cascade by reading the route and confirmed the audit's classification: this is a live mechanical gap, not a latent one.

Not deploy-blocking — a real user hits it only on the combination of (transient SMTP failure + retry attempt). Single-instance beta with low accreditation volume means it's rare. But the failure mode is real and user-blocking when it does fire (1 lost slot per SMTP blip; 3 in 24h = locked out).

## Goal

Add `skipFailedRequests: true` to `accreditationRequestLimiter` so transient SMTP / mail-provider 5xx responses do not consume the user's daily slot. 4xx responses (validation errors, duplicate request, etc.) continue to consume the slot — those are user-side failures, not server-side transients.

## Acceptance

### 1. Limiter config change

`backend/src/routes/accreditation.ts:25` opts in to `skipFailedRequests: true`. Mirror the `upgradeLimiter` shape at `backend/src/routes/custody.ts:50`:

```ts
const accreditationRequestLimiter = rateLimit({
  name: 'accreditation-request',
  windowMs: 24 * 60 * 60 * 1000,
  max: 3,
  keyFn: byAccount,
  skipFailedRequests: true,
});
```

### 2. Verify 4xx-vs-5xx semantics

Audit the `/api/accreditation/request` route's full error surface and confirm which status codes are emitted on which conditions:
- **5xx (should NOT consume slot):** SMTP failure (500), DB transient failure if it surfaces as 5xx, any other server-side transient.
- **4xx (SHOULD consume slot):** validation errors, "already requested this account", "no ORCID linked", etc. — user-side or contract-side failures where brute-force retry must rate-limit.

If the route currently swallows chain errors / SMTP errors to a 4xx envelope (making the gap latent), state that explicitly in the signal block and confirm `skipFailedRequests: true` does not change behavior in that case. If the route does emit 5xx on SMTP failure as the reliability review concluded, the fix is load-bearing.

### 3. Tests

Add a backend integration test mirroring the canary at `backend/tests/routes/custody-upgrade.test.ts:498` ("Hive getAccounts throws then recovers: 503 refunds limiter slot so the retry succeeds"). Drive an SMTP-transient outcome (mock the nodemailer transporter to throw, or via the existing test infrastructure's transient-fault mock), assert the 5xx response, then assert the next request from the same account does NOT 429.

### 4. Documentation

No contract change. `/api/accreditation/request` continues to emit 500 on transient SMTP failure; the only semantic change is the limiter behaviour. No `api-contracts/` edit required unless the route's 4xx-vs-5xx split needs documentation.

## Out of scope

- Hashing or refining the SMTP error surface (separate concern — the 500 envelope is the right shape per existing convention).
- Other limiters identified in the parent audit (`bridge.registerLimiter` MODERATE, auth flows LOWER-PRIORITY, NEGLIGIBLE short-window limiters). They were classified as not load-bearing in the same audit and do not need this fix.

## Source

- Parent task: archived 2026-05-16 — `backend-custody-upgrade-limiter-skip-failed`. See archive entry in `agents/docs/tasks-archive.md`.
- `/ce-code-review` reliability persona R-1 (P1, conf 90, confirmed live by code inspection of `accreditation.ts:343-365`).

## Cross-references

- `backend/src/routes/accreditation.ts:25` — the limiter declaration.
- `backend/src/routes/accreditation.ts:343-365` — the SMTP sendMail surface where 500 is emitted.
- `backend/src/middleware/rateLimit.ts` — the `skipFailedRequests` primitive option (already exists post-W7).
- `backend/src/routes/custody.ts:50` — the canonical opt-in shape to mirror.
- `backend/tests/routes/custody-upgrade.test.ts:498` — the canary test pattern to mirror.
- `agents/docs/solutions/conventions/wrapping-primitive-exhaustive-call-site-audit-2026-04-22.md` — the audit-by-grep convention the parent task honored.
