# BACKEND-REGISTER-RATE-LIMIT-LOCK-HELD-BURN — Mirror the `skipFailedRequests:true` fix from retract to register on the bridge LOCK_HELD path

**Owner:** Backend Agent
**Created:** 2026-05-20 (architect, surfaced by `/ce-code-review` of `ui-bridge-register-lock-held-ux` round-1 commit `01931666` — reliability reviewer at anchor 70)
**Priority:** P3 (concrete failure mode on contended-registration paths; same class as the just-landed retract fix)

## Problem

The bridge `/api/bridge/register` route has a per-IP rate limiter (`registerLimiter`) with no `skipFailedRequests:true` setting. Every 4xx response — including the new 409 `LOCK_HELD` retriable response — consumes a slot.

The SPA-side commit `01931666` added auto-retry on LOCK_HELD with up to 4 attempts (1 initial + 3 retries with 1.5s/2.5s/3.5s backoffs, ~7.5s budget vs the 35s backend Redis lock TTL). A single persistently-contended registration attempt now burns 4 of the limiter's hourly slots; an IP can absorb roughly 2 such attempts before legitimate retries hit 429.

This is the **same risk class** as `backend-retract-rate-limit-haf-503-burn`, which landed in commit `a5589588` shortly after `01931666` did. That task closed the slot-burn cascade on the retract path by adding `skipFailedRequests: true` to `retractLimiter`. The same shape of fix applies here.

## Goal

Apply `skipFailedRequests: true` (or equivalent slot-refund-on-failed-response behavior) to `registerLimiter` so that LOCK_HELD 409 responses do not consume rate-limit slots. The SPA's auto-retry behavior is correct per the contract; the burn is a backend-side limiter-policy gap.

## Acceptance

1. **Locate `registerLimiter` definition.** Reliability reviewer's read places it at `backend/src/middleware/rateLimit.ts` / `backend/src/routes/bridge.ts:149` — verify and locate at task-start.

2. **Apply the same fix shape as `a5589588`.** Add `skipFailedRequests: true` to the limiter's options. Pattern-match exactly against the retract fix:
   - `agents/docs/solutions/conventions/skip-failed-requests-jwt-required-credential-verify-carve-out-2026-05-17.md` — the threat-model framework that justifies this option for credential-verified write routes.
   - The `a5589588` commit diff itself is the canonical example.

3. **Apply the carve-out's threat-model lens.** The convention doc enumerates the JWT-required carve-out for why `skipFailedRequests` is safe on this class of route. Verify `/api/bridge/register` is in-scope:
   - JWT-required (yes — bridge registration requires accreditation + signed broadcast).
   - Pre-authentication / pre-validation work is cheap (LOCK_HELD is emitted AFTER auth/validation, so an attacker can't burn slots without authenticating first).
   - The endpoint's effective rate limit is enforced by the per-deterministic-permlink Redis lock, not by the IP limiter — the IP limiter exists to bound the worst-case behavior, not to be the only defense.

4. **Test.** A backend integration test against the real limiter. Sequence: make 4 register attempts where each returns LOCK_HELD (achievable by holding the Redis lock manually in test setup or by mocking the SETNX outcome — match the carve-out doc's existing test pattern). After the 4 attempts, the limiter's remaining slot count should be unchanged from baseline (slots refunded on each 409). Without the fix, slot count drops by 4.

5. **Cross-route consistency check.** While in `rateLimit.ts`, audit other limiters on auth/credential-verified write routes for the same gap. If any are missing `skipFailedRequests`, surface them — but DO NOT bundle additional fixes into this task. File a follow-up if multiple sites need the same treatment.

## Out of scope

- SPA-side changes to the retry policy on bridge.js. The auto-retry behavior is correct.
- The `agents/docs/api-contracts/bridge.md` documentation of LOCK_HELD. The wire contract is stable; only the limiter's slot-counting behavior changes.
- New rate-limit configuration knobs (`max`, `windowMs`). Existing values stay.
- Architectural changes to the limiter library or per-IP keying scheme.

## Cross-references

- Source commit on the SPA side: `01931666 ui(bridge): add LOCK_HELD auto-retry + DUPLICATE existing-paper link on /register`.
- Precedent fix: `a5589588 backend(retract-rate-limit-haf-503-burn): close slot-burn cascade with skipFailedRequests`.
- `agents/docs/solutions/conventions/skip-failed-requests-jwt-required-credential-verify-carve-out-2026-05-17.md` — threat-model framework for `skipFailedRequests` on auth/credential-verified routes.
- `agents/docs/api-contracts/bridge.md` — LOCK_HELD wire contract; consumed unchanged.
- `agents/docs/api-contracts/common.md` § rate-limit headers — verify the 429 envelope shape stays compatible if limiter library exposes anything observable.
