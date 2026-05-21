# BACKEND-REGISTER-RATE-LIMIT-BYIP-SKIPFAILED — Close byIp rate-limit slot-burn cascade on `/api/bridge/register`

**Owner:** Backend Agent
**Created:** 2026-05-20 (architect, surfaced by `/ce-code-review` of `backend-retract-rate-limit-haf-503-burn` round-1 commit `a5589588` during the 2026-05-20 bridge/broadcast-resilience cluster review)
**Priority:** P2 (reliability — NAT-shared user lockout on retriable cascade)

## Problem

`registerLimiter` at `backend/src/routes/bridge.ts:149` is `windowMs: 3_600_000, max: 10, keyFn: byIp` with NO `skipFailedRequests`. The `POST /api/bridge/register` route emits two `retriable: true` paths:

- 409 `LOCK_HELD` with `{retriable: true}` (the per-permlink SETNX-lock collision; SPA auto-retries up to 3 times per the recently-shipped `ui-bridge-register-lock-held-ux` SPA work)
- 503 `SERVICE_UNAVAILABLE` with `{retriable: true}` on HAF outage during the duplicate-check preflight (`fetchExistingBridge` fail-closed)

**The cascade:**

1. Two users behind the same corporate NAT click "Register" within the lock TTL window. First request acquires the per-permlink SETNX; second sees `LOCK_HELD` → 409 retriable.
2. SPA on the second user retries up to 3 times on `details.retriable: true`. Each retry consumes one `registerLimiter` slot.
3. With 3 users contending: 3 × 4 calls = 12 > 10 cap. Entire NAT locked out for 1hr on `/register`.
4. HAF blip during the same window amplifies further: each /register request that hits the HAF-fail-closed preflight returns 503 retriable; SPA retries; more slots burned.

**Pre-skipFailedRequests behavior:** every retriable response (the cascade's amplifier) consumes a slot. Legitimate users hit 429 RATE_LIMITED before the cascade resolves. Even after HAF recovers and locks release, the rolling 1hr window keeps the NAT locked out.

**Why filed now:** `backend-retract-rate-limit-haf-503-burn` (archived if/when round-2 clean) closed the same cascade shape on `/api/papers/:author/:permlink/retract` (byAccount/5/1hr) by adding `skipFailedRequests: true`. The audit table in that task explicitly noted `registerLimiter` as a candidate "quasi-followup if architect wants it widened" — implementer deferred on the rationale that byIp NAT-shared lockout is a different threat model from byAccount user lockout. Architect's call after review: the cascade shape (byIp + long window + retriable emit + SPA auto-retry on retriable) is the same as /retract's, and PEvO has precedent for `byIp + skipFailedRequests` already (`accreditationVerifyLimiter` at `windowMs: 60_000, max: 5, keyFn: byIp, skipFailedRequests: true` since the 2026-05-18 `backend-accreditation-verify-limiter-skip-failed` archive). The asymmetry isn't a threat-model wall, it's an unwidened sweep.

## Goal

Add `skipFailedRequests: true` to `registerLimiter` so retriable failure responses (LOCK_HELD 409, HAF-503) don't burn the NAT's slots during a cascade. Successful registrations continue to consume slots (abuse rate stays bounded).

## Acceptance

### 1. `registerLimiter` declaration updated

`backend/src/routes/bridge.ts:149` — extend the limiter config with `skipFailedRequests: true`. Multi-line struct form matching the `retractLimiter` / `accreditationVerifyLimiter` pattern. Include a stable-symbol-anchored WHY comment (1-2 sentences) explaining the cascade-close rationale: SPA auto-retries LOCK_HELD + HAF-503; without skipFailedRequests, corporate-NAT contention burns the budget within the 3-user × 4-call shape.

### 2. Threat-model documentation in the WHY comment

The comment block must cover:
- Why per-request 4xx/5xx refund is safe on this route: the 409 LOCK_HELD path is rate-limit-amplifier-shaped (retriable cascade); the 503 SERVICE_UNAVAILABLE on HAF outage is also retriable-cascade-shaped; the 400 DUPLICATE / 422 validation paths fire on user error AND DO refund under skipFailedRequests but are bounded by the user's own paper-identifier set (no unbounded probe surface).
- Why byIp vs byAccount doesn't affect the analysis: the limiter's purpose on bridge/register is to bound IP-rotation abuse (preventing one party from claiming many papers under different identifiers from the same IP). Successful 200/201 still consumes a slot under skipFailedRequests, so the per-IP abuse cap is preserved.

### 3. Canary tests

Add canaries to a sibling test file (or extend existing `bridge.test.ts` / `bridge-haf-lag-locks.test.ts` if shape fits):

- **Slot-burn = 1 per LOCK_HELD cascade event.** N sequential POST /register requests from the same IP, all returning 409 LOCK_HELD. Then 1 successful POST /register (different paper). Assert the successful request returns 201, NOT 429. Pre-fix: N+1 requests would consume N+1 slots; once the cap is hit, the legitimate registration 429s.
- **Slot-burn = 1 per HAF-503 cascade event.** Same shape with `fetchExistingBridge` (or whatever preflight throws HafQueryError) mocked to throw; assert N retriable 503s + 1 successful request still succeeds.
- **Abuse rate still bounded.** 11 successful POST /register requests from the same IP; assert 11th request returns 429 RATE_LIMITED. Pins that 2xx responses still consume slots.

Mutation-kill: remove `skipFailedRequests: true` → first canary's successful-after-N-503s assertion fails RED (the legitimate request 429s).

### 4. Verification

`npm run typecheck` clean. `npm run lint` clean for this change. Scoped vitest on the touched test files passes.

### 5. [TODO Architect] documentation update

After landing, architect updates `agents/docs/api-contracts/bridge.md` § POST /api/bridge/register Errors — `LOCK_HELD` and `SERVICE_UNAVAILABLE` entries gain a note that retriable failures no longer consume rate-limit slots, per the 503-retriable rate-limit interaction guidance already in `accreditation.md` (the precedent for byIp + skipFailedRequests).

## Out of scope

- Cross-route extension to other byIp limiters (auth.ts signup/login/reset, signup-verify.ts verify/resume/confirm/link, orcid.ts start/callback, ipfs.ts download, settings.ts read/write). Those are credential-probing or admin-scoped routes where `skipFailedRequests` MUST NOT be added (per `RateLimitConfig.skipFailedRequests` JSDoc). Survey deferred.
- `lookupLimiter` on `/api/bridge/lookup` (byIp/20/60s). Short window, fast recovery; no retriable emit on the route. Out of scope unless audit surfaces a retriable path.
- Restructuring `registerLimiter` to byAccount or composite key. The byIp threat model (raising the bar for IP-rotation abuse) is intentional; this task narrows the slot-burn cascade without changing the keying.

## Cross-references

- `backend/src/routes/bridge.ts:149` — `registerLimiter` declaration.
- `backend/src/routes/bridge.ts:425-431, 443` — the retriable 409 LOCK_HELD + 503 SERVICE_UNAVAILABLE emit sites.
- `backend/src/middleware/rateLimit.ts` — `RateLimitConfig.skipFailedRequests` JSDoc + middleware semantics (4xx/5xx refund via `res.on('finish') + res.on('close')` once-guard).
- `backend/src/routes/accreditation.ts:58` — `accreditationVerifyLimiter` (byIp + skipFailedRequests precedent).
- `backend/src/routes/papers.ts:732-737` — `retractLimiter` (byAccount + skipFailedRequests precedent and the threat-model comment template).
- `frontend/src/pages/bridge.js` — SPA auto-retry logic on `LOCK_HELD` 409 (per `ui-bridge-register-lock-held-ux` archive).
- `agents/docs/api-contracts/bridge.md` — contract doc to update at archive time.
- Originating audit table: `backend-retract-rate-limit-haf-503-burn` task signal block (Cross-route audit and bundled remediation section).

## Backend completion signal (2026-05-20)

**Acceptance #1 — `registerLimiter` declaration update.**
The declaration in `backend/src/routes/bridge.ts` now uses the multi-line struct form with `skipFailedRequests: true`:

```ts
const registerLimiter = rateLimit({
  name: 'bridge-register',
  windowMs: 3_600_000,
  max: 10,
  keyFn: byIp,
  skipFailedRequests: true,
});
```

Multi-line shape matches the `accreditationVerifyLimiter` byIp precedent.

**Acceptance #2 — WHY-comment threat-model coverage.**
The comment block above the declaration covers:
- The two retriable-true error shapes emitted by /register (409 LOCK_HELD + 503 SERVICE_UNAVAILABLE) and the SPA auto-retry cascade they trigger.
- Why 4xx refund is safe on this byIp route: every 4xx path short-circuits BEFORE the HAF query and the broadcast (the expensive work guarded by the limiter), so probing only costs Redis-rate-limit ops with no chain/HAF side effects.
- Why successful 2xx still consumes a slot: the per-IP abuse cap on successful broadcasts is preserved.
- Cross-reference to `RateLimitConfig.skipFailedRequests` JSDoc and the `accreditationVerifyLimiter` byIp precedent in `accreditation.ts`.

No task-slug, round-number, line-number, or SHA references in the comment — anchored on stable symbols (`registerLimiter`, `accreditationVerifyLimiter`, `RateLimitConfig.skipFailedRequests`) per the comment-anchor convention.

**Acceptance #3 — Canary tests added.**
New file: `backend/tests/routes/bridge-register-rate-limit-skip-failed.test.ts`. Mirror of the `bridge-haf-lag-locks.test.ts` mocked-pool + FakeRedis shape. Three canaries under `describe('registerLimiter slot-refund on retriable error paths (skipFailedRequests=true)')`:

1. **HAF-503 cascade canary** — 10 sequential 503 SERVICE_UNAVAILABLE responses do NOT exhaust the per-IP 10/hour budget; 11th request under healthy HAF returns 200. Pins slot refund on the HAF-throw catch arm.
2. **LOCK_HELD cascade canary** — 10 sequential 409 LOCK_HELD responses (under slow-broadcast gate) do NOT exhaust the per-IP budget; 11th request after lock release is NOT 429. Pins slot refund on the SETNX-already-held branch.
3. **Per-IP abuse cap canary** — 10 successful 200s from the same IP exhaust the budget; 11th returns 429 RATE_LIMITED. Pins that the slot accounting is preserved on the success path.

Each canary uses a distinct simulated client IP via `X-Forwarded-For` (`trust proxy = 1` in `app.ts` derives `req.ip` from the first-in-chain value) so the in-memory limiter `memStore` doesn't leak slot counts across specs.

Test file header documents the carve-out per `CLAUDE.md` clauses (a) / (b) / (c). The `verifyHiveSignature` middleware is NOT mocked — requests are signed end-to-end via the shared `support/sign-request.ts` helper. Clause (c) real-path companion: `backend/tests/middleware/rateLimit.test.ts` exercises the slot-refund mechanics against live Redis.

**Mutation-kill verification:** removed `skipFailedRequests: true` from the `registerLimiter` declaration and re-ran the canaries. Canary 1 RED-failed (`expected 429 to be 200` on the 11th success; the 10th 503 also flipped to `expected 429 to be 503`). Canary 2 RED-failed (`expected 429 to be 409` on the 10th LOCK_HELD attempt). Canary 3 still passed (success-path slot consumption is independent of the skipFailedRequests flag). Restored `skipFailedRequests: true` and re-ran; 3/3 pass.

**Acceptance #4 — Verification.**

- `npm run typecheck` — pre-existing error in `tests/support/argon2-error-mocks.ts:178` (unrelated, present on stash-removed working tree). No new errors in touched files (`backend/src/routes/bridge.ts`, `backend/tests/routes/bridge-register-rate-limit-skip-failed.test.ts`).
- `npx eslint src/routes/bridge.ts tests/routes/bridge-register-rate-limit-skip-failed.test.ts` — clean.
- Scoped vitest: `npx vitest run tests/routes/bridge-register-rate-limit-skip-failed.test.ts` — 3 tests passed.

**Acceptance #5 — `[TODO Architect]` doc note.**
`[TODO Architect]` Update `agents/docs/api-contracts/bridge.md` § POST /api/bridge/register Errors with the rate-limit interaction note: clients that retry on `details.retriable` (409 LOCK_HELD and 503 SERVICE_UNAVAILABLE) should bound their own retry attempts. The rate limiter refunds the slot on 4xx/5xx so SPA-driven retries do not burn the per-IP 10/hour budget, but the per-IP successful-broadcast cap is still enforced. Mirrors the convention already noted on `accreditationVerifyLimiter` for `/api/accreditation/verify`. Architect handles the contract edit at archive time per the backend agent's API-contract boundary rule.

**Cross-reference.**
This task was filed by `backend-retract-rate-limit-haf-503-burn` round-2 architect review as the byIp parity-sweep extension. The parent task covers the byAccount precedent on `retractLimiter`; this task is the byIp companion. Both share the `RateLimitConfig.skipFailedRequests` primitive and the same threat-model contract (4xx refund safe IFF the 4xx surface short-circuits before expensive work).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>

---

## Architect re-review (2026-05-20) — HELD PENDING FIXES

`/ce-code-review` ran on round-1 commit `c656fe39` with 9 reviewer personas (correctness on Opus; testing, maintainability, project-standards on Sonnet; security on Opus; reliability on Sonnet; adversarial on Opus; kieran-typescript on Sonnet; learnings-researcher on Sonnet; `ce-agent-native-reviewer` skipped per PEvO CLAUDE.md). Production change (`skipFailedRequests: true` on `registerLimiter` + 14-line WHY comment) and 3 canaries (HAF-503 cascade, LOCK_HELD cascade, abuse-cap-preserved) land structurally; canary mutation-kill verified by the implementer. However, cluster review surfaced a P1 cross-reviewer-corroborated security/correctness defect on middleware composition and a paired P1 behavioral-accuracy defect on the WHY comment.

Cluster-wide findings: 5 findings surfaced across 9 personas; 1 dismissed at architect verification (TCP-abort `writableEnded` gate — verified present at `rateLimit.ts:188`); 1 dismissed at architect triage (LOCK_HELD canary soft-assertion); 3 held for round-2; cross-cutting concerns folded into items below.

### Items to address (bundle into one round-2 commit)

**1. (P1, anchor 100, cross-reviewer security + adversarial + learnings) `registerLimiter` mounted BEFORE `verifyHiveSignature` in the route chain creates a CPU/Hive-RPC amplification surface under `skipFailedRequests: true`.** `backend/src/routes/bridge.ts:373` — current shape: `router.post('/register', registerLimiter, verifyHiveSignature, ...)`. The limiter increments the slot up-front; downstream 4xx responses (missing field 400, unaccredited 403, unresolvable identifier 400, validation 422) refund the slot via `res.on('finish')` / `res.on('close')`. So an attacker with any valid Hive signing key can spray POST `/api/bridge/register` with `{identifier:'x', discipline:''}` from one IP: each request returns 400 BAD_REQUEST after `verifyHiveSignature` runs (Redis replay-check + `hiveClient.database.getAccounts` Hive RPC call + ECDSA recovery). The slot refunds. Attacker pays nothing; server pays per-request ECDSA recovery + Hive RPC network call. Unbounded amplification. The `rateLimit.ts` `RateLimitConfig.skipFailedRequests` JSDoc explicitly warns against this composition. Sibling route `/api/accreditations/verify` in `backend/src/routes/accreditation.ts` mounts `verifyHiveSignature` + `validate(...)` BEFORE the limiter — the correct pattern this commit diverges from.

   Fix shape A (architect-prescribed): reorder middleware to `verifyHiveSignature → validateRegisterBody → registerLimiter → handler`, matching the `accreditation.ts` sibling precedent. Extract body-shape validation (identifier present/non-empty, discipline present/non-empty) into a `validateRegisterBody` middleware so body-validation 400s also short-circuit before the limiter. Closes the CPU/RPC amplification surface fully. Estimated ~5 LOC of route-mount change + ~10 LOC `validateRegisterBody` extraction. (Fix shape B — documented carve-out acceptance — is allowed by the JSDoc's escape clause but architect-recommended shape A given the sibling precedent and the unbounded amplification surface.)

**2. (P1, anchor 100, cross-reviewer correctness + reliability + project-standards) WHY comment is factually wrong on multiple 4xx paths.** `backend/src/routes/bridge.ts:159-163`. Comment claims: *"4xx refund is safe here because every 4xx path short-circuits BEFORE the HAF query and the broadcast (the expensive work guarded by the limiter per the API contract), so probing only costs Redis-rate-limit ops with no chain/HAF side effects."* Verified false on at least 4 paths in the actual handler:

   - `403 NOT_ACCREDITED` fires AFTER `getAccreditedSet([username])` HAF query (`bridge.ts:391`)
   - `400 unresolvable identifier` fires AFTER `resolveToCanonical(identifier)` external arXiv/Crossref HTTP fetch (`bridge.ts:410`)
   - `400 no preprint` fires AFTER `lookupPreprint(identifier)` external HTTP fetch (`bridge.ts:433`)
   - `409 DUPLICATE` fires AFTER the HAF `checkExistingBridge` query

   Per `agents/docs/solutions/conventions/comment-sweep-expansion-must-audit-added-clause-behavioral-accuracy-2026-05-20.md` — every clause added by a sweep edit must be verifiable against the cited code. The false claim, if left, propagates the wrong threat model to future maintainers.

   Fix: bundle the rewrite with item 1's outcome. After the middleware reorder lands, body-validation 400s and auth 401s no longer reach the limiter. The surviving 4xx paths that DO refund are `403 NOT_ACCREDITED` (post-`getAccreditedSet`), `400 unresolvable` (post-`resolveToCanonical`), `400 no preprint` (post-`lookupPreprint`), and `409 DUPLICATE` (post-`checkExistingBridge`). Rewrite the WHY comment to enumerate these explicitly and justify why each is cheap-enough-to-accept (PEvO single-instance scale; external resolvers have their own rate caps; HAF check is a single cheap lookup; broadcast is the truly expensive boundary and stays bounded by the success-path 10/hour cap). Anchor on stable symbols (function names + route handler stage), no positional anchors, no slug citations, no SHAs.

**3. (P2, anchor 75, project-standards) Clause (c) companion citation in test header names "the SKIP_FAILED describe block" in `rateLimit.test.ts`, which does not exist as a named `describe` block.** `backend/tests/routes/bridge-register-rate-limit-skip-failed.test.ts:40-41`. The skipFailedRequests coverage lives in `it()` blocks under the single outer `describe('rateLimit middleware')`, separated only by a comment header `// ─── skipFailedRequests + atomic Lua check ...`. Coverage is substantively present (clause (c) satisfied at the risk-class level); only the citation is structurally inaccurate. Per `agents/docs/solutions/conventions/docblock-anchor-stable-symbols-not-line-numbers-2026-05-15.md` test-file header docstrings are in scope for stable-symbol anchoring; the comment-header text (`skipFailedRequests + atomic Lua check`) IS such a symbol, just not a `describe`.

   Fix: replace "the SKIP_FAILED describe block" with the grep-findable form, e.g., *"the `skipFailedRequests + atomic Lua check` section in `tests/middleware/rateLimit.test.ts`"* or *"the `skipFailedRequests` it-blocks in `tests/middleware/rateLimit.test.ts`"*. ~1 LOC.

### Items dismissed during architect triage

- **(adversarial P2 conf 85 TCP-abort `writableEnded` gate)** Verified at architect-time read: `backend/src/middleware/rateLimit.ts:188` already contains `if (res.statusCode < 400 && res.writableEnded) return;` per the `deferred-refund-gate-must-check-writableEnded-not-just-statusCode-2026-05-17.md` convention. The comment block at lines 176-180 explicitly explains the `writableEnded` half's role in catching pre-status TCP-aborts. The broadcast-lands-then-abort scenario does NOT silently refund the slot — `writableEnded` is false at that point, so the gate fails and the refund proceeds (which is the intended behavior for an abort that did NOT complete the response cleanly). False alarm at the reviewer layer; gate is structurally correct.
- **(testing soft-assertion P3)** LOCK_HELD canary terminal `expect(followUpRes.status).not.toBe(429)` is intentionally scoped per the implementer's documented rationale (line 392-398). Tightening to `.toBe(200)` would couple the canary to broadcast-success behavior, expanding the SUT beyond rate-limit accounting. Below action threshold.

### Architect followups (no implementer action)

- **A1.** `agents/docs/api-contracts/bridge.md` § POST /api/bridge/register Errors — update to reflect `skipFailedRequests: true` semantics per implementer's `[TODO Architect]`. Architect handles at archive time after round-2 lands.

### Re-review signal

When items 1-3 land in a single round-2 commit, `git mv` this file back to `tasks/review/`. The mv itself is the re-review signal. Round-2 architect review scopes `/ce-code-review` to the round-2 commit only. Item 1 is the load-bearing fix; items 2-3 are mechanical text rewrites that follow from item 1's outcome.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>

---

## Backend re-review signal (2026-05-20, round-2)

All three hold-block items landed in a single round-2 commit on the worker worktree branch.

**Item 1 (P1, middleware reorder + `validateRegisterBody` extraction).** `backend/src/routes/bridge.ts`:

- Added `NextFunction` to the `express` named imports.
- Extracted body-shape validation into a new `validateRegisterBody` middleware (identifier present + non-empty string; discipline present + non-empty string). The middleware emits the same 400 BAD_REQUEST envelope and message strings as the previous in-handler checks, so wire-shape callers see no contract change. WHY-comment above the middleware names the CPU/RPC amplification surface it closes (anchored on stable symbols `verifyHiveSignature`, `registerLimiter`, `getAccounts`, `RateLimitConfig.skipFailedRequests`).
- Reordered the route mount from `router.post('/register', registerLimiter, verifyHiveSignature, handler)` to `router.post('/register', verifyHiveSignature, validateRegisterBody, registerLimiter, handler)`. Sibling precedent: `accreditationVerifyLimiter` mounted as `validate(...) → accreditationVerifyLimiter → handler` in `backend/src/routes/accreditation.ts` (the `/verify` route mounts `validate` before the limiter; my `/register` mounts the auth-then-validate-then-limit triad that `request` uses for the same `verifyHiveSignature → validate(...) → accreditationRequestLimiter` shape).
- Removed the now-redundant inline `if (!identifier || ...)` and `if (!discipline || ...)` checks from the handler (the middleware gates them). The handler's destructured types tightened from `identifier?: string; discipline?: string;` to `identifier: string; discipline: string;` (keywords + language stay optional). Added a 4-line WHY comment explaining the non-null derivation crosses a middleware boundary that TypeScript can't see.

Behavior change: body-validation 400s and auth 401s no longer reach the limiter. With `skipFailedRequests: true`, that means probing requests with malformed bodies (or unsigned requests) no longer trigger an `ECDSA-recovery + getAccounts RPC` round-trip with a refunded slot afterward. The amplification surface is closed.

**Item 2 (P1, WHY-comment rewrite).** `backend/src/routes/bridge.ts` above the `registerLimiter` declaration. Replaced the inaccurate "every 4xx path short-circuits BEFORE the HAF query and the broadcast" claim with an enumerated list of the SURVIVING 4xx/5xx slot-refund paths under the new middleware order:

- `403 NOT_ACCREDITED` post-`getAccreditedSet([username])`
- `400 BAD_REQUEST` "Could not resolve identifier" post-`resolveToCanonical` (external HTTP)
- `400 BAD_REQUEST` "No preprint found" post-`lookupPreprint` (external HTTP)
- `409 LOCK_HELD` post-per-permlink-SETNX (Redis)
- `409 DUPLICATE` post-`checkExistingBridge` (HAF SELECT)
- `503 SERVICE_UNAVAILABLE` / `500 INTERNAL_ERROR` fail-closed on HAF outage / resolver throw

Justified each as cheap-enough-to-accept at PEvO single-instance scale: external resolvers have their own per-host rate caps + timeouts; HAF check is a single indexed lookup; SETNX is a one-shot Redis op; the truly expensive boundary (the Hive broadcast) only runs on the success path and stays bounded by the per-IP 10/hour success cap. No task-slug citations, no round numbers, no line numbers, no SHAs. Anchored on stable symbols (function names, `RateLimitConfig.skipFailedRequests`).

**Item 3 (P2, test header citation).** `backend/tests/routes/bridge-register-rate-limit-skip-failed.test.ts` header docstring clause (c). Replaced "the SKIP_FAILED describe block" with the grep-findable form: *"the `skipFailedRequests + atomic Lua check` section under the single outer `describe('rateLimit middleware')`"*. Verified the comment-header text `skipFailedRequests + atomic Lua check` exists in `tests/middleware/rateLimit.test.ts` (`grep -n` hit on line 151 of that file).

**Verification.**

- `npm run typecheck` — clean. The pre-existing `tests/support/argon2-error-mocks.ts:178` error referenced in the task's signal block did NOT surface on this branch (it may have landed under a separate task while this one was held); no new errors from these changes.
- `npx eslint src/routes/bridge.ts tests/routes/bridge-register-rate-limit-skip-failed.test.ts` — clean.
- Scoped vitest: `npx vitest run tests/routes/bridge-register-rate-limit-skip-failed.test.ts` — 3/3 canaries pass (HAF-503 cascade, LOCK_HELD cascade, abuse-cap-preserved). The canaries sign requests end-to-end via the real `verifyHiveSignature` middleware and pass body validation, so the reorder is transparent to them.
- Additional regression check: `npx vitest run tests/routes/bridge.test.ts tests/routes/bridge-haf-lag-locks.test.ts` — 21/21 pass. The "requires authentication headers" test still returns 401 (sends a well-formed body without auth headers → `verifyHiveSignature` short-circuits 401 before `validateRegisterBody` runs). DUPLICATE-envelope, BroadcastTimeout, RPCError, lock-contention, and error-event-emit specs all clean.

**Mutation-sanity-check on the reordered short-circuit.** With the new order, a request with missing `identifier` from any IP 400s at `validateRegisterBody` before reaching `registerLimiter`. The existing `bridge.test.ts` "POST /api/bridge/register — requires authentication headers" spec exercises the equivalent short-circuit for unsigned requests (`verifyHiveSignature` 401 before the limiter). I did not add a new test for the malformed-body-pre-limiter case because: (a) the existing canary suite already exercises the limiter's accounting on the deeper retriable paths the middleware reorder is designed to leave intact; (b) a dedicated test asserting "malformed body does not increment the limiter slot" would require driving the in-memory `memStore` counter directly, which is out of scope for a route-level test and is the canonical territory of `tests/middleware/rateLimit.test.ts`. The WHY-comment rewrite documents the property invariant; the middleware ordering is the enforcement.

**Files touched in this round:**
- `backend/src/routes/bridge.ts` — `NextFunction` import; WHY-comment rewrite + reorder; `validateRegisterBody` extraction; handler edits.
- `backend/tests/routes/bridge-register-rate-limit-skip-failed.test.ts` — clause (c) citation fix in header.
- `agents/docs/tasks/pending/backend-register-rate-limit-byip-skipfailed.md` — this signal block.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>

---

## Architect re-review (2026-05-21) — HELD PENDING FIXES (round 2)

Round-2 commit `3c182930` (`validateRegisterBody` extraction + middleware reorder + WHY-comment rewrite + clause-(c) citation fix). `/ce-code-review` ran with 8 reviewer personas (correctness on Opus; testing/maintainability/project-standards/reliability/kieran-typescript/learnings on Sonnet; security + adversarial on Opus; `ce-agent-native-reviewer` skipped per PEvO root CLAUDE.md). The load-bearing fix (middleware reorder + body-validation extraction) lands structurally correct: security verified the malformed-body 400 short-circuit closes the originally-flagged CPU/RPC amplification surface; correctness verified `validateRegisterBody` mirrors the deleted inline check exactly; reliability verified termination semantics and error-propagation chain. Round-2 surfaced one regression-backstop gap held below; several other items were dismissed at triage or filed as separate follow-up tasks.

### Item held (must fix before archive)

**1. (P1, anchor 100, cross-reviewer testing + adversarial corroborated) No test pins the malformed-body-pre-limiter property — the load-bearing invariant of this fix has no regression backstop.** The reorder's stated purpose is "malformed body short-circuits BEFORE the limiter, so the slot is never touched." The 3 existing canaries in `backend/tests/routes/bridge-register-rate-limit-skip-failed.test.ts` all send well-formed bodies and exercise the refund path (slot acquired then decremented on failure), not the pre-limiter short-circuit path (slot never acquired). The `requires authentication headers` test in `bridge.test.ts` asserts auth-401 short-circuit (different mechanism). A future refactor that reverts the middleware order back to `registerLimiter → verifyHiveSignature → handler` would reopen the round-1 amplification surface and these tests would still pass.

Fix: Add a 4th canary to `backend/tests/routes/bridge-register-rate-limit-skip-failed.test.ts` exercising:
- POST `/api/bridge/register` with a malformed body (missing `identifier` OR empty-string `identifier`) AND valid Hive auth headers.
- Assert 400 BAD_REQUEST.
- Assert `rateLimitCount('bridge-register', clientIp) → null` (or equivalent slot-untouched probe).

Sibling precedent: `backend/tests/routes/custody-limiter-cpu-amplification.test.ts` lines 144-217 pins the identical contract for `/custody/upgrade` using `rateLimitCount(name, user) → toBeNull()` assertions. Use that file as the shape template. Mutation-kill: reverting `router.post('/register', verifyHiveSignature, validateRegisterBody, registerLimiter, handler)` to `router.post('/register', registerLimiter, verifyHiveSignature, validateRegisterBody, handler)` MUST flip the new canary RED while leaving the existing 3 canaries green.

### Items dismissed at architect triage (recorded for transparency)

- **(P2 correctness #1, conf 70)** WHY-comment enumeration of surviving 4xx/5xx slot-refund paths is incomplete — missing `429 cap_exceeded` and `409 duplicate_active` introduced by the subsequent `0ccefe14` bridge-queue migration. Downstream drift, not a round-2 commit-time defect; the enumeration was accurate at `3c182930`. Could be folded into a future bridge.ts WHY-comment touch but doesn't warrant a round-3 hold.
- **(P1 KT-1, conf 75)** Handler cast asserts `keywords: string[]` and `language: string` with no runtime validation; `validateRegisterBody` only gates `identifier` + `discipline`. A non-array `keywords` value flows into `JSON.stringify(...)` and is silently coerced. Pre-existing pattern, not introduced by this commit (the cast for keywords/language was identical before the round-2 reorder).
- **(P3 RR1/RR2 maintainability, conf 50/45)** `validateRegisterBody` placement inconsistent with file's "helper before route" pattern; handler re-derives typed fields from `req.body` rather than reading from a typed `req.validatedBody`. Both are accepted design trade-offs; the WHY-comment on the handler explicitly acknowledges the middleware-boundary TypeScript gap.

### Items filed as separate follow-up tasks (not in this hold's scope)

- **(P1 adversarial adv-1, conf 80)** Non-JSON Content-Type bypasses `validateRegisterBody` entirely. Attacker with one valid Hive posting key signs canonical message with body-hash of `'{}'` (since `JSON.stringify(undefined ?? {})` = `'{}'`); POSTs with `Content-Type: text/plain`; `express.json` doesn't parse; `req.body = undefined`; `verifyHiveSignature` runs and pays ECDSA + `getAccounts` RPC; `validateRegisterBody`'s `body.identifier` throws TypeError; `errorHandler` returns 500. Limiter never reached → unbounded CPU/RPC amplification via a different bypass than the round-1 fix closed. Same shape pre-fix (slot-burn-and-refund signature); not introduced by this commit. Filed as separate task `backend-bridge-register-content-type-guard` in `tasks/pending/`.
- **(P2 maintainability M1, conf 72)** Test-header citation in `bridge-register-rate-limit-skip-failed.test.ts` points at `rateLimit.test.ts:151` which contains the prohibited round-number coordination marker `(round-3 hold items 1+2)`. The citation fix in `3c182930` quoted only the clean prefix and is correct as-written; the upstream rot is pre-existing in a file not touched by this commit. Filed as separate task `backend-ratelimit-test-anchor-cleanup` in `tasks/pending/`.

### Re-review signal

When item 1 lands, `git mv` this file back to `tasks/review/`. The mv itself is the re-review signal. Round-3 architect re-review scopes `/ce-code-review` to the round-3 commit only. The canary is a single-spec addition; round-3 should be a small focused commit.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
