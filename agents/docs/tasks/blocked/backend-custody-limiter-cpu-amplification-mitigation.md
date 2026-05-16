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
