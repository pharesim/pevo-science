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

---

## Architect re-review (2026-05-17) — HELD PENDING FIXES

`/ce-code-review` on commit `a6367ab` ran 8 personas (correctness + security + adversarial on opus; testing + maintainability + project-standards + reliability + kieran-typescript on sonnet; ce-agent-native-reviewer skipped per project CLAUDE.md). Cross-reviewer corroboration on the comment-vs-reality contradiction (correctness × security × testing). Five items held; all bundle into one round-2 commit since they edit overlapping code-comment regions.

### Item 1 — Comment claims "4xx still consumes a slot" but middleware refunds on ANY `statusCode >= 400`

**Severity:** P2 · **Cross-corroborated:** correctness × security × testing
**Files:** `backend/src/routes/accreditation.ts:28-29` (comment) + commit message of `a6367ab`

The route's new comment block claims: *"4xx responses (400 validation, 422 non-institutional email) still consume a slot, so brute-force schema probing is still rate-limited."* The commit message echoes this. But `backend/src/middleware/rateLimit.ts:100-101` refunds on ANY `res.statusCode >= 400` — the 4xx paths from `validate` (zod schema failures, 400 VALIDATION_ERROR) and `isInstitutionalEmail` (422) also refund. The primitive's docblock at `rateLimit.ts:18-29` explicitly cites this as deliberate (stolen-JWT attacker case).

**Operational impact today is bounded:** the 4xx paths short-circuit BEFORE `storeToken` and `sendMail`, so probing only costs Redis-rate-limit ops with no SMTP/token side effects. But the comment's "brute-force probing is rate-limited" claim is factually wrong, and a future change that inserts an expensive operation before the institutional-email check would silently inherit unbounded amplification.

**Fix shape:** rewrite the comment to honestly describe symmetric `>= 400` refund. Either remove the brute-force-probing claim or qualify it ("4xx paths short-circuit before expensive ops, so refund-on-4xx is acceptable; future expensive pre-checks must add their own throttle").

### Item 2 — Add 4xx-consume / 4xx-refund canary

**Severity:** P2 · **Source:** testing T1
**File:** `backend/tests/routes/accreditation.test.ts` (extend the `BE-ACCRED-REQ-LIMITER` describe block)

The current canary only exercises the 5xx-REFUNDS half of the contract. A mutation flipping `>= 400` to `>= 500` in the middleware would not be caught. Add a sibling spec: drive three 422 non-institutional-email 422s for the same account, then assert the fourth request returns 200 (NOT 429) — pins the symmetric 4xx-refund behavior as the actual contract.

If round-2 chooses to keep the comment's "4xx consumes a slot" framing AND change the primitive to honor it (out of scope per architect dismissal in this round), document the choice; otherwise pin the symmetric refund.

### Item 3 — Slug + line citation cleanup in the comment block

**Severity:** P2 · **Source:** maintainability M1
**File:** `backend/src/routes/accreditation.ts:25-34`

The 9-line comment ends with two rotting anchors:
- `backend/src/routes/custody.ts:50` — line-number citation; `custody.ts:50` is itself inside a comment block (45-65). Any edit shifts the target mid-sentence in a different comment.
- `backend-custody-upgrade-limiter-skip-failed` — task slug. Already archived 2026-05-16; `tasks-archive.md` is trimmed to 250 lines; entry will roll off.

Per `agents/docs/solutions/conventions/task-slug-citations-in-comments-go-stale-on-archive-2026-05-15.md` and `docblock-anchor-stable-symbols-not-line-numbers-2026-05-15.md`: anchor on behavioral descriptions or stable type symbols, not transient slugs or line numbers.

**Fix shape:** drop the `custody.ts:50` line number (keep prose: "mirrors the `upgradeLimiter` shape in `custody.ts`"). Replace the slug citation with a reference to `RateLimitConfig.skipFailedRequests` JSDoc — the type definition is the stable anchor.

### Item 4 — Adopt `deleteTokenBestEffort` on /request SMTP-failure deleteToken sites

**Severity:** P3 · **Source:** adversarial composition-failure finding
**File:** `backend/src/routes/accreditation.ts:373-375, 386-388`

Sibling /verify route wraps deleteToken in `deleteTokenBestEffort` (lines 280-312) per `helper-extraction-express5-response-ordering-2026-04-28.md` (prior documented incident). The /request route's catch block calls `await deleteToken(token)` raw at lines 374, 387.

Combined-failure path: SMTP throws (the documented refund case) AND Redis is mid-flap. `await deleteToken(token)` throws → rejection propagates BEFORE `sendError(res, 500, ...)` runs → Express 5 default async-error handler writes a 500 with no `{error:{code,message}}` envelope. Limiter refund still fires correctly (keys on `statusCode >= 400`), so slot accounting is robust; only the user-facing envelope shape regresses.

The skip-failed change makes this path higher-traffic (users now retry instead of being locked out), increasing the observable surface of the envelope-bypass class.

**Fix shape:** mirror the /verify route's `deleteTokenBestEffort` pattern at both /request SMTP-failure deleteToken sites. Two-line edit per site (replace raw `await deleteToken` with `await deleteTokenBestEffort(...)` using distinct discriminators for the two cleanup branches — e.g., `smtp_host_missing_token_cleanup_failed` vs `sendmail_throw_token_cleanup_failed`).

### Item 5 — Test inline comment misdescribes middleware mechanics

**Severity:** P3 · **Cross-corroborated:** correctness × testing (conf 100)
**File:** `backend/tests/routes/accreditation.test.ts:1630-1634`

The test's inline comment says: *"the 5xx responses above each take the `if (res.statusCode >= 400) return` early-out and never INCR."* Both halves are wrong:
- INCR happens UP-FRONT via the Lua script BEFORE `next()` runs (atomic).
- The `>= 400` branch in `'finish'` handler is the REFUND branch, not a no-op early-out.

Behavior is correct; comment will mislead a future maintainer debugging slot-refund timing.

**Fix shape:** rewrite to describe the actual mechanism — INCR atomically up-front, `'finish'` handler fires DECR on `statusCode >= 400` to refund. By the time supertest's `await` resolves the next request, the prior DECR has been scheduled (microtask) and typically completed.

### Item 6 — Carve-out clause (c) citation off by ~20 lines

**Severity:** P3 · **Source:** testing testing-3
**File:** `backend/tests/routes/accreditation.test.ts:1578`

Header's clause (c) citation points to `custody-upgrade.test.ts:498`, which is the plain 503-on-throw spec (no slot-refund). The actual `skipFailedRequests` canary against `upgradeLimiter` is at `:518` (`Hive getAccounts throws then recovers: 503 refunds limiter slot so the retry succeeds`). Clause (c) is satisfied (the real-path slot-refund coverage exists on the sibling route), but the citation points to the wrong test.

**Fix shape:** update the line reference from `:498` to `:518`.

### Files for round-2

- `backend/src/routes/accreditation.ts` (items 1, 3, 4)
- `backend/tests/routes/accreditation.test.ts` (items 2, 5, 6)
- This task file (round-2 implementer signal block when moving back to review/)

### Dismissed at architect triage (recorded for transparency)

- **Aborted-response slot consumption** (reliability REL-001 P2/80): `res.on('finish')` doesn't fire on socket close mid-response. Practical incidence low in PEvO context (1-3s SMTP window, single-instance behind nginx 60s timeout, low traffic). Preemptive primitive hardening; dismissed per `feedback_dismiss_preemptive_test_hardening`.
- **Unbounded SMTP send budget abuse** (adversarial P2/60): requires session credentials + persistent-5xx target. Operator-side defenses (relay quotas, IP reputation) are the right layer; not a code-side concern at PEvO scale.
- **Detached refund DECR race** (adversarial P2/55): one-Redis-RTT window. Sub-ms in PEvO single-instance; SPA doesn't auto-retry 500s. Same shape as upgradeLimiter precedent.
- **Test username helper extraction** (maintainability M2 P2/75): 16+ duplicated `Date.now()+random` sites across `backend/tests/`. Premature abstraction; the next test that touches the pattern is the natural extraction trigger.
- **Refund DECR error log debug→warn** (reliability REL-002 P3/70): proposes log expansion; default-dismiss per `feedback_pevo_logging_minimal`.
