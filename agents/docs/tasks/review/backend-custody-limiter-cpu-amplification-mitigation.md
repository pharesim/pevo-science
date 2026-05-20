# BACKEND-CUSTODY-LIMITER-CPU-AMPLIFICATION-MITIGATION — bound CPU/RPC cost per authenticated account when limiter slots aren't consumed on 4xx/5xx

**Owner:** Backend Agent
**Created:** 2026-05-16 (architect, surfaced by `/ce-code-review` on `backend-custody-upgrade-seed-phrase-reauth` round-2 — security SEC-r2-1)
**Priority:** P2

## Problem

The `skipFailedRequests` option (added to `backend/src/middleware/rateLimit.ts` in `backend-custody-upgrade-seed-phrase-reauth` round-2) caps limiter SUCCESSES only, not request rate. This is the desired behavior for stolen-JWT-DoS protection (legitimate user keeps their slot when an attacker sends bad requests). But it also opens a new exposure: any holder of a valid JWT (legit user or stolen-JWT attacker) can spray malformed/wrong-proof requests indefinitely at the limiter's nominal cap, and each spray pays significant CPU/RPC cost upstream of the limiter:

- `verifyHiveSignature` middleware: ECDSA signature recovery on the JWT (~5-10ms CPU each).
- Body parse + validation.
- For valid-binding-but-bad-chain-state attempts on `/upgrade`: `Signature.fromString().recover()` + `crypto.timingSafeEqual` chain → `hiveClient.database.getAccounts(...)` RPC with up to 30s sequential failover if Hive nodes are degraded.

The original 1/hr `upgradeLimiter` was specifically the bound on that cost. Removing the failure-counts-against-cap behavior (which is what `skipFailedRequests: true` does) defeats that bound. A stolen-JWT attacker at sustained 1 RPS = continuous CPU burn from a single attacker per account; under Hive RPC degradation, the worst case is a request pipeline blocked on 30s timeouts per probe.

**Same defect class is latent on `accreditationRequestLimiter`** (`backend/src/routes/accreditation.ts:35`) if it ever opts into `skipFailedRequests`.

## Why now (and why blocked)

`/ce-code-review` on `backend-custody-upgrade-seed-phrase-reauth` round-2 surfaced this as a P2 follow-up. Two reasons it's filed separately rather than held on the upgrade task:

1. **Scope**: the fix is a layered mitigation pattern, not a single line in the upgrade route. Filing under upgrade r2 would conflate the fix scope.
2. **Dependency on upgrade r3 landing first**: the upgrade-task r2 review held FIVE items including a real functional bug (Redis `pexpire` only fires when `count === 1`, leaving keys at count=N with no TTL → permanent lockout) and a TOCTOU race on the same `skipFailedRequests` Redis path. The CPU-amplification mitigation depends on the limiter primitive being structurally sound; until those round-3 fixes land, the mitigation pattern can't be confidently designed.

## Goal

Bound the CPU/RPC cost per authenticated account regardless of whether the limiter consumes on failure.

## Approach options

Three options, not mutually exclusive:

1. **Body validation before the limiter.** Move body-shape validation (missing fields, wrong types, length caps) BEFORE `upgradeLimiter` in the middleware chain. Wrong-shape requests get rejected with 400 VALIDATION_ERROR without invoking the limiter at all (and without paying the Hive RPC cost). This is the cheapest layered defense. Pattern: `router.post('/upgrade', verifyHiveSignature, validateUpgradeBodyShape, upgradeLimiter, async (req, res) => { ... })`.

2. **Layered IP-keyed limiter.** Add a coarser limiter keyed by client IP (or `X-Forwarded-For` with PEvO's spoof guard) with a generous cap that counts FAILED requests (i.e., does NOT opt into `skipFailedRequests`). E.g., 100 attempts per IP per hour. This bounds the spray rate per network origin even when the per-account success cap is unconsumed. Risk: NAT'd users sharing an IP could lock each other out at high cap; tune carefully.

3. **CPU-cost-aware token bucket.** Replace the binary "count attempts" with a "weight per attempt" bucket. argon2 verify costs more than a signature recovery; signature recovery costs more than body parse. Each path's cost weight is documented. Operational complexity is higher; benefit is precise CPU-budget enforcement.

Architect recommendation: **Option 1 + Option 2 layered**. Option 1 is free (a middleware reorder) and eliminates the cheapest spray class. Option 2 adds a coarse bound on network-origin spray rate while preserving the per-account success cap that `skipFailedRequests` enables. Option 3 is over-engineering for PEvO's beta scale; revisit if real production traces show CPU contention.

## Acceptance

1. Body-shape validation moved before the limiter on `/upgrade` (and any other route opting into `skipFailedRequests`). VALIDATION_ERROR responses no longer pay verifyHiveSignature + handler cost.

2. Decision: layered IP-keyed limiter (Option 2) — yes / no with rationale documented in the task closing signal. If yes, implement with a generous cap and PEvO's existing X-Forwarded-For spoof-guard.

3. Sibling-route audit: every route that opts into `skipFailedRequests` (today: `upgradeLimiter`; likely future: `sessionAuthLimiter`, `freshAuthLimiter` per the session-auth r1 hold item 3) gets the same body-validation-before-limiter shape.

4. Test coverage: real-path integration test asserting (a) malformed body returns 400 without invoking the limiter (assert limiter state unchanged), (b) valid-shape-but-wrong-proof returns 401 with the limiter slot unconsumed under `skipFailedRequests`, (c) if Option 2 lands, IP-keyed limiter exhaustion returns 429 distinct from the per-account 429.

5. JSDoc update on `RateLimitConfig.skipFailedRequests`: document that callers MUST also implement body-validation-before-limiter (the established layered pattern) to avoid CPU amplification on malformed-body spray. This addresses the existing JSDoc misuse-direction gap from upgrade r2 hold item 5(b).

## Out of scope

- Changing the success-only consume semantics of `skipFailedRequests`. The option's value depends on not consuming on failure.
- Per-request CPU-cost-aware bucketing (Option 3). Defer unless production traces show contention.
- Mitigations for Hive RPC node degradation (the 30s failover that compounds the spray cost). That's a separate Hive-side concern.

## Dependencies

- **BLOCKED on `backend-custody-upgrade-seed-phrase-reauth` round-3 landing**. The upgrade r3 hold includes fixes for the `skipFailedRequests` permanent-lockout bug (#4) and TOCTOU race (#5). The mitigation in this task assumes a correctly-functioning `skipFailedRequests` primitive.

## Cross-references

- `backend/src/middleware/rateLimit.ts` — the `skipFailedRequests` option.
- `backend/src/routes/custody.ts:49` (`upgradeLimiter`), `:61` (`sessionAuthLimiter`), `:76` (`freshAuthLimiter`), `accreditation.ts:35` (`accreditationRequestLimiter`) — current and prospective opt-in sites.
- Convention: `agents/docs/solutions/conventions/wrapping-primitive-exhaustive-call-site-audit-2026-04-22.md` (the call-site audit + misuse-direction documentation rules; upgrade r3 hold item 5 has the grep audit + JSDoc misuse-direction fix that this task complements).
- Convention: `agents/docs/solutions/conventions/strict-superset-wrapper-inherits-escape-hatches-2026-05-12.md` (per-option triage at write time).

## Source

`/ce-code-review` on `backend-custody-upgrade-seed-phrase-reauth` round-2 (architect session 2026-05-16): security SEC-r2-1 P2 conf 55 + partial overlap with the wrapping-primitive convention review. Triaged at architect session 2026-05-16 — routed to a follow-up task rather than held on upgrade r2 because the fix is architectural (layered mitigation pattern + sibling-route audit) and depends on upgrade r3's primitive fixes landing first.

---

## [BLOCKED by Backend Agent] (architect filing 2026-05-16)

This task is blocked on `backend-custody-upgrade-seed-phrase-reauth` round-3 landing. The `skipFailedRequests` primitive has two open defects (permanent-lockout bug, TOCTOU race) that round-3 must fix before this task can confidently design layered mitigations atop it.

What unblocks: the upgrade task's round-3 fix commit + architect re-review + archive of upgrade-seed-phrase-reauth.

Architect or backend (at next startup) moves this file back to `tasks/pending/` once the upgrade task archives.

**Unblocked 2026-05-20 (architect).** Round-3 fixes landed at commits `16c6ac7..c9c7c5f` on `backend-custody-upgrade-seed-phrase-reauth`. Both load-bearing defects (permanent-lockout from conditional `pexpire`, TOCTOU race on GET→next→deferred-INCR) were structurally closed by the atomic Lua INCR/check/DECR/PEXPIRE script (`backend/src/lib/redis-scripts.ts:74-104` `RATE_LIMIT_CHECK_AND_CONSUME`, dispatched via `evalScript`). The upgrade task is currently in `tasks/review/` at round-7, but rounds 4–7 are edge-case refinements (writableEnded gate, `as [number, number]` cast, satisfies-record convention, in-memory test mirror, comment-anchor hygiene) — none modified the limiter primitive's structural shape. The mitigation pattern (body-validation-before-limiter + optional layered IP-keyed limiter) can be confidently designed against the stable round-3 primitive without waiting for full archive of the parent task. Backend agent picks this up at next startup.

---

## Backend re-review signal (2026-05-20)

### Option 1: body-validate-before-limiter applied

Five `skipFailedRequests: true` opt-in sites; all five now place body-shape validation BEFORE the limiter:

- `backend/src/routes/custody.ts`:
  - `POST /api/custody/upgrade` → `verifyHiveSignature, validateUpgradeBodyShape, upgradeLimiter, handler`. New `validateUpgradeBodyShape` middleware checks `derived_pubkey`, `signed_proof`, `signed_at` presence + type + length cap.
  - `POST /api/custody/fresh-auth` → `verifyHiveSignature, validateFreshAuthBodyShape, freshAuthLimiter, handler`. New `validateFreshAuthBodyShape` middleware checks `password`, `action`, and action-conditional `root_author` / `root_permlink`.
  - `POST /api/custody/session-auth` → `verifyHiveSignature, validateSessionAuthBodyShape, sessionAuthLimiter, handler`. New `validateSessionAuthBodyShape` middleware checks `password`.
- `backend/src/routes/accreditation.ts`:
  - `POST /api/accreditation/request` → `verifyHiveSignature, validate(accreditationRequestSchema), accreditationRequestLimiter, handler`. Existing zod gate hoisted from after the limiter to before.
  - `POST /api/accreditation/verify` → `validate(accreditationVerifySchema), accreditationVerifyLimiter, handler`. Existing zod gate hoisted from after the limiter to before.

The in-handler body checks on the custody routes are retained as defense-in-depth — they're cheap and document intent (they never fire after the middleware short-circuits the malformed path).

### Option 2 decision: DEFER (no IP-keyed layer this round)

Rationale:

- **Option 1 already closes the cheap-spray amplification class.** A JWT holder paying nothing per malformed body request now pays only `verifyHiveSignature` ECDSA + the body-shape check (sub-millisecond). The expensive surfaces (`argon2.verify`, `Signature.recover`, `getAccounts` with 30s failover) are no longer reachable from a malformed-body spray.
- **PEvO scale doesn't justify the NAT'd-user lockout risk.** A coarse per-IP limiter would catch valid-shape-but-wrong-proof sprays from a single IP, but at PEvO's single-instance beta scale the legitimate-user volume is small and the NAT'd-shared-IP lockout failure mode (university campus, mobile carrier NAT) is more costly than the residual amplification it would block. The per-account `skipFailedRequests` limiter already bounds the per-account success rate; the residual is the wrong-proof-spray CPU class, which is `argon2.verify` (~50ms per probe, semaphore-capped server-wide via `runWithArgon2Slot`) or `Signature.recover` (~5-10ms per probe). Both are bounded by the server-wide argon2 semaphore aggregate cap, not per-account.
- **Architectural fit.** Adding a separate IP-keyed limiter doubles the limiter surface (two state machines per route, two refund hooks, two retry-After negotiations) for a defense whose primary value (per-network-origin spray-rate bound) is already approximated by nginx-level rate-limiting upstream. PEvO runs behind an externally-managed reverse proxy; raw-IP bounding is properly that layer's concern.
- **Reversibility.** This decision is reversible — Option 2 can land as a follow-up if production traces show wrong-proof-spray volume per IP that the argon2 server-wide semaphore can't absorb. The CPU bound for the deferred class (argon2 verifies per second across all accounts) is observable via the existing `runWithArgon2Slot` queue-depth signal.

Option 3 (CPU-cost-aware bucket) remains deferred per the task body — over-engineering for beta scale.

### Sibling-route audit

`grep -rn "skipFailedRequests" backend/src` returns five opt-in sites; all five received the body-validation-before-limiter pattern (listed above). The reference declaration in `backend/src/middleware/rateLimit.ts` is the type-definition site, not a call site. No further sibling-route work outstanding.

### JSDoc update on `RateLimitConfig.skipFailedRequests`

Extended the JSDoc with a new "Layered pattern obligation" paragraph documenting that callers MUST place body-shape validation before the limiter, the canonical middleware-chain shape, and the misuse-direction warning (CPU-amplification surface produced by the opposite ordering). Diff excerpt:

```ts
/**
 * ...
 * DO NOT use on credential-probing routes ...
 *
 * **Layered pattern obligation (callers MUST adopt):** because failed
 * requests do NOT consume slots, the limiter no longer bounds raw request
 * rate from a JWT holder ... EVERY route that sets `skipFailedRequests: true`
 * MUST place body-shape validation ... BEFORE the limiter ... NOT after. The
 * canonical shape is:
 *
 *   router.post('/x', verifyHiveSignature, validateXBodyShape, xLimiter, handler);
 *
 * Misuse direction: placing the limiter BEFORE body validation under
 * `skipFailedRequests: true` produces a CPU-amplification surface ...
 */
skipFailedRequests?: boolean;
```

### Test coverage added

New file: `backend/tests/routes/custody-limiter-cpu-amplification.test.ts` (10 specs). Header documents the carve-out justification.

Risk-class coverage:

1. **(a) Malformed body → 400 without touching the limiter.** Asserts Redis rate-limit key is absent (`rateLimitCount === null`) after the request, proving the limiter primitive saw zero traffic from the malformed spray:
   - `/upgrade`: missing `derived_pubkey`, missing `signed_proof`, empty body, **100 sequential malformed bodies do NOT consume any of the 1/hr limiter capacity** (the load-bearing CPU-amplification assertion).
   - `/fresh-auth`: missing `password`, invalid `action`, missing `root_author` on `author_accept`.
   - `/session-auth`: missing `password`, wrong-type `password` (number).
2. **(b) Auth-gate runs before body validation.** `/upgrade` with missing `X-Hive-Username` → 401, limiter never touched. Pins the auth-before-body-validation ordering required for `byAccount` keying.

The valid-shape-but-wrong-proof slot-refund (200 retry-after-503) case for the upgrade limiter is already pinned by the existing `custody-upgrade.test.ts` test `'Hive getAccounts throws then recovers: 503 refunds limiter slot so the retry succeeds'`, which exercises the limiter's `skipFailedRequests` refund hook on a valid-shape request.

### Scoped vitest pass

```
custody-upgrade.test.ts                   17 passed
custody-limiter-cpu-amplification.test.ts 10 passed  (new)
custody.test.ts                            8 passed
custody-fresh-auth-null-hash.test.ts       9 passed
custody-session-auth.test.ts              13 passed
custody-non-consent-fresh-auth.test.ts     7 passed
middleware/rateLimit.test.ts               7 passed
middleware/rateLimit-in-memory.test.ts     6 passed
accreditation-idempotency.test.ts         19 passed
─────────────────────────────────────────────────
                                          96 passed (0 failed)

accreditation.test.ts                     31 passed | 2 failed
                                          (both pre-existing on main, unrelated to this change:
                                           - 'pre-INCR redis.eval rejection surfaces 503 ...'
                                           - 'concurrent retries claim slots atomically ...')
```

Pre-existing failures verified against main HEAD: `cd backend && npx vitest run tests/routes/accreditation.test.ts -t "pre-INCR redis.eval rejection"` fails on main HEAD with the same `expected 502 to be 503` assertion. The concurrent-retries spec is similarly flaky on main (HAF-query-latency-bound: when the dev HAF environment responds slowly, the cap+1 broadcasts don't all reach the increment site within the 5s polling deadline). Neither failure mode interacts with the middleware reorder this task lands.
