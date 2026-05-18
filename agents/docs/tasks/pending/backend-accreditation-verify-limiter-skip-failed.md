# BACKEND-ACCREDITATION-VERIFY-LIMITER-SKIP-FAILED — accred-verify limiter + 503 Retry-After

**Owner:** Backend
**Created:** 2026-05-17 (architect, surfaced by `/ce-code-review` cluster pass on `backend-accreditation-existing-accreditation-gate` round-3)
**Priority:** P2 (UX cascade during HAF outage; not deploy-blocking but user-visible)

## Problem

Two related gaps on `POST /api/accreditation/verify` make round-3's 503 `ACCREDITATION_GATE_UNAVAILABLE` design intent ("token preserved so the user can retry once HAF recovers") fail in practice during a HAF outage.

### Gap 1: `accreditationVerifyLimiter` lacks `skipFailedRequests`

`backend/src/routes/accreditation.ts:36` declares `accreditationVerifyLimiter = rateLimit({ name: 'accred-verify', windowMs: 60_000, max: 5, keyFn: byIp })`. No `skipFailedRequests`. Every 503 (HAF outage, gate-throw path) consumes one of the IP's 5 slots per 60s. The legitimate user refreshing the verify-page during HAF outage burns 5 slots → 429 RATE_LIMITED for the next ~60s — blocked from reaching the route handler at all even after HAF recovers.

### Gap 2: 503 omits `Retry-After` header

`backend/src/routes/accreditation.ts:552-558` returns 503 with `details.retriable: true` but no `Retry-After` header. The SPA's `ApiRequestError` infrastructure (`frontend/src/api.js:28-33,63-71`) already parses `Retry-After` into `err.retryAfterSeconds`; the backend just doesn't emit one. Without server-driven cadence, any retry timing is whatever the SPA decides (or user-driven, which compounds Gap 1).

## Goal

(1) Add `skipFailedRequests: true` to `accreditationVerifyLimiter` so 503 responses refund the IP slot. (2) Emit a `Retry-After: 30` header on the 503 `ACCREDITATION_GATE_UNAVAILABLE` path so layered consumers (SPA + nginx + any future auto-retry middleware) share a coherent backoff floor.

## Acceptance

### 1. Limiter config change

`backend/src/routes/accreditation.ts:36` opts in to `skipFailedRequests: true`. Mirrors `upgradeLimiter` and `accreditationRequestLimiter` shapes:

```ts
const accreditationVerifyLimiter = rateLimit({
  name: 'accred-verify',
  windowMs: 60_000,
  max: 5,
  keyFn: byIp,
  skipFailedRequests: true,
});
```

### 2. `Retry-After` header on the 503 gate-unavailable path

Set `res.set('Retry-After', '30')` immediately before the existing `sendError(res, 503, 'ACCREDITATION_GATE_UNAVAILABLE', ...)` at `accreditation.ts:552-558`. Header value is operator-tunable but 30s is a reasonable default for HAF-outage recovery cadence.

### 3. Verify 4xx-vs-5xx semantics on /verify

Audit the route's full error surface (4xx validation, 422 already-verified, 5xx HAF-unavailable, 5xx broadcast-failed). Confirm which paths emit which status. Document in the implementer signal block. `skipFailedRequests: true` refunds on ANY `statusCode >= 400` per `rateLimit.ts:100-101` — that's intentional (sibling pattern in `accred-req`). 4xx paths short-circuit before expensive work so the refund-on-4xx is acceptable.

### 4. Test: 503 refunds the IP slot

Add a backend integration test mirroring `backend/tests/routes/custody-upgrade.test.ts:518` shape: drive a 503 ACCREDITATION_GATE_UNAVAILABLE response (mock the gate-query to throw via `hafQueryMock.mockRejectedValueOnce`), assert the response status is 503, then assert the next request from the same IP does NOT 429.

### 5. Test: 503 emits `Retry-After: 30`

Extend the round-3 503 spec in `backend/tests/routes/accreditation-idempotency.test.ts` (the spec asserting `gate HAF throw returns 503 ACCREDITATION_GATE_UNAVAILABLE — token preserved, no broadcast, no cap INCR`) to also assert `res.headers['retry-after'] === '30'`.

### 6. No contract change needed at implementer time

`agents/docs/api-contracts/accreditation.md` will be updated by the architect at archive time for this task; flag via `[TODO Architect]` in the implementer signal block. The contract addition is small: note the `Retry-After: 30` emission on the gate-unavailable 503 path.

## Out of scope

- `accreditationRequestLimiter` already has `skipFailedRequests: true` (landed in `backend-accreditation-limiter-skip-failed`, currently in pending/ with hold-block round-2). No change there.
- Splitting `skipFailedRequests` into `skipServerErrors` vs `skipClientErrors` discriminators (architect explicitly declined in `backend-accreditation-limiter-skip-failed` review).
- SPA-side retriable-aware UI (separate task: `ui-accreditation-verify-retriable-handling`).
- The cached idempotency-hit availability regression during HAF outage (gate runs first and 503s; cache unreachable). Architect chose "document and accept" — handled at archive time for `backend-accreditation-existing-accreditation-gate`.

## Source

- `/ce-code-review` cluster pass on Accreditation/ORCID review, 2026-05-17.
- Triage decision: file as separate backend task (rather than fold into the closing `backend-accreditation-existing-accreditation-gate` archive) so the change ships with its own test verification and operator dashboard impact (the `Retry-After` header is observable on the wire).

## Cross-references

- `backend/src/routes/accreditation.ts:36` — limiter declaration.
- `backend/src/routes/accreditation.ts:552-558` — 503 emit site.
- `backend/src/middleware/rateLimit.ts:100-109` — `skipFailedRequests` semantics.
- `backend/src/routes/custody.ts:52` — sibling `upgradeLimiter` shape.
- `backend/tests/routes/custody-upgrade.test.ts:518` — sibling slot-refund canary.
- `agents/docs/solutions/conventions/wrapping-primitive-exhaustive-call-site-audit-2026-04-22.md` — audit-by-grep convention.

## Implementer signal (Backend, 2026-05-17)

Round 1 landed at commit `15856a5`. All 6 acceptance items addressed in a single commit.

**Files touched:**
- `backend/src/routes/accreditation.ts` — added `skipFailedRequests: true` to `accreditationVerifyLimiter` (now at line 55 after the preamble comment, was at line 36); added `res.set('Retry-After', '30')` at line 578, immediately before the 503 `ACCREDITATION_GATE_UNAVAILABLE` `sendError`. Preamble comment on the limiter explicitly enumerates the route's full 4xx-vs-5xx surface (acceptance #3 below) and the rationale for the symmetric refund.
- `backend/tests/routes/accreditation-idempotency.test.ts` — (a) extended the existing round-3 503 spec (`gate HAF throw returns 503 ACCREDITATION_GATE_UNAVAILABLE — token preserved, no broadcast, no cap INCR (round-3 α)`) with a `expect(res.headers['retry-after']).toBe('30')` assertion (acceptance #5); (b) added new spec `503 ACCREDITATION_GATE_UNAVAILABLE refunds the per-IP limiter slot (skipFailedRequests canary)` inside the `existing-accreditation gate (user-level)` describe block, mirroring `backend/tests/routes/custody-upgrade.test.ts:518` shape — drives 5 consecutive 503s (filling the 5/60s bucket), then issues a 6th `/verify` from the same IP and asserts `not.toBe(429)` plus `toBe(503)` (acceptance #4). Each iteration uses a unique seeded token (`accred-idem-refund-N-*`) so the `afterEach` `pending_accred:accred-idem-*` cleanup catches them.

**Acceptance #3 — 4xx-vs-5xx audit on `POST /api/accreditation/verify`:**

The route currently emits the following statuses, all of which trigger the slot refund under `skipFailedRequests: true` (`rateLimit.ts:100-101` refund branch keys on ANY `res.statusCode >= 400`):

| Status | Code | Site | Class | Comment |
|--------|------|------|-------|---------|
| 400 | `BAD_REQUEST` | line 431 — `Invalid or expired token` | 4xx | Short-circuits BEFORE HAF probes / broadcast / Redis-write side effects. Symmetric refund is acceptable: probing only costs Redis-rate-limit ops. |
| 500 | `INTERNAL_ERROR` | line 437 — `Admin posting key not configured` | 5xx | Operator-misconfiguration; not user-triggered. Refund is irrelevant in practice (would only fire on deployment misconfig). |
| 502 | `BROADCAST_ATTEMPT_LIMIT_EXCEEDED` | line 775 — cap-exceeded soft-block | 5xx | Token-scoped cap (separate counter from the IP limiter). Refund of the IP slot is acceptable because the cap counter is independent. |
| 502 | `POST_BROADCAST_OPERATOR_REQUIRED` | via `handleBroadcastError` → permanent severity | 5xx | Post-broadcast cascade failure. IP-slot refund is harmless: the chain op already landed; the user reaching the route again does not double-broadcast (idempotency gate + HAF check catch it). |
| 502 | `POST_BROADCAST_FAILED` | via `handleBroadcastError` → transient severity | 5xx | Same reasoning as `POST_BROADCAST_OPERATOR_REQUIRED`. |
| 503 | `ACCREDITATION_GATE_UNAVAILABLE` | line 579 — gate HAF query throw | 5xx | **This task's target.** HAF outage; user expected to retry once HAF recovers. Refund is load-bearing — without it the user trips 429 mid-outage. |
| 503 | `SERVICE_UNAVAILABLE` | line 738 — pre-INCR counter failure | 5xx | Redis flap at the cap counter. Same refund rationale as 503 gate-unavailable. |
| 504 | `BROADCAST_TIMEOUT` | via `handleBroadcastError` | 5xx | Hive RPC timeout. Refund acceptable (transient blip; user retry is the intended flow). |

The audit confirms no 4xx path on `/verify` has an expensive precondition (HAF query, broadcast, Redis write) that the symmetric refund would let an attacker exploit. The 400 `BAD_REQUEST` path returns BEFORE the admin-key check, the HAF probes, and the broadcast cap counter. A future change inserting an expensive operation BEFORE the `getToken` lookup would need to add its own throttle (the limiter's symmetric refund will not rate-limit pre-handler probes). This matches the `accreditationRequestLimiter` rationale already inlined as a preamble comment above the limiter (`accreditation.ts:25-38`).

**Acceptance #6 — `[TODO Architect]` contract update note:**

`agents/docs/api-contracts/accreditation.md` does not currently document the `Retry-After` header emission on the 503 `ACCREDITATION_GATE_UNAVAILABLE` path. Architect: please add at archive time. Suggested text under the existing 503 row: `Emits Retry-After: 30 (server-driven backoff floor). SPA parses it into err.retryAfterSeconds via frontend/src/api.js:28-33,63-71.`

**Verification:**
- `npm run typecheck` (backend) — clean.
- `npm run lint` (backend) — clean.
- Targeted vitest: `tests/routes/accreditation-idempotency.test.ts` — all 13 specs pass (12 prior + 1 new slot-refund canary). New spec runtime: ~25ms.

---

## Architect round-1 re-review (2026-05-18) — HELD PENDING FIXES

`/ce-code-review` cluster-pass on commit `be457dc` dispatched 9 reviewers: correctness, testing, maintainability, project-standards, security, reliability, adversarial, api-contract, kieran-typescript, ce-learnings-researcher (skipping `ce-agent-native-reviewer` per root CLAUDE.md). Cross-reviewer corroboration on the asymmetric Retry-After concern (reliability × adversarial × api-contract, promoted to anchor 100). The round-1 implementation is functionally correct in scope — `skipFailedRequests: true` lands cleanly, `Retry-After: 30` survives `sendError`, the 503-refund canary mirrors the sibling pattern correctly. Three items held; all in the same file (`accreditation.ts`) + test file, bundle into one round-2 commit.

### Item 1 — Sibling 503 SERVICE_UNAVAILABLE path also emits `retriable: true` but no `Retry-After`

**Severity:** P2 · **Cross-corroborated:** reliability × adversarial × api-contract (conf 100)
**File:** `backend/src/routes/accreditation.ts:762-768` (pre-INCR Redis-counter failure 503 path)

`/verify` has two retriable 503 branches:
- 503 `ACCREDITATION_GATE_UNAVAILABLE` — round-1 NOW emits `Retry-After: 30` ✓
- 503 `SERVICE_UNAVAILABLE` (pre-INCR Redis-counter failure) — emits `details.retriable: true` but NO `Retry-After`

The SPA's `frontend/src/api.js` parses `Retry-After` into `err.retryAfterSeconds`. Absent → `null` → `_startCooldown(null)` → `initial = 0` → no cooldown → Retry button immediately clickable. Combined with the new `skipFailedRequests: true`, every spam-click refunds the slot. The amplification is bounded only by user fatigue + the broadcast-cap token-counter, NOT by the IP limiter (which the round-1 preamble comment just declared as "the coherent backoff floor"). The task's preamble claim "shared coherent backoff floor" is incomplete with one of two retriable 503 branches uncovered.

**Fix shape:** one-line edit. Add `res.set('Retry-After', '30');` before the existing `sendError(res, 503, 'SERVICE_UNAVAILABLE', ...)` at the pre-INCR branch. Mirrors the GATE_UNAVAILABLE pattern exactly. Add a test pin (`expect(res.headers['retry-after']).toBe('30')`) on the existing SERVICE_UNAVAILABLE spec.

### Item 2 — Preamble comment on `accreditationVerifyLimiter` cites four line-number anchors (two already stale)

**Severity:** P2 · **Source:** maintainability M1 (conf 90)
**File:** `backend/src/routes/accreditation.ts` (preamble comment block on the new limiter declaration, ~lines 40-58)

The new preamble enumerates the 4xx/5xx status surface with raw line citations: `accreditation.ts:552-558`, `rateLimit.ts:100-101`, `accreditation.ts:436`, `accreditation.ts:442`. Per `docblock-anchor-stable-symbols-not-line-numbers-2026-05-15.md`, line numbers are the rot warning sign. The sibling preamble on `accreditationRequestLimiter` (lines 25-38) shows the correct identifier-only pattern.

Bonus: `:436` and `:442` are already stale at write time — actual lines are `:455` and `:461`. The `rateLimit.ts:100-101` reference is wrong-as-written (lines 100-101 are not the refund branch; the gate is at line 156). The same wrong-as-written `rateLimit.ts:100-101` appears in the round-2 sibling task `backend-accreditation-limiter-skip-failed` test comments — both should use `RateLimitConfig.skipFailedRequests` JSDoc as the stable anchor.

**Fix shape:** strip the line spans from the preamble. Anchor on the status code + error code identifiers (the symbolic name `ACCREDITATION_GATE_UNAVAILABLE`, `BROADCAST_ATTEMPT_LIMIT_EXCEEDED`, etc.) and the `RateLimitConfig.skipFailedRequests` JSDoc. Match the sibling preamble's shape exactly.

### Item 3 — Test slug citations `BACKEND-ACCREDITATION-VERIFY-LIMITER-SKIP-FAILED acceptance #N:`

**Severity:** P2 · **Source:** maintainability M2 (conf 95)
**File:** `backend/tests/routes/accreditation-idempotency.test.ts:540, 580`

Two new test-block headers lead with `BACKEND-ACCREDITATION-VERIFY-LIMITER-SKIP-FAILED acceptance #N:` slug references. Per `task-slug-citations-in-comments-go-stale-on-archive-2026-05-15.md`, these rot on archive — once `tasks-archive.md` trims past 250 lines the slug becomes unfindable. The technical body below each slug header is genuinely useful prose; only the slug prefix needs to go.

**Fix shape:** drop the `BACKEND-ACCREDITATION-VERIFY-LIMITER-SKIP-FAILED acceptance #N:` prefix at both sites. Keep the technical content describing what each spec pins. Optionally anchor on the behavioral description (e.g., "503 refunds the per-IP limiter slot — pins `skipFailedRequests: true` against a mutation that would reintroduce slot consumption on transient HAF outage").

### Files for round-2

- `backend/src/routes/accreditation.ts` (Items 1 + 2)
- `backend/tests/routes/accreditation-idempotency.test.ts` (Items 1 + 3)
- This task file (round-2 implementer signal block when moving back to review/)

### Architect archive-time follow-ups (recorded for the eventual archive)

- **`agents/docs/api-contracts/accreditation.md`** ACCREDITATION_GATE_UNAVAILABLE row (line ~146) must document `Retry-After: 30` emission. **Now expanded** by round-2 Item 1: also document `Retry-After: 30` on the SERVICE_UNAVAILABLE row (line ~145, currently says "No Retry-After header" — the round-2 fix will change this). Update `common.md:86` cross-cutting note accordingly. Architect lands at archive time.
- **`skip-failed-requests-jwt-required-credential-verify-carve-out-2026-05-17.md` audit grid** add a new row for `accreditationVerifyLimiter` (per-IP, 5/60s, skipFailed=true). The grid is the convention's enforcement artifact. Architect updates at archive time.

### Dismissed at architect triage (recorded for transparency)

- **Token brute-force amplification via symmetric refund on 400 BAD_REQUEST** (security R1 conf 90 informational): the 400-invalid-token path refunds the slot, effectively removing the per-IP brute-force cap. NOT exploitable due to 256-bit token entropy (`crypto.randomBytes(32).toString('hex')`). The limiter never bounded brute-force meaningfully; entropy did.
- **503 status as token-validity oracle during HAF outage** (security R2 conf 80 informational): pre-existing; the 503 fires only after `getToken` returns non-null. Not regressed by this diff.
- **500 INTERNAL_ERROR path (missing admin key) deletes token before responding** (security R3 conf 85 informational): operator-misconfiguration path; attacker reaching it must already know a valid token, so not a discovery vector.
- **30s Retry-After fixed cadence — no jitter** (reliability R2 conf 60 below gate): thundering-herd on HAF recovery. PEvO single-instance, small user population; not realizable at scale.
- **Tight-loop slot-refund canary may race deferred DECR refund** (testing T1 conf 70 below gate): the test passes locally and mirrors precedent; theoretical timing race only.
- **Slot-refund canary doesn't pin Retry-After + retriable on the 6th call** (testing T2 conf 75 advisory): focus boundary; sibling round-3 503 spec covers it. Per `feedback_dismiss_preemptive_test_hardening`.

---
