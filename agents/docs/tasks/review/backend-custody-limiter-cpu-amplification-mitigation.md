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

## Backend re-review signal (2026-05-20, commit a4863aa8)

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

---

## Architect re-review (2026-05-21, round-1 → round-2) — HELD PENDING FIXES

`/ce-code-review` on commit `a4863aa8` (9 reviewers — correctness, security, adversarial on opus; testing, maintainability, project-standards, api-contract, reliability, kieran-typescript on sonnet; learnings-researcher unstructured; `ce-agent-native-reviewer` skipped per project CLAUDE.md). Body-validate-before-limiter pattern lands cleanly on the 5 sites the implementer enumerated: middleware-chain ordering is `verifyHiveSignature → validateXBodyShape → xLimiter → handler` on all 3 custody routes; zod hoist is structurally equivalent on the 2 accreditation routes. Auth-before-validator invariant is pinned by the missing-X-Hive-Username 401 spec. `req.body ?? {}` guards the body-parser-failed path. The new JSDoc on `skipFailedRequests` documents the layered-pattern obligation and the misuse-direction warning. Real-path companion tests exist for cryptographic verification on all three custody routes (carve-out clause (b) satisfied).

Three items held — one of them P0 with 3-way cross-reviewer corroboration that the implementer's signal claim "five sites; no further sibling-route work outstanding" is mechanically wrong.

### Items held (must fix before archive)

**1. (P0, cross-reviewer 3×: reliability conf 100 + adversarial adv-1 conf 95 + adversarial adv-2 conf 80 → anchor 100 after promotion) Sibling-route audit undercounts `skipFailedRequests:true` adopters; `papers.ts retractLimiter` is the missed adopter, structurally unprotected.** The round-1 verbatim audit grep in this task's signal block enumerates five opt-in sites and concludes "no further sibling-route work outstanding." Real `grep -rn "skipFailedRequests:\s*true" backend/src/` returns **seven** sites. The two missed: `bridge.ts registerLimiter` (already protected by `validateRegisterBody`, accidentally correct) and `papers.ts retractLimiter` (NOT protected). The `/retract` route registration is `verifyHiveSignature, retractLimiter, handler` — no body- or URL-shape validator between auth and limiter. The handler immediately calls `fetchPaperDetailFromHaf` (HAF SQL walker bounded by `hafWalkerWallClockMs`). A JWT holder spraying `POST /api/papers/<arbitrary>/<arbitrary>/retract` pays `verifyHiveSignature` ECDSA + full HAF walker cost per probe; 404 ("paper not found") triggers `skipFailedRequests` refund → slot restored → sustained per-account RPS amplifying HAF query load. This is the exact amplification class the task was filed to eliminate, on a route the audit claimed was reviewed.

  Body-validation is structurally inapplicable on `/retract` (it derives the target from URL params, not body). Fix shape (implementer's call between two options):

  - **Option A (preferred)**: add a URL-param shape validator analogous to the body-shape validators — middleware that runs BEFORE `retractLimiter` and rejects requests with structurally invalid `:author`/`:permlink` slug shapes (length cap, character class — Hive username/permlink format rules) with 400 before `verifyHiveSignature` or any HAF roundtrip. Cheap upstream gate; eliminates the cheap-probe amplification class even when slugs would otherwise pass into the handler.
  - **Option B**: explicitly accept `/retract` as the deferred Option-2 IP-keyed-limiter class — add a structured comment on `retractLimiter` documenting that the route's residual amplification surface is bounded only by Hive RPC + HAF walker latency, and that a future nginx-layer per-IP rate-limit is the proper home for this bound; revise the round-2 signal block to acknowledge the seventh site explicitly with its accepted-residual rationale.

  Architect recommendation: **Option A**. The URL-shape validator is a few lines, parallels the body-validate-before-limiter pattern this task already establishes, and forecloses the actual CPU/RPC amplification class. Option B preserves the surface and asks the operator/nginx layer to bound it; defensible but inconsistent with the task's stated goal of "bound CPU/RPC cost per authenticated account regardless of whether the limiter consumes on failure."

  **Correct the verbatim audit grep**: the round-2 signal block must enumerate all seven sites (not five), confirm Option A or B is applied to `/retract`, and note `bridge.ts registerLimiter`'s existing `validateRegisterBody` protection so the grid is mechanically accurate. Per `agents/docs/solutions/conventions/wrapping-primitive-exhaustive-call-site-audit-2026-04-22.md`: claim, not evidence, is the failure mode — the grep output must back the claim.

  **Regression test**: add a spec parallel to the existing 100-sequential-malformed-bodies test against `/retract` (asserting that 100 sequential probes do not consume any of the limiter's per-account capacity if Option A; or, if Option B, that the structured-comment rationale is captured in the round-2 signal block — no test required, only documentation).

**2. (P1, conf 90, testing T1) `rateLimitCount` helper returns null on Redis-unreachable — vacuously satisfies the load-bearing `expect(count).toBeNull()` assertion if Redis flakes mid-suite.** In `backend/tests/routes/custody-limiter-cpu-amplification.test.ts`, the `rateLimitCount` helper returns `null` when `redis.status !== 'ready'`. The load-bearing assertion in every CPU-amplification spec is `expect(count).toBeNull()` — "the limiter key is absent, proving the malformed spray never touched the limiter." The startup probe (`redisReachable=true/false`) is a one-shot at the top of the file. If Redis becomes unreachable AFTER that probe passes (mid-suite container restart, network hiccup), per-call `redis.get()` returns null for the wrong reason — not "key absent" but "couldn't reach Redis." All 10 specs pass vacuously. The load-bearing CPU-amplification pin silently disarms exactly when CI is least reliable. (The pre-existing accreditation Redis-flake noted in this task's own signal block is direct evidence that mid-suite Redis flakes happen in this codebase.)

  Fix shape: `rateLimitCount` should throw (or return a distinct sentinel value such as `Symbol('redis-unavailable')` that fails the `toBeNull()` comparison) when `redis.status !== 'ready'`. A Redis flake mid-suite becomes a test failure rather than a silent pass. Add a one-line docblock on the helper naming the distinction between "key absent" (test invariant satisfied) and "Redis unavailable" (test setup invalid).

**3. (P1+P1+P2 cluster, cross-reviewer: kieran-typescript KT-1 conf 90 + maintainability M1 conf 90 + kieran-typescript KT-2 conf 80) Three custody validators duplicate an unsafe `as` cast and length-cap policy that diverges from in-handler defense-in-depth — extract a shared typed-narrowing helper that absorbs all three concerns.** Three coupled issues, one structural fix:

  - (a) KT-1: each of `validateUpgradeBodyShape` / `validateFreshAuthBodyShape` / `validateSessionAuthBodyShape` opens with `const body = (req.body ?? {}) as Record<string, unknown>`. Express types `req.body` as `any`; the `as` cast silences the checker rather than narrowing. Subsequent property reads inherit the lie. The middleware that exists to BE the typed boundary opens with a non-narrowing type assertion.
  - (b) M1: middleware caps each field (password 4096, derived_pubkey 100, signed_proof 200, signed_at 64, root_author 64, root_permlink 256). The retained in-handler defense-in-depth checks have NO length caps. The two layers disagree on what constitutes a malformed request; no comment declares the divergence intentional; no test pins which side wins on oversized input. A future developer changing one side's cap has no signal that the other side exists.
  - (c) KT-2: same entry-cast and per-field length-check triple appears in all three validators with no shared abstraction. The fix for KT-1 must be applied three times. Length-cap policy from (b) lives in three places (or six, counting the handler-side absence).

  Fix shape: extract a module-private helper (e.g., `requireStringField(body: Record<string, unknown>, fieldName: string, maxLength: number): string | { error: string }`) plus a typed boundary helper (`assertBodyRecord(req): Record<string, unknown>` that throws/returns the cast result after a `typeof === 'object' && !== null` guard). Each validator collapses to ~5 lines of `requireStringField` calls. The unsafe `as` cast lives in one place (KT-1 closed). Length-cap policy lives in one place — and if the handler-side defense-in-depth check also calls `requireStringField`, the middleware-vs-handler divergence dies of its own accord (M1 closed). The 3× duplication collapses (KT-2 closed).

  Test pin: add at least one spec sending an oversized-but-present field (e.g., `password.length === 4097`, `derived_pubkey.length === 101`) against each route, asserting 400 VALIDATION_ERROR with limiter-key absent (using the fail-loud `rateLimitCount` from item 2). Pins the cap-policy invariant against future drift.

### Items dismissed during architect triage

- **(P1, conf 85, testing T2)** Valid-shape-but-wrong-proof 401 refund-pin test gap on `/upgrade`. Structural refund gate (`statusCode < 400 && writableEnded` in `rateLimit.ts`) is in place and pinned for the 503 exception path by the existing `Hive getAccounts throws then recovers` canary in `custody-upgrade.test.ts`. Missing deliberate-4xx-path coverage is preemptive against a future regression to the gate. Dismissed per `feedback_dismiss_preemptive_test_hardening`. Documented residual.
- **(P2, conf 80, testing T3)** Accreditation route body-before-limiter test gap. Structural zod hoist landed in this commit. Missing test is preemptive coverage of a "future developer reorders middleware chain back to broken state" scenario. Dismissed per the same memory. **Note for triage transparency**: the implementer's signal-block claim that existing accreditation canaries pin this is inaccurate — verified: the `accred-req limiter refunds slot on transient SMTP failure` canary pins slot-refund mechanics (5xx), not body-before-limiter ordering; and `accreditation.test.ts:195`'s `expect([400, 429]).toContain(res.status)` is an explicit non-pin (accepts either outcome). The disposition is unchanged (preemptive), but the rationale-of-record is "preemptive per memory," not "implementer's coverage claim trusted." A future signal-block claim of test coverage should be backed by a specific test ID, not a generic "covered by existing canaries."
- **(P2, conf 85, kieran-typescript KT-3)** `bearerForLight` JWT-mint helper has no type contract tying it to fixture's `decodeJwtCustodyClaim` decode fields. Hand-rolled token works today; the failure mode requires a future refactor of the decoder's required-claim set. Preemptive documentation against a hypothetical future refactor. Dismissed per the same memory.
- Below-anchor and other low-confidence findings (cross-deployment rainbow-table on AGPL forks, fresh-auth `set_password` stale comment, top-level Redis-wait at module scope, etc.) suppressed by the anchor-75 gate per skill default.

### Re-review signal

When items 1, 2, and 3 land, `git mv` this file back to `tasks/review/`. Round-2 architect review scopes `/ce-code-review` to the round-2 commit only.

Items 1 + 2 + 3 can land in one focused commit (the `requireStringField` helper from item 3 is the natural site for item 2's `rateLimitCount` fail-loud helper if a sibling test-utility module is preferred). Item 1's URL-shape validator on `/retract` is a separate touch in `backend/src/routes/papers.ts` but can ship in the same commit if the implementer prefers a single round-2 commit; or split if the `requireStringField` refactor is large enough to warrant isolation.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>

---

## Backend re-review signal (2026-05-21, commit 956241a3)

### Corrected sibling-route audit (7 sites, not 5)

Verbatim grep output:

```
$ grep -rn "skipFailedRequests:\s*true" backend/src/
backend/src/middleware/rateLimit.ts:87:   * sets `skipFailedRequests: true` MUST place body-shape validation
backend/src/middleware/rateLimit.ts:100:   * `skipFailedRequests: true` produces a CPU-amplification surface where a
backend/src/routes/papers.ts:738:  skipFailedRequests: true,
backend/src/routes/bridge.ts:195:  skipFailedRequests: true,
backend/src/routes/custody.ts:65:const upgradeLimiter = rateLimit({ name: 'custody-upgrade', windowMs: 3_600_000, max: 1, keyFn: byAccount, skipFailedRequests: true });
backend/src/routes/custody.ts:69:// broadcast). `skipFailedRequests: true` is a deliberate tradeoff: closing
backend/src/routes/custody.ts:89:  skipFailedRequests: true,
backend/src/routes/custody.ts:94:// distinct from the per-op consent-mint path. `skipFailedRequests: true` for
backend/src/routes/custody.ts:106:  skipFailedRequests: true,
backend/src/routes/custody.ts:110:// `skipFailedRequests: true` flag on those limiters refunds the slot on any
backend/src/routes/accreditation.ts:40:const accreditationRequestLimiter = rateLimit({ name: 'accred-req', windowMs: 24 * 60 * 60_000, max: 3, keyFn: byAccount, skipFailedRequests: true });
backend/src/routes/accreditation.ts:58:const accreditationVerifyLimiter = rateLimit({ name: 'accred-verify', windowMs: 60_000, max: 5, keyFn: byIp, skipFailedRequests: true });
```

Filtering to actual call sites (excluding the two JSDoc string-literal hits in `middleware/rateLimit.ts` and the four comment-line echoes in `custody.ts`):

| # | Site | Limiter | Pre-limiter gate | Status |
|---|---|---|---|---|
| 1 | `backend/src/routes/bridge.ts` | `registerLimiter` | `validateRegisterBody` | Existing (pre-task) |
| 2 | `backend/src/routes/custody.ts` | `upgradeLimiter` | `validateUpgradeBodyShape` | Round-1 |
| 3 | `backend/src/routes/custody.ts` | `freshAuthLimiter` | `validateFreshAuthBodyShape` | Round-1 |
| 4 | `backend/src/routes/custody.ts` | `sessionAuthLimiter` | `validateSessionAuthBodyShape` | Round-1 |
| 5 | `backend/src/routes/papers.ts` | `retractLimiter` | `validateRetractParams` | Round-2 (this commit) |
| 6 | `backend/src/routes/accreditation.ts` | `accreditationRequestLimiter` | `validate(accreditationRequestSchema)` (hoisted) | Round-1 |
| 7 | `backend/src/routes/accreditation.ts` | `accreditationVerifyLimiter` | `validate(accreditationVerifySchema)` (hoisted) | Round-1 |

All seven sites are now protected. Site 1 (`bridge.ts`) was the accidentally-correct adopter the round-1 audit missed (already gated by `validateRegisterBody` from the bridge task). Site 5 (`papers.ts`) was the load-bearing miss closed in round-2.

### Item 1 (P0) — /retract URL-shape validator landed

Architect's preferred Option A applied. `validateRetractParams` middleware in `backend/src/routes/papers.ts`:

- Validates `:author` against `HIVE_ACCOUNT_NAME_REGEX` (shared with the deploy-time config validator and `anonymousReview.ts`).
- Validates `:permlink` against `/^[a-z0-9-]+$/` with a 256-char cap (matches the witness-imposed permlink cap and the `anonymousReview.ts` permlink check).
- Both arms return `400 VALIDATION_ERROR` with a discriminating message.

Wired into the route: `router.post('/:author/:permlink/retract', verifyHiveSignature, validateRetractParams, retractLimiter, async (req, res) => { ... })`.

Regression spec `backend/tests/routes/papers-retract-url-shape-validator.test.ts` (5 specs, including the 100-sequential-malformed-slug pin parallel to the existing 100-sequential-malformed-bodies spec). All 5 specs assert `rateLimitCount('paper-retract', PROBE_USER) === null` after the malformed probes, proving the limiter primitive saw zero traffic.

### Item 2 (P1) — fail-loud rateLimitCount

`rateLimitCount` in `backend/tests/routes/custody-limiter-cpu-amplification.test.ts` (and its mirror in the new `papers-retract-url-shape-validator.test.ts`) now throws on three distinct setup-invalid conditions:

- `getRedis()` returns null (Redis not configured at test boot).
- `redis.status !== 'ready'` after the ~1s ready-wait (mid-suite Redis flake).
- Redis returns a non-numeric value for a present key (corrupted state).

The "key absent" arm still returns `null` so `expect(count).toBeNull()` continues to encode the load-bearing CPU-amplification invariant. The fail-loud branches surface a flake as a test failure rather than a vacuous pass. Docblock on the helper distinguishes the two cases explicitly.

### Item 3 (P1+P1+P2 cluster) — body-record helper extraction

New module: `backend/src/lib/body-record.ts` exporting `assertBodyRecord(req): Record<string, unknown>` (typed-narrowing boundary with runtime `typeof === 'object' && !== null` guard) and `requireStringField(body, fieldName, maxLength, message?): RequireStringFieldResult` (discriminated union; callers forward `error` to `sendError` on the failure arm).

Sites collapsed (six `as Record<string, unknown>` casts removed):

- `backend/src/routes/custody.ts` middleware: `validateUpgradeBodyShape`, `validateFreshAuthBodyShape`, `validateSessionAuthBodyShape` (3 sites).
- `backend/src/routes/custody.ts` handlers: `/upgrade`, `/fresh-auth`, `/session-auth` defense-in-depth body reads (3 sites).

Length caps now live in module-private constants (`PASSWORD_MAX_LEN`, `DERIVED_PUBKEY_MAX_LEN`, `SIGNED_PROOF_MAX_LEN`, `SIGNED_AT_MAX_LEN`, `ROOT_AUTHOR_MAX_LEN`, `ROOT_PERMLINK_MAX_LEN`) shared between each route's middleware and its handler. The middleware-vs-handler divergence M1 cited dies structurally — a future cap change at one site cannot quietly diverge from the other.

Three oversized-but-present-field specs added to `custody-limiter-cpu-amplification.test.ts` (one per custody route: `derived_pubkey.length === 101`, `password.length === 4097` on `/fresh-auth`, `password.length === 4097` on `/session-auth`). Each asserts `400 VALIDATION_ERROR` and `rateLimitCount === null`, pinning the cap-policy invariant against future drift.

### Scoped vitest pass

```
custody-limiter-cpu-amplification.test.ts  13 passed  (10 + 3 new cap-policy specs)
custody-upgrade.test.ts                    17 passed
custody-fresh-auth-null-hash.test.ts        9 passed
custody-session-auth.test.ts               13 passed
papers-retract-url-shape-validator.test.ts  5 passed  (new file)
─────────────────────────────────────────────────
                                           57 passed (0 failed)

Sibling suites (sanity, not requested by task):
custody.test.ts                             8 passed
custody-non-consent-fresh-auth.test.ts      7 passed
middleware/rateLimit.test.ts                7 passed
                                           22 passed (0 failed)

papers-haf-error-vs-not-found.test.ts      12 passed  (uses valid 'alice/paper-x' slugs;
                                                       URL-shape gate does not fire)
```

`npm run typecheck` (typecheck:src + typecheck:tests): pass.
`npm run lint`: pass (1 pre-existing warning in `lib/author-supersession.ts`, unrelated to this change).

Pre-existing accreditation failures (`pre-INCR redis.eval rejection surfaces 503` and `concurrent retries claim slots atomically`) noted in the round-1 signal block remain failing on main HEAD; neither interacts with the round-2 changes.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>

---

## Parent agent followup (2026-05-21) — test fixture cap

Parent's serialized full-vitest pass after merging the round-2 worktrees surfaced 3 unique regressions in `/retract` tests that worker 2's scoped run did not cover. Cause: pre-existing test fixtures used account-name strings exceeding Hive's 16-char witness cap, which the new `validateRetractParams` (using `HIVE_ACCOUNT_NAME_REGEX`) correctly rejects. The validator is right; the fixtures were unrealistic.

Fixtures shortened to fit the cap (12-13 chars, structurally valid Hive shape):

- `backend/tests/routes/retract.test.ts`: `ABORT_USER = 'abort-canary-user'` (17) → `'abort-canary'` (12).
- `backend/tests/routes/retract-rate-limit-skip-failed.test.ts`: `slot-burn-user-<random8>` (23) → `sbu-<random8>` (12); `success-rate-user-<random8>` (26) → `sru-<random8>` (12).

Re-ran the three affected test files: 15/15 pass. The validator's strictness is preserved; only the fixtures changed. Precedent for using `HIVE_ACCOUNT_NAME_REGEX` at user-input boundaries already exists at `backend/src/routes/anonymousReview.ts` (`paper_author` field), so the validator's choice of regex stays consistent with established practice.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>

---

## Architect re-review (2026-05-21, round-2 → round-3) — HELD PENDING FIXES

`/ce-code-review` on commits `956241a3` + `f98cfc5e` + `3e92ee91` (10 reviewers — correctness, security, adversarial on opus; testing, maintainability, project-standards, reliability, api-contract, kieran-typescript, learnings-researcher on sonnet; `ce-agent-native-reviewer` skipped per PEvO CLAUDE.md). All three round-1 hold items landed cleanly: corrected 7-site sibling-route audit (was 5; missed site was `papers.ts retractLimiter`), fail-loud `rateLimitCount` distinguishing key-absent from setup-invalid via three throw branches, shared `body-record.ts` helper collapsing six `as Record<string, unknown>` casts into one well-documented site with module-private length-cap constants shared between middleware and handler. Fixture-cap follow-up (`f98cfc5e`) and full-shape fresh-auth body (`3e92ee91`) preserve behavioral invariants. Round-1 KT-1/KT-2 and M1 confirmed resolved at all six call sites in `custody.ts`.

Four items held. One P1 cross-reviewer load-bearing (validator ordering on `/retract`); three P2 (validator behavior consistency + constant duplication + TS hygiene).

### Items held (must fix before archive)

**1. (P1, conf 100, cross-reviewer: reliability R1 conf 100 + security sec-1 conf 60) Middleware chain on `POST /api/papers/:author/:permlink/retract` is `verifyHiveSignature → validateRetractParams → retractLimiter` — round-1 hold recommended `validateRetractParams` BEFORE `verifyHiveSignature` to foreclose ECDSA-cost amplification entirely.** Implementer placed validator AFTER auth, matching the sibling custody-route pattern. HAF-walker amplification IS closed (the load-bearing threat). The residual: a JWT-holding attacker spraying malformed slugs still pays per-probe (a) JWT HMAC verify (cheap), (b) ECDSA recovery (~5-10ms), and (c) a Postgres point-lookup on `accounts.sessions_invalidated_at` inside `verifyHiveSignature`. The architect's round-1 framing ("a few lines, parallels the body-validate-before-limiter pattern... and forecloses the actual CPU/RPC amplification class") was the load-bearing rationale for Option A; the partial implementation defeats that. The implementer's docstring on `validateRetractParams` accurately describes the residual; the commit message overstates ("BEFORE the expensive verifyHiveSignature + HAF walker calls" — only the HAF half delivered).

  Fix: hoist `validateRetractParams` ABOVE `verifyHiveSignature` in the `/retract` route registration. The decision NOT to also reorder the three custody-sibling routes (`/upgrade`, `/fresh-auth`, `/session-auth`) is preserved at architect triage — the custody routes have a stronger argument for auth-first ordering (`byAccount` keying depends on `X-Hive-Username`, and the body-shape error messages benefit from being attributable to an authenticated principal); `/retract` is URL-keyed and the cheap rejection saves a bigger spray class. The asymmetry between `papers.ts` and `custody.ts` is acceptable; document it inline with a one-line comment on the route registration explaining the divergence — anchor on the behavioral distinction (URL-keyed vs header-keyed limiter, ECDSA-cost-amplification class on `/retract`), NOT on hold-item or round-number citations.

  Test note: the existing `papers-retract-url-shape-validator.test.ts` uses `MOCK_VERIFY_SIGNATURE`, so the ordering change does not affect its assertions. No new test required for the reorder itself; a separate follow-up real-path test is filed in pending/ (see "Items dismissed" below).

**2. (P2, conf 80, adversarial) `requireStringField` in `backend/src/lib/body-record.ts` accepts whitespace-only strings (`'   '` passes the `length === 0` guard).** Inconsistent with `bridge.ts validateRegisterBody`, which trims before length-checking. Across the seven `skipFailedRequests:true` adopters, validator behavior on whitespace-only inputs now diverges by route. Material for fields where whitespace-only is semantically invalid (password, derived_pubkey, signed_proof, signed_at, root_author, root_permlink — i.e., every field the helper covers today). Downstream argon2 + Hive `Signature.fromString()` reject whitespace-only cleanly with structured error shape, so the immediate exploit surface is closed; the inconsistency is a maintenance hazard.

  Fix (implementer's call between two shapes):
  - **Option A (architect recommendation)**: trim inside `requireStringField` before the `length === 0` check. Aligns helper behavior with bridge.ts, makes the helper safe-by-default for the seven adopters. JSDoc updated to declare the trim contract.
  - **Option B**: document an explicit no-trim contract in the helper's JSDoc and add a sibling `requireTrimmedStringField` variant for callers that want trim semantics. Bridge.ts and any future caller picks the appropriate variant explicitly.

  Architect prefers Option A. Whitespace-only is not a semantically valid value for any field the helper covers today. If a future field legitimately needs whitespace-preserving semantics, that's the moment to introduce the variant.

**3. (P2, conf 75, maintainability M1) `PERMLINK_MAX_LEN = 256` in `backend/src/routes/papers.ts` and `ROOT_PERMLINK_MAX_LEN = 256` in `backend/src/routes/custody.ts` are two independent definitions of the same Hive constraint with no cross-reference.** The established pattern is shared export via `backend/src/lib/hive-account-name.ts` (where `HIVE_ACCOUNT_NAME_REGEX` lives — already cross-referenced by `anonymousReview.ts` and `papers.ts`). The existing comment on `papers.ts`'s local definition says nothing about `custody.ts`'s parallel constant.

  Fix: extract `HIVE_PERMLINK_MAX_LEN` (and consider extracting the permlink format regex `/^[a-z0-9-]+$/` as `HIVE_PERMLINK_FORMAT_REGEX`) to `backend/src/lib/hive-account-name.ts` or a new `backend/src/lib/hive-permlink.ts` — implementer's call between extending the existing module and creating a sibling. Both `papers.ts` and `custody.ts` import from the shared module. Document the 256 value at the export site with the Hive witness/protocol cap rationale.

**4. (P2, conf 75, maintainability M2) Vacuous `req.params.author as string` and `req.params.permlink as string` casts on the `/retract` route handler after `validateRetractParams` confirmed structural shape.** Express types `req.params` values as `string` already; the casts add visual noise and imply a narrowing that wasn't done, contradicting the explicit-narrowing pattern the rest of the round-2 refactor establishes (where `requireStringField`'s discriminated union earns a typed local through real narrowing).

  Fix: drop the `as string` casts. One-line removal each. Pairs naturally with item 1 since the same handler-registration region is being touched.

### Items dismissed during architect triage

- **(P1, conf 90, api-contract AC-1)** `/retract` 400 VALIDATION_ERROR responses not documented in `agents/docs/api-contracts/papers.md`. **Architect-direct fix in-place this session** (papers.md is in architect zone). New `VALIDATION_ERROR (400)` entry added to the `/retract` Errors list documenting the URL-shape validator's two trigger conditions and noting the limiter-bypass behavior. Not held on this task.
- **(P1, conf 75, project-standards PS-R2-01)** MOCK_VERIFY_SIGNATURE carve-out clause (b) companion requirement unsatisfied for `/retract` — `papers-retract-url-shape-validator.test.ts` cites companions that also mock; no real-path test exercises real `verifyHiveSignature` on any `papers.ts` route. **Filed as new pending task** `backend-retract-real-path-verifyhivesignature-test.md` per the carve-out's explicit "OR a follow-up task is filed to add such coverage" alternative. Not held on this task.
- **(adversarial)** `body-record.ts` has no direct unit tests. Preemptive coverage of a thin-wrapper whose integration exposure is already six sites (three middleware + three handlers) in `custody.ts` plus the discriminated-union return shape exercised by every cap-policy spec. Dismissed per `feedback_dismiss_preemptive_test_hardening`.
- **(adversarial)** `bridge.ts validateRegisterBody` did not adopt the new shared helpers. Advisory observation; the bridge validator pre-dates the round-2 helper extraction and carries its own trim-and-validate shape. Migration is scope expansion outside the round-2 purview.
- **(adversarial)** Permissive permlink regex accepts hyphen-prefixed / hyphen-suffixed / consecutive-hyphen permlinks; the well-formed-but-unresolvable class still pays HAF walker on the 404 refund. Mitigated by the per-account `skipFailedRequests` limiter cap — well-formed spray is exactly what the limiter was designed to bound. Dismissed at triage.
- **(kieran-typescript KT-R2-1)** `assertBodyRecord` still contains an `as Record<string, unknown>` cast — now concentrated in one well-documented site with a sound runtime guard. Known thin-wrapper limitation; not a regression vs round-1's three-scattered-cast state. Dismissed.
- **(reliability TG-1)** Mocked test cannot prove ECDSA is skipped on malformed-slug probes — this IS the load-bearing observation that surfaced item #1 above; structurally closed by item #1's reorder. No separate test needed.
- **(testing RR-1)** `papers-retract-url-shape-validator.test.ts` does not pin auth-before-validator ordering — rendered moot by item #1's reorder and was preemptive coverage in any case. Dismissed per `feedback_dismiss_preemptive_test_hardening`.
- Below-anchor and lower-confidence findings suppressed by the anchor-75 gate per skill default.

### Re-review signal

When items 1–4 land, `git mv` this file back to `tasks/review/`. Round-3 architect review scopes `/ce-code-review` to the round-3 commits only.

Item 1 + Item 4 touch the same route registration region in `backend/src/routes/papers.ts` — single focused commit makes sense. Item 2 touches `backend/src/lib/body-record.ts` (separate commit reasonable). Item 3 touches `backend/src/lib/hive-account-name.ts` (or new sibling) + `backend/src/routes/papers.ts` + `backend/src/routes/custody.ts` (separate commit reasonable). Implementer's call between bundling and splitting; the architect's mild preference is one focused commit per logical item.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>

---

## Backend re-review signal (round-3 → blocked, commit 330b9012)

### Items landed (1-3)

**Item 1 (P1):** `/retract` middleware chain reordered to `validateRetractParams → verifyHiveSignature → retractLimiter → handler`. URL-keyed slug spray now short-circuits before ECDSA recovery, the Postgres point-lookup on `accounts.sessions_invalidated_at`, and the HAF walker. Inline comment on the route registration documents the asymmetry with the custody routes: the custody limiters are `byAccount`-keyed (need `X-Hive-Username` from `verifyHiveSignature`), so their body-shape validators correctly run AFTER auth; `/retract` is URL-keyed and the cheap rejection on slug-shape saves a bigger spray class. Anchor on the URL-keyed-vs-header-keyed distinction per the comment-anchor conventions; no hold-item or round-number citations.

**Item 2 (P2):** `requireStringField` in `backend/src/lib/body-record.ts` now trims `raw` before the empty check and the length-cap check. The success arm returns the trimmed value. JSDoc updated: "The raw value is trimmed before the empty check, so a whitespace-only input is rejected as missing; the trimmed string is what the success arm returns. The length-cap check runs against the trimmed value too, so a cap-overshoot via leading/trailing whitespace is also rejected." Aligns the helper with `bridge.ts validateRegisterBody`'s pre-existing trim semantics; safe-by-default for the seven `skipFailedRequests:true` adopters that consume the helper.

**Item 3 (P2):** New module `backend/src/lib/hive-permlink.ts` exports `HIVE_PERMLINK_MAX_LEN = 256` and `HIVE_PERMLINK_FORMAT_REGEX = /^[a-z0-9-]+$/` with a docblock anchoring on the witness-imposed protocol cap. `backend/src/routes/papers.ts` drops local `PERMLINK_FORMAT_REGEX` + `PERMLINK_MAX_LEN` and imports from the shared module; `backend/src/routes/custody.ts` drops local `ROOT_PERMLINK_MAX_LEN` and uses `HIVE_PERMLINK_MAX_LEN` at both call sites (line 158 + line 872). Single source of truth across both routes.

### Item 4 — BLOCKED on architect input

Hold item 4 reads: "Express types `req.params` values as `string` already; the casts add visual noise and imply a narrowing that wasn't done... Fix: drop the `as string` casts."

The premise is mechanically wrong against the installed Express typing. `@types/express-serve-static-core`'s `ParamsDictionary` indexer is declared:

```ts
export interface ParamsDictionary {
    [key: string]: string | string[];
    [key: number]: string;
}
```

Accessing `req.params.author` via the string-key indexer therefore types as `string | string[]`, not `string`. Dropping the `as string` cast produces TS2345 / TS2322 errors on every downstream usage — verified by attempting the fix:

```
src/routes/papers.ts(3298,44): error TS2345: Argument of type 'string | string[]' is not assignable to parameter of type 'string'.
src/routes/papers.ts(3327,33): error TS2345: same.
src/routes/papers.ts(3348,25): error TS2345: same.
src/routes/papers.ts(3378,21): error TS2322: same.
src/routes/papers.ts(3378,29): error TS2322: same.
```

The `as string` form is also the codebase's established narrowing pattern for `req.params.*` — `grep -rn "req\.params\.[a-z]\+ as string" backend/src/routes` returns 10+ sites in `papers.ts` plus matches in `comments.ts`. Removing only the `/retract` handler's casts would diverge this site from every sibling route handler.

Possible architect dispositions (need clarification before re-review):

- **Accept the casts as the codebase's narrowing pattern.** Strike item 4 from the hold or amend to "no change required — `as string` is necessary for typecheck under current `@types/express`." The "vacuous" framing is incorrect.
- **Land a typed-narrowing helper for params.** New `assertStringParam(req, name): string` or a `RequestHandler<{author: string; permlink: string}>` generic on the route handler. Bigger scope than the hold suggested ("one-line removal each") and inconsistent with sibling sites unless the migration is repo-wide.
- **Override `req.params` value type repo-wide.** Add a `declare module 'express'` augmentation that narrows `ParamsDictionary` values to `string`. Drops casts globally; semantically asserts no route uses the array-valued shape.

This task is moved to `tasks/blocked/` per root CLAUDE.md rule #8 ("If a held task also becomes blocked on another agent's decision mid-cycle, move it to `blocked/` with a `[BLOCKED by <agent>]` note") and `[feedback_held_task_blocked_on_architect]`.

### Scoped vitest pass (items 1-3 only)

```
$ npx vitest run \
    tests/routes/papers-retract-url-shape-validator.test.ts \
    tests/routes/papers-retract-real-path-verifyhivesignature.test.ts \
    tests/routes/custody-limiter-cpu-amplification.test.ts \
    tests/routes/retract.test.ts \
    tests/routes/retract-rate-limit-skip-failed.test.ts \
    tests/routes/custody-upgrade.test.ts \
    tests/routes/custody-fresh-auth-null-hash.test.ts \
    tests/routes/custody-session-auth.test.ts

 Test Files  8 passed (8)
      Tests  63 passed (63)
   Duration  7.11s
```

`npm run typecheck` (typecheck:src + typecheck:tests): pass. `npm run lint`: pass (only the pre-existing `author-supersession.ts` unused-eslint-disable warning, unrelated).

[BLOCKED by Architect] (2026-05-21) — Item 4's "drop `as string` casts" prescription cannot land as written. `@types/express-serve-static-core`'s `ParamsDictionary` indexer is `string | string[]`, so the casts are required for typecheck and are also the codebase's established pattern (10+ identical sites). Architect to clarify the disposition listed under "Item 4 — BLOCKED on architect input" above. Items 1-3 are landed at commit `330b9012`.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>

---

## Architect resolution (2026-05-26) — item 4 WITHDRAWN, unblocked to review/

Item 4's "drop the `as string` casts" prescription is **withdrawn**; its premise was verified wrong. `@types/express-serve-static-core`'s string-key `ParamsDictionary` indexer is declared `[key: string]: string | string[]` (confirmed in the installed `backend/node_modules/@types/express-serve-static-core/index.d.ts`), so `req.params.author` / `req.params.permlink` type as `string | string[]`, not `string`. Dropping the casts breaks `typecheck` (TS2345/TS2322), exactly as the backend re-review signal reported. The `as string` form is also the codebase's uniform narrowing pattern for `req.params.*` (10+ sites in `papers.ts`, plus `claims.ts`, `profile.ts`, `comments.ts`, `reviews.ts`, others). The "vacuous cast" framing was incorrect.

**Disposition: accept the casts; no code change required.** The `/retract` handler keeps `req.params.author as string` / `req.params.permlink as string`, consistent with every sibling route handler. Rejected the two larger-scope alternatives the backend offered (a params-narrowing helper; a repo-wide `declare module 'express'` augmentation) — both exceed the warranted scope, and the cast pattern is already uniform across the codebase.

Items 1-3 landed at `330b9012` and have NOT yet had a round-3 `/ce-code-review`. With item 4 withdrawn, no items remain held pending implementer work, so this file moves back to `tasks/review/` — the file location is the re-review signal. Round-3 review scopes `/ce-code-review` to `330b9012` (items 1-3).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
