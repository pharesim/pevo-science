# BACKEND-RETRACT-RATE-LIMIT-HAF-503-BURN — Rate-limiter slot burn cascade on retriable 503 paths

**Owner:** Backend Agent
**Created:** 2026-05-20 (architect, surfaced by `/ce-code-review` of `backend-fetch-paper-detail-haf-error-vs-not-found` round-1 commit `b427a70` during the 2026-05-20 HAF-cluster review)
**Priority:** P2 (reliability)

## Problem

When a HAF transient outage triggers the new retriable-503 envelope on a rate-limited write path, the SPA retries on `details.retriable: true`. Each retry consumes another rate-limiter slot. The cascade burns the full per-window slot budget during a single outage event — and when HAF recovers, the legitimate user is locked out for the remainder of the rolling window.

**Canonical exemplar — `/api/papers/:author/:permlink/retract`:** `retractLimiter` is `max: 5/hour/account` (`papers.ts:720`, `keyFn: byAccount`) with NO `skipFailed: true`. Step-by-step:

1. User clicks Retract. `verifyHiveSignature` passes. `retractLimiter` consumes slot 1.
2. `fetchPaperDetailFromHaf` throws `HafQueryError` under HAF transient outage. New round-2 (per `backend-fetch-paper-detail-haf-error-vs-not-found` hold) emits `503 + details.retriable: true`.
3. SPA reads `details.retriable: true` and retries. Slot 2 consumed.
4. Outage persists 30+ seconds. SPA retries 3 more times. Slots 3-5 consumed.
5. 6th attempt: `retractLimiter` returns 429.
6. HAF recovers minutes later. User clicks Retract. `retractLimiter` sees 5/5. Returns 429. User locked out until oldest slot ages out (up to 1 hour).

**Pre-b427a70 behavior:** HAF outage returned `200 with cached null → 404`. SPA showed "Paper not found" → user stopped. Zero retries. Slot burn = 1.

**Post-b427a70 behavior:** Slot burn = 5 per outage event, on a 5/hour limiter. Legitimate users hit a self-inflicted 1-hour cooldown.

## Goal

Close the slot-burn cascade on `/retract` and audit other rate-limited write paths for the same shape. The rate limiter exists to bound abuse rate, not to penalize legitimate users for backend-side outages.

## Suggested approach (implementer to confirm during design pass)

Three fix shapes are defensible; the threat-model implications differ.

### Option A: `skipFailed: true` on `retractLimiter`

Only count successful requests against the limit. A `retractLimiter` 5xx response doesn't consume a slot.

- **Pro:** clean one-line fix at `papers.ts:720`. The middleware (`backend/src/middleware/rateLimit.ts`) likely already supports `skipFailed` (or `skipFailedRequests`) via express-rate-limit; verify.
- **Threat-model implication:** the limiter no longer bounds attempted-write rate, only completed-write rate. An attacker who can force the route to 5xx (e.g., by crafting requests that trip a 422 VALIDATION_ERROR or a 504 BROADCAST_TIMEOUT) can issue unlimited attempts. Today's `papers.ts:retract` 5xx surface includes: 404 (paper not found), 422 (already retracted), 502 (BROADCAST_FAILED), 504 (BROADCAST_TIMEOUT), 503 (new HafQueryError), 500 (unhandled). Most are deterministic-from-state, not abuse-driveable. **Question:** does `skipFailed` also skip 4xx, or only 5xx? If both, the 422-already-retracted path becomes an unbounded retry surface. Verify the middleware semantics.

### Option B: Explicit slot refund in the 503 catch arm

In the new `HafQueryError` catch, call into the rate-limiter middleware to refund the slot consumed earlier in the same request.

- **Pro:** surgical; only the retriable-503 path is exempted from slot consumption. 422 / 502 / 504 / 500 still consume slots.
- **Con:** PEvO's rate-limit middleware probably does NOT expose a refund API today. Verify; if not, this would require middleware surgery to expose `req.rateLimit.refund()` or similar.

### Option C: Per-route `Retry-After` header on the new 503

Add `Retry-After: <seconds>` to the new 503 response, tuned so SPA backoff doesn't chain-burn within the hour. Common convention is 30s (matches the argon2 / accreditation 503 paths).

- **Pro:** doesn't touch the limiter; honors `common.md`'s existing convention for retriable 503s with `Retry-After`.
- **Con:** the SPA respects `Retry-After`, but the user can still click Retract manually 5 times within the hour and burn the slots. Doesn't solve user-driven amplification — only client-loop amplification.

**Likely best path:** Option A IF the middleware's `skipFailed` semantics correctly distinguish 5xx-server-error from 4xx-client-error. Backed up by Option C for SPA self-rate-limiting on the retry loop.

## Acceptance

### 1. `/retract` slot burn under HAF transient outage = 1 per outage event

Mocked canary: install a HAF responder that throws `HafQueryError`. Issue 6 sequential POST `/retract` requests from the same account. Assert exactly 1 slot consumed (not 5 or 6). After the canary, issue a successful POST `/retract` (mocked HAF responder returns the paper); assert slot 2 consumed and 200 OK returned. Mutation-kill: remove the slot-refund / skipFailed mechanism → canary fails red (6th request returns 429 or similar).

### 2. `/retract` retains rate-limit guarantee against actual abuse

Issue 6 sequential POST `/retract` requests under healthy HAF (mocked successful broadcast). Assert 6th request returns 429 with `RATE_LIMITED` envelope. Pins that the slot accounting is preserved on the success path.

### 3. Cross-route audit and bundled remediation

Enumerate all PEvO HTTP routes with both (a) a rate limiter that consumes slots synchronously, AND (b) a code path that emits `details.retriable: true` on transient backend failure. Likely candidates to inspect:

- `POST /api/papers` (publish) — has `publishLimiter`? If yes, does it emit retriable-503 under HAF outage during pre-broadcast validation?
- `POST /api/reviews` (post review) — similar.
- `POST /api/papers/:a/:p/comments` (post comment) — `commentLimiter`?
- `POST /api/papers/:a/:p/edit` (edit paper) — limiter?
- `POST /api/bridge/register` — has the lock + `LOCK_HELD` 409 retriable path; verify the lock interaction with the limiter doesn't double-burn.
- `POST /api/papers/:a/:p/claims/.../approve` and `/revoke` — admin paths; lower priority.

For each affected route, apply the same fix as `/retract` OR document explicitly why the route is exempt (e.g., the limiter is per-IP not per-account, so cooldown isn't user-locking).

### 4. Documentation

`agents/docs/api-contracts/papers.md` (or wherever the rate-limited routes' Errors sections live) gains an explicit note on the 503-retriable behavior under rate limiting: "Clients that retry on `details.retriable` should respect `Retry-After` (if present) and bound their own retry attempts; the rate limiter exempts retriable 5xx but the SPA should still self-bound to avoid pathological loops." Architect handles the doc edit at archive; flag via `[TODO Architect]` in the signal block.

## Out of scope

- Rebuilding the rate-limit middleware from scratch. The fix should reuse existing middleware semantics where possible.
- Sliding-window vs fixed-window limiter semantics. PEvO uses what it uses; not in scope.
- Per-IP vs per-account limiter discrimination changes. Not in scope.
- BROADCAST_FAILED / BROADCAST_TIMEOUT slot-burn behavior. Those are chain-side errors with explicit `verify_before_retry` guidance; the SPA doesn't auto-retry on them. Separate concern.

## Cross-references

- `backend/src/routes/papers.ts:720` — `retractLimiter` declaration.
- `backend/src/routes/papers.ts:3095` (post round-2 hold) — `/retract` HafQueryError catch arm emitting the new retriable 503.
- `backend/src/middleware/rateLimit.ts` — limiter middleware (verify `skipFailed` support).
- `agents/docs/api-contracts/common.md` § 503 SERVICE_UNAVAILABLE and details.retriable — the cross-cutting note on retriable 503 emitters (updated 2026-05-20 in commit `66b213ac` to enumerate the new emitter classes).
- `agents/docs/api-contracts/papers.md` § POST /api/papers/:author/:permlink/retract Errors — `SERVICE_UNAVAILABLE` entry already notes the rate-limit interaction guidance pending this task's resolution.

## Backend completion signal (2026-05-20)

**Decision: Option A (`skipFailedRequests: true`) on `retractLimiter`.** Rationale below; threat-model analysis of the 4xx-refund concern verified.

### Middleware semantics (verified by reading `backend/src/middleware/rateLimit.ts`)

`skipFailedRequests` refunds the slot on ANY response with `statusCode >= 400` (both 4xx and 5xx). The refund fires from `res.on('finish')` AND `res.on('close')` with a once-guard, so TCP-abort / client-disconnect is also covered. Implementation uses an atomic Lua EVAL (Redis path) or in-memory splice (fallback) so concurrent INCRs cannot overshoot the limit. The architect's "verify the middleware semantics" question is therefore answered: refund applies to both 4xx and 5xx.

The architect flagged this as a concern ("if both, the 422-already-retracted path becomes an unbounded retry surface"). The /retract route's threat model neutralizes the concern:

- **422 already retracted, 404 paper not found, 403 wrong author** — these paths only fire for a verified-signature request where `username === URL author`. The attacker can only retract their own papers; 422 = "I'm trying to retract my own already-retracted paper" — no value to repeated probing. 404 = "I'm trying to retract a paper I claim to own that doesn't exist" — equivalent to the public `/api/papers/:a/:p GET` probe surface which is unrate-limited anyway. 403 cannot fire because verifyHiveSignature already gated the request to the user's own coords.
- **502 BROADCAST_FAILED, 504 BROADCAST_TIMEOUT** — these carry `verify_before_retry: true` in the response envelope per `agents/docs/api-contracts/common.md`. SPA does NOT auto-retry on these; the user must manually verify on-chain before re-clicking.
- **503 SERVICE_UNAVAILABLE retriable: true** — the case this task closes. SPA's retry loop on `details.retriable === true` would previously burn the slot on every retry attempt.
- **500 INTERNAL_ERROR** — SPA does not auto-retry on 500.

Per-route 4xx refund is therefore safe on /retract. Option B (per-route-code surgical refund) would have required new middleware API surface (no `req.rateLimit.refund()` exposed today); Option A reuses the existing well-tested mechanism.

### Implementation

`backend/src/routes/papers.ts` — `retractLimiter` declaration extended with `skipFailedRequests: true`. The single-line addition carries a multi-line comment block explaining the threat-model analysis (4xx-refund safety on this route).

### Tests

New file: `backend/tests/routes/retract-rate-limit-skip-failed.test.ts` — two canaries:

1. **Slot burn = 1 per outage event** (`5 HAF-throw requests + 1 success request → 6th succeeds`).
   - 5 `POST /retract` requests with HAF mocked to throw → each returns 503 retriable (failure → refund).
   - 6th request with HAF returning paper rows → succeeds (200) and triggers a broadcast.
   - Pre-fix shape: 5 failures consume all 5 slots → 6th request 429.
   - Mutation-kill verified: `sed -i 's/  skipFailedRequests: true,$//' src/routes/papers.ts` → 6th request returns 429 → canary fails RED.
2. **Real abuse rate still bounded** (`6 successful retracts → 6th request 429`).
   - 5 successful retracts (HAF returns paper, broadcast succeeds) → each 200.
   - 6th retract → 429 RATE_LIMITED.
   - Mutation-kill: if `skipFailedRequests` were over-broad (e.g., also refunding 200s), 6th would succeed → canary fails RED.

Mock setup uses `vi.hoisted` to expose `HafQueryError` + `isRetriableHafError` ahead of ES-import order so the route's `instanceof HafQueryError && isRetriableHafError(err)` gate fires on the simulated outage path. Per-test account names use `Math.random()` suffix to avoid cross-run Redis-key persistence polluting slot counts.

### Cross-route audit (acceptance #3)

Enumerated every PEvO rate limiter and checked whether (a) the limiter is per-account (long-window lockout-prone) AND (b) the route emits `details.retriable: true` on transient backend failure AND (c) `skipFailedRequests` is not already set.

| Limiter | Route | Window/Max/Key | retriable emit? | Already skipFailed? | Action |
|---|---|---|---|---|---|
| `retractLimiter` | POST /api/papers/:a/:p/retract | 1hr / 5 / byAccount | YES (HafQueryError → 503 retriable) | NO | **Fix in this task** |
| `claimLimiter` | POST /api/papers/:a/:p/claims | 60s / 5 / byAccount | 503 INTERNAL_ERROR (NOT retriable) | NO | Exempt: short window + no retriable |
| `approveLimiter` | POST /api/papers/:a/:p/claims/:o/approve | 60s / 10 / byAccount | 503 INTERNAL_ERROR (NOT retriable) | NO | Exempt: short window + no retriable |
| `revokeLimiter` | POST /api/papers/:a/:p/claims/:o/revoke | 60s / 10 / byAccount | 503 INTERNAL_ERROR (NOT retriable) | NO | Exempt: short window + no retriable |
| `anonReviewLimiter` | POST /api/anonymous-reviews | 1hr / 5 / byAccount | no retriable emit in route | NO | Exempt: no retriable emit |
| `ipfsUploadLimiter` | POST /api/ipfs/upload | 1hr / 10 / byAccount | no retriable emit in route | NO | Exempt: no retriable emit |
| `broadcastLimiter` | POST /api/custody/broadcast | 60s / 30 / byAccount | no retriable emit at limiter site | NO | Exempt: no retriable emit |
| `upgradeLimiter` | POST /api/custody/upgrade | 1hr / 1 / byAccount | YES | **YES** | Already mitigated |
| `accreditationRequestLimiter` | POST /api/accreditations | 24hr / 3 / byAccount | YES | **YES** | Already mitigated |
| `accreditationVerifyLimiter` | POST /api/accreditations/verify | 60s / 5 / byIp | YES | **YES** | Already mitigated |
| `registerLimiter` | POST /api/bridge/register | 1hr / 10 / byIp | YES (LOCK_HELD 409, HAF 503) | NO | Different threat model (byIp → NAT-shared lockout), not byAccount user lockout — out of this task's scope |
| `invalidateLimiter` | POST /api/papers/:a/:p/invalidate | 60s / 10 / byAccount | not surveyed (admin-scoped) | NO | Exempt: 60s window, fast recovery |

**Conclusion:** `retractLimiter` is the only `byAccount` long-window limiter with a route-side `retriable: true` emit that doesn't already use `skipFailedRequests`. The fix is scoped to this single declaration.

**Note on `registerLimiter` (bridge/register).** This limiter IS on a `retriable: true`-emitting path (the LOCK_HELD 409 from the bridge SETNX flow plus the HAF-unavailable 503 path) but is keyed `byIp`, not `byAccount`. The user-lockout pattern is different — corporate NATs would experience shared-IP lockout under storm but the per-user blast radius is the IP's, not the user's. The task spec explicitly listed it as a candidate to inspect; treating it as out-of-scope here because the threat model differs from `/retract`. Filed as a quasi-followup if architect wants to extend `skipFailedRequests` there too.

### Verification

Scoped vitest (3 files): `retract-rate-limit-skip-failed.test.ts` (2 new specs) + `retract.test.ts` (existing) + `papers-haf-error-vs-not-found.test.ts` — 22 specs green. `npm run typecheck` clean (both src and tests). `npm run lint` clean for this change (preexisting `seed-phrase.ts` / `author-supersession.ts` warnings unchanged).

### [TODO Architect]

Acceptance item 4 — `agents/docs/api-contracts/papers.md` § POST /api/papers/:author/:permlink/retract `SERVICE_UNAVAILABLE` entry already notes the rate-limit interaction guidance pending this task's resolution. With `skipFailedRequests: true` now landed, the architect can:
- Either update that note to reflect the new behavior (failed retries no longer consume slots; retriable 503 budget is now per-success rather than per-attempt).
- Or extend `common.md` if a cross-cutting "503 retriable + per-account rate limiter" note belongs in the general envelope section.

### Out-of-scope items deliberately deferred

- **Cross-route extension of `skipFailedRequests` to `registerLimiter`** (bridge.ts). Different threat model (byIp NAT-shared lockout vs byAccount user lockout); filing a follow-up if the architect wants it widened.
- **Slot accounting on rate limiter for partial degradation** (some routes emit 503 + retriable from the LOCK_HELD path, distinct from HAF-503). Not actionable without a per-code refund API, which is wider middleware scope.
- **Per-request `Retry-After` header on the new 503 paths** (Option C). The task spec listed it as a possible Option C backup; not pursued — the SPA already self-bounds retries via `details.retriable` + its own attempt cap, and adding header tuning per-route is wider than the slot-burn close.

---

## Architect re-review (2026-05-20, round-1 → round-2) — HELD PENDING FIXES

`/ce-code-review` ran on commit `a5589588` with 6 reviewer personas (correctness on Opus; testing, maintainability, project-standards on Sonnet; security on Opus; reliability on Sonnet; `ce-agent-native-reviewer` skipped per PEvO CLAUDE.md; kieran-typescript / adversarial / learnings skipped at architect scope on the config-flip + 207-line test-file diff). Implementation lands structurally clean: `skipFailedRequests: true` on `retractLimiter` with a stable-symbol-anchored 11-line WHY comment, two canaries (slot-burn-on-failure + abuse-rate-bound), and a cross-route audit table that correctly identifies `retractLimiter` as the only `byAccount` long-window limiter with a route-side `retriable: true` emit not already on `skipFailedRequests`. Middleware semantics verified against `backend/src/middleware/rateLimit.ts` (4xx and 5xx refund, dual-listener once-guard, 429 early-return bypasses listener registration so no double-refund). Per-route 4xx-refund threat-model analysis defensible (verified-signature gate ensures attacker can only probe their own paper set on 422/404).

Cluster-wide findings: 5 findings surfaced across the 6 personas, 2 dismissed at architect triage, 1 filed as new follow-up task, 2 held for round-2.

### Items dismissed during architect triage

- **(project-standards P3 conf 55)** `vi.hoisted` block comments use "below" relative anchor on lines 38 + 41. Verified — the "below" describes JS ES-module evaluation-order semantics about ES imports in the same file (a language-spec invariant), not coordination state or file-position drift. The same-day clause broadening enumerated positional anchors as a rot class, but the rot concern is anchors that go stale on edit; ES import hoisting cannot move. Strict-reading the convention here over-applies it.
- **(testing P3 conf 60)** Success-path HAF mock uses SQL substring matching (`sql.includes('parent_author') && includes('parent_permlink')...`) which also incidentally matches `fetchHeadAuthorizedAuthors`. Both failure modes are loud (mock pattern stops matching → 404 response → 200 assertion fails red with a misleading-but-visible symptom; mock pattern matches extra queries → semantic confusion with paper-shaped rows). Per `feedback_dismiss_preemptive_test_hardening`: loud-fail mutation hazards default to dismiss.

### Items filed as new follow-up tasks (not in this task's round-2 scope)

- **(reliability P2 conf 75 + security residual + audit-table-flagged)** `registerLimiter` (`bridge.ts:149`, byIp/10/1hr) emits retriable LOCK_HELD 409 + HAF-503 with SPA auto-retry on `details.retriable`; corporate-NAT cascade cost (3 users × 4 calls = 12 > 10 cap → full NAT 1hr lockout). Implementer's audit-table dismissal cited "different threat model" but the cascade shape (byIp + long window + retriable emit + SPA auto-retry) matches /retract's. `accreditationVerifyLimiter` (60s byIp) already uses `skipFailedRequests`, so the byIp + skipFailedRequests pattern IS in the codebase. Filed as new task `backend-register-rate-limit-byip-skipfailed.md` in `tasks/pending/`.

### Items held (must fix before archive)

**1. (P2, anchor 85, testing + project-standards) Test header docstring's clause-(c) citation is factually wrong — claims `retract.test.ts` exercises real `verifyHiveSignature` against /retract, but `retract.test.ts:29-31` also mocks the middleware via `MOCK_VERIFY_SIGNATURE`.** `backend/tests/routes/retract-rate-limit-skip-failed.test.ts:17-25`. Header text reads "the existing `retract.test.ts` integration suite exercises the full `verifyHiveSignature` + `fetchPaperDetailFromHaf` + broadcast path against signed requests with the real Hive RPC mocked at `broadcastJsonWithTimeout`." Verified false: `papers-haf-error-vs-not-found.test.ts` (the other /retract-touching test) ALSO mocks `verifyHiveSignature`. No test in `backend/tests/routes/` exercises the real signature middleware against POST /api/papers/:author/:permlink/retract. Real-path crypto coverage exists at the corpus level via `sign-request.ts` users (`auth.test.ts`, `bridge-haf-lag-locks.test.ts`, `claims.test.ts`) — those run the real `verifyHiveSignature` on /api/auth + /api/bridge + /api/claims with signed requests, so the middleware itself is real-path-covered at the corpus level, just not co-located on /retract.

   Per the carve-out's clause-(c) refinement in root CLAUDE.md, "the same risk class is covered by a real-path test elsewhere, OR a follow-up task is filed to add such coverage" — the risk class here is "rate-limiter slot accounting under HAF-503 conditions", and the rate-limiter middleware itself is real-path-tested at the corpus level. So the corpus-level coverage satisfies clause (c); only the per-file citation is incorrect.

   Fix: rewrite the header's clause-(c) paragraph to acknowledge corpus-level real-path coverage of the `verifyHiveSignature` middleware via the `sign-request.ts` users (e.g., `auth.test.ts`, `bridge-haf-lag-locks.test.ts`, `claims.test.ts`) and the rate-limiter middleware via `tests/middleware/rateLimit.test.ts`, rather than naming `retract.test.ts` (which mocks the middleware itself). The clause-(c) intent is satisfied at the corpus level; the carve-out is for focus, not for skipping auth verification entirely from the codebase. No new test is required by this hold item.

### Architect followups (no implementer action)

- **A1.** `agents/docs/api-contracts/papers.md` § POST /api/papers/:author/:permlink/retract `SERVICE_UNAVAILABLE` entry — update to reflect `skipFailedRequests: true` semantics (failed retries no longer consume slots; retriable 503 budget is now per-success rather than per-attempt). Implementer flagged via `[TODO Architect]`; architect handles at archive time.

### Re-review signal

When item 1 lands in a single round-2 commit, `git mv` this file back to `tasks/review/`. The mv itself is the re-review signal. Round-2 architect review scopes `/ce-code-review` to the round-2 commit only.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>

---

## Backend re-review signal (2026-05-20, round-2 hold-fix)

**Item 1 — clause-(c) citation rewrite: LANDED.** Rewrote the header docstring's clause-(c) paragraph in `backend/tests/routes/retract-rate-limit-skip-failed.test.ts` per the architect's prescription. No new test was required (hold-block was explicit on this point).

**Before/after shape (clause (c) only; clauses (a) and (b) untouched):**

Before:
```
(c) Real-path companion: the existing
`retract.test.ts` integration suite exercises the full `verifyHiveSignature`
+ `fetchPaperDetailFromHaf` + broadcast path against signed requests
with the real Hive RPC mocked at `broadcastJsonWithTimeout`.
```

After:
```
(c) Real-path companion: corpus-level
real-path coverage of the `verifyHiveSignature` middleware is provided
by the `sign-request.ts` consumers — `auth.test.ts`, `claims.test.ts`,
and `bridge-haf-lag-locks.test.ts` exercise the real middleware against
cryptographically signed requests on sibling routes. The rate-limiter
middleware itself (the risk class this file pins) is real-path-covered
by `tests/middleware/rateLimit.test.ts`. The carve-out is for focus,
not for skipping auth verification entirely from the codebase.
```

**Corpus-level coverage citations verified to exist:**
- `backend/tests/routes/auth.test.ts` — exists; uses `sign-request.ts`, real `verifyHiveSignature` (confirmed via grep: only references `MOCK_VERIFY_SIGNATURE` in a comment noting it does NOT use the fixture).
- `backend/tests/routes/claims.test.ts` — exists; uses `sign-request.ts`, real `verifyHiveSignature`.
- `backend/tests/routes/bridge-haf-lag-locks.test.ts` — exists; uses `sign-request.ts`, real `verifyHiveSignature`.
- `backend/tests/middleware/rateLimit.test.ts` — **EXISTS**. The rate-limiter middleware real-path coverage citation is accurate; no fallback needed.

**Convention-enforcing-fix self-audit:** the replacement clause-(c) text contains zero anchor-rot vectors. No task-slug citations (file paths like `auth.test.ts` are stable filesystem paths, not coordination-state slugs). No line-number anchors. No SHA references. No round-number coordination state. Only stable symbols: the exported middleware function name `verifyHiveSignature`, the helper file name `sign-request.ts`, and the four test file paths cited above. Per `agents/docs/solutions/conventions/convention-enforcing-fix-must-audit-its-own-new-code-2026-05-17.md`: replacement passes audit.

**Scope discipline:** clauses (a) and (b) were not edited. Only the clause-(c) paragraph was rewritten, per the architect's "Don't touch clauses (a) and (b)" instruction.

**Verification:** scoped `npm run typecheck` from `backend/` planned to confirm the test file still parses (Docker env overrides for full vitest deferred to round-2 architect review since the edit is comment-only and cannot affect runtime behavior).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
