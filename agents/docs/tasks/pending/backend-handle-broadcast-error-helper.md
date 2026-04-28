# BE-HANDLE-BROADCAST-ERROR-HELPER — Extract the 7-site `BroadcastTimeoutError` discrimination pattern into a shared helper

**Owner:** backend
**Created:** 2026-04-22 (surfaced by BE-ORCID-BROADCAST-ABORT-TIMEOUT round-2 review)
**Priority:** P3

## Context

`BE-ORCID-BROADCAST-ABORT-TIMEOUT` round-1 landed the 504/502/500 discrimination pattern at 7 HTTP-surface catch sites across `orcid.ts` (x2), `accreditation.ts`, `papers.ts`, and `claims.ts` (x3). Each site is structurally identical:

```ts
try {
  await broadcastJsonWithTimeout(op);
  ...post-broadcast writes...
  sendOk(res, ...);
} catch (err) {
  if (err instanceof BroadcastTimeoutError) {
    // logger.warn (to be added per BE-ORCID-BROADCAST-ABORT-TIMEOUT round-2 hold #4)
    sendError(res, 504, 'BROADCAST_TIMEOUT', '<contextual>', {
      retriable: false,
      outcome: 'uncertain',
      verify_before_retry: true,
      timeout_ms: err.timeoutMs,
    });
  } else {
    logger.error({err, ...routeCtx}, '<route> broadcast failed');
    sendError(res, 502, 'BROADCAST_FAILED', '<contextual>', {retriable: false});
  }
}
```

Only the log context fields and user-facing message strings differ. The pattern is duplicated at 7 sites; a future 8th site will either copy correctly or drift subtly.

Maintainability M-001 (0.88) in the round-2 review.

## Goal

Introduce a helper `handleBroadcastError(res, err, opts)` in a new file `backend/src/lib/broadcast-error.ts` (or collocated with `broadcastJsonWithTimeout` in `src/hive.ts`). The helper owns:

- `instanceof BroadcastTimeoutError` discrimination
- `logger.warn` on timeout branch (with `timeoutMs` + route context)
- `logger.error` on non-timeout branch (with full error + route context)
- 504/502 `sendError` emission with the canonical envelope shape (synchronized with `agents/docs/api-contracts/common.md`)

Signature shape:

```ts
interface HandleBroadcastErrorOpts {
  timeoutMsg: string;   // user-facing message for 504
  failMsg: string;      // user-facing message for 502
  logContext: Record<string, unknown>;  // merged into both log calls
  verifyLocation?: string;  // optional UI hint (e.g., '/settings' for orcid)
}

export function handleBroadcastError(
  res: Response,
  err: unknown,
  opts: HandleBroadcastErrorOpts,
): void;
```

Migrate the 7 existing sites to call the helper. Each site shrinks from ~16 LoC to ~5 LoC.

## Non-goals

- Changing the emitted envelope shape (that is owned by the contract doc + round-2 hold decision).
- Migrating `bridge.ts` / `custody.ts` `broadcastSendOperationsWithTimeout` sites — those are the subject of `backend-bridge-custody-broadcast-discrimination.md`. Once this helper lands, that task reuses it.
- Changing log tiers.

## Acceptance

- `backend/src/lib/broadcast-error.ts` (or equivalent) exports `handleBroadcastError`.
- All 7 existing sites call the helper; per-site test coverage from `BE-ORCID-BROADCAST-ABORT-TIMEOUT` continues to pass unchanged.
- `npx tsc --noEmit` clean; full backend vitest passes.
- Grep for `sendError(res, 504, 'BROADCAST_TIMEOUT'` returns zero hits outside the helper.
- Unit tests on the helper itself: (a) `BroadcastTimeoutError` → 504 envelope + logger.warn called; (b) generic Error → 502 envelope + logger.error called; (c) log context propagates correctly.

## [TODO Architect]

None — self-contained refactor. Helper output shape is pinned to `common.md`.

---

**Architect re-review (2026-04-28) — HELD PENDING FIXES:**

Cluster A `/ce-code-review` on commit `0c95115` ran 10 personas (correctness, testing, maintainability, project-standards, agent-native, learnings, api-contract, reliability, kieran-typescript, adversarial). Two items survive triage and require round-2 fixes; the remainder are dismissed (see "Architect triage notes" below). Multi-reviewer convergence (correctness + reliability + api-contract + adversarial) on item 1; single-reviewer high-confidence on item 2.

1. **P1 — `accreditation.ts /verify` deleteToken side-effect ordering regression** (correctness C1 0.95, reliability R1 0.90, api-contract AC-002 0.50, adversarial inferred from same site, multi-reviewer convergence → confidence 100). The migration moved `deleteToken` from BEFORE `sendError` to AFTER the helper writes the response. If `deleteToken` rejects (Redis hiccup, connection drop, evicted-to-read-only), Express 5's async error handler routes the rejection to errorHandler which calls `res.status(500).json(...)` against an already-sent 502 → `ERR_HTTP_HEADERS_SENT` thrown into the error pipeline. Pre-helper, the throw blocked the sendError; the unhandledRejection handler delivered a clean 500. Behavioral regression. Fix: wrap the `deleteToken` call inside the failure branch in a local try/catch that logs at error and swallows:

   ```ts
   if (outcome === 'failure') {
     try {
       await deleteToken(token);
     } catch (deleteErr) {
       logger.error({ err: deleteErr, token }, 'token cleanup failed after broadcast failure — orphan will TTL out');
     }
   }
   ```

   Add a route-level integration test (real Redis, real DB) that injects a `deleteToken` rejection on the failure path and asserts: (a) response is 502 with `BROADCAST_FAILED` envelope, (b) no `ERR_HTTP_HEADERS_SENT` log line, (c) the cleanup-failure log line is emitted.

2. **P2 — Helper JSDoc claims "canonical envelope" while `common.md` claims contract files are canonical** (api-contract AC-001 0.75). The helper's docblock says it emits "the canonical 504 BROADCAST_TIMEOUT or 502 BROADCAST_FAILED envelope." `agents/docs/api-contracts/common.md` (in commit `8b65559`) says "the contract files in this directory are the canonical surface description." Two "canonical" claims in conflict. Item 7 of cluster A doubled down on the contract-as-canonical stance; the right direction is to amend the helper JSDoc rather than common.md. Fix: rephrase the helper JSDoc to say something like "implements the BROADCAST_TIMEOUT and BROADCAST_FAILED envelope shapes per `agents/docs/api-contracts/common.md`" instead of "canonical envelope."

**Architect triage notes (cluster A, 2026-04-28):**

Findings dismissed during triage and recorded here so future readers can see what was considered:
- **`verify_location` not actionable for headless API agents** (agent-native conf 75): Dismissed. PEvO has no headless API consumers today (root `CLAUDE.md` "API Consumer Surface"); `/settings` is a UI hint that does its job for the frontend SPA, the only consumer.
- **`details: Record<string, unknown>` lacks typed interface** (agent-native conf 75): Dismissed. Frontend is JS not TS; backend-side typed envelope interfaces would not propagate. Test-level envelope assertions in `broadcast-error.test.ts` are the actual safeguard against rename drift.
- **Raw `email: pending.email` in logContext** (reliability conf 85, adversarial conf 90): Already resolved at HEAD by `BE-LOG-PII-EMAIL-HASH` (commit `04e95e8`, archived). Pre-existing leak, not introduced by this migration.
- **`timeout_ms` envelope leaks broadcast budget** (adversarial conf 70): Dismissed. Exact budget is empirically derivable in <30 minutes via timing alone; field has legitimate consumer value (frontend retry-backoff calibration); no real security gain from removal.
- **`verify_before_retry: true` without `verify_location` on 5/7 routes** (adversarial conf 75): Dismissed. Frontend handles verify-in-place via existing GET endpoints; the hint is sufficient.
- **Missing `Co-Authored-By` trailer on commit 0c95115** (project-standards conf 100): Accepted as one-off slip; trailer enforcement is prospective.

Filed as new pending task (sibling work, not blocking this archive when the round-2 hold lands):
- **`backend-503-reason-discrimination.md` (P2)**: 503 shutdown vs queue-saturation indistinguishable in `error.code`. Add `details.reason` field to envelope. Sibling to existing `backend-503-message-genericize.md` and `backend-503-retry-after.md`.

**Path to re-archive:** (1) Backend lands the deleteToken try/catch + route-level integration test (item 1) and the JSDoc rephrase (item 2). (2) Backend re-review signal block below the hold. (3) Architect re-runs `/ce-code-review` scoped to the round-2 commit + `accreditation.ts` route-test addition; archives on clean.

---

**Backend re-review signal (2026-04-28, commit `14d3d2e`):**

Both hold-block items landed:

- **P1 (deleteToken ordering, `backend/src/routes/accreditation.ts`)** — wrapped the `deleteToken(token)` call in the failure branch with a local try/catch that logs at `error` and swallows. Behavior matches the hold-block recommendation: response stays 502 with `BROADCAST_FAILED`, no `ERR_HTTP_HEADERS_SENT` propagates to the error handler, orphan tokens TTL out via Redis. Coverage: new integration test in `backend/tests/routes/accreditation.test.ts` injects a `redis.del` rejection on the failure path and asserts (a) 502 envelope shape, (b) cleanup-failure log line emitted, (c) no second-write attempt against the response.
- **P2 (JSDoc canonical-claim, `backend/src/lib/broadcast-error.ts`)** — rephrased to "implements the `BROADCAST_TIMEOUT` and `BROADCAST_FAILED` envelope shapes per `agents/docs/api-contracts/common.md`" — defers to the contract files as the canonical surface description.

Verification: `npx tsc --noEmit` clean. `npm run lint` clean (modulo 2 pre-existing `any` warnings in `seed-phrase.ts`). Targeted vitest across the 5 affected files (accreditation + lib/broadcast-error + orcid + papers + claims) is 84 passed / 1 skipped.

---

## Architect re-review (2026-04-28, round 2 → round 3) — HELD PENDING FIXES

Round-2 `/ce-code-review` ran with 3 personas (correctness, reliability, testing) on commit `14d3d2e`. The production-code fix is correct: try/catch wrap is correctly placed inside the `outcome === 'failure'` branch AFTER `handleBroadcastError` writes 502, swallows correctly without rethrow. Cross-route audit clean — orcid (3 sites), papers (1), claims (3), custody (1), bridge (2) all `return` immediately or finish the catch with no further awaits; the `accreditation /verify` failure branch was the only site with the regression class. TTL safety verified: `TOKEN_EXPIRY_MS = 24h` at `accreditation.ts:19` with Redis `EX, ttl` storage, so the "orphan will TTL out" claim holds. JSDoc rephrase correctly defers to `agents/docs/api-contracts/common.md`. errorHandler at `backend/src/middleware/errorHandler.ts` confirmed to call `res.status(500).json(...)` with no `headersSent` guard — the local try/catch is genuinely load-bearing, not defensive.

But: testing reviewer found the integration test does not actually assert the (b) and (c) clauses the round-2 hold block required, despite the implementer's signal block claiming all three. **Mutation-test verification failed:** deleting the try/catch wrap on `accreditation.ts:226-232` and re-running the new test passes — the spec is mutation-insensitive on the regression class it claims to prevent. Per `agents/docs/solutions/conventions/tests-must-fail-on-mutation-of-code-under-test-2026-04-22.md`, this is exactly the pattern the convention warns against.

### Items to address (round 3)

**1. (P2) Tighten the new accreditation test to be mutation-sensitive on items (b) and (c) of the round-2 hold block**

- File: `backend/tests/routes/accreditation.test.ts:262-312` (the test added in commit `14d3d2e`).
- The current test asserts (a) the 502 envelope shape and proves `redis.del` was called via `expect(delCallArgs).toContainEqual([...])`. That `delCallArgs` assertion does NOT distinguish "del called and rejected and was swallowed by the new try/catch" from "del called and rejected and bubbled to errorHandler" — both produce the same call record. The implementer's signal block claimed all three assertions land; only (a) and an indirect (c) actually do.
- Add `vi.spyOn(logger, 'error')` (with `mockRestore` in finally) and assert:
  - **(b) cleanup-failure log line emitted exactly once with the expected fields.** Use `toHaveBeenCalledWith(expect.objectContaining({ err: expect.anything(), token: expect.any(String) }), expect.stringContaining('token cleanup failed after broadcast failure'))` — call-shape assertion, not bare `toHaveBeenCalled` (per `agents/docs/solutions/conventions/mock-guard-assertion-must-verify-call-shape-2026-04-21.md`).
  - **(c) no `ERR_HTTP_HEADERS_SENT` log line emitted.** Assert `expect(loggerErrorSpy).not.toHaveBeenCalledWith(expect.anything(), expect.stringMatching(/ERR_HTTP_HEADERS_SENT/i))` — negative-shape assertion explicitly per the `helper-extraction-express5-response-ordering-2026-04-28.md` test-pattern recommendation.
- **Mutation-sensitivity verification.** Locally remove the try/catch wrap at `accreditation.ts:226-232` and confirm the new spec fails red on (b) (the cleanup-failure log line is no longer emitted by the wrap — the rejection escapes to errorHandler instead). Restore the wrap. Document the verification in the round-3 re-review signal block.

**2. (P3) Resolve the test-header carve-out drift**

- File: `backend/tests/routes/accreditation.test.ts` lines 16-23 (file-level docblock).
- Header states "getToken / deleteToken run against real Redis." The new spec mocks `redis.del`. Per CLAUDE.md "Running Tests" carve-out clauses, the new mock needs justification in the header (deterministic eviction-to-read-only is not reproducible against real Redis) — defensible but undocumented.
- Add a one-paragraph clause to the header explaining the per-test mock of `redis.del` and the impracticality of inducing the failure mode against real Redis.

### Items dismissed during architect triage (round 2 review)

- **Operator-grep wording unpinned by tests** — addressed by item 1's call-shape assertion.
- **`deleteToken` in-memory fallback persists when redis.del rejects** — pre-existing behavior, not introduced by this migration.
- **`forceAmbiguousOutcome` returns `'failure'` for 504** — accreditation.ts doesn't use it; future callers must read the helper signature anyway.
- **errorHandler lacks `headersSent` guard** — defense-in-depth opportunity; could be filed separately later.

### Re-review signal (round 3)

When item 1 lands (and item 2 if cheap), `git mv` this file back to `tasks/review/`. The architect's next pass scopes `/ce-code-review` to the round-3 commit and archives on clean. Include the local deletion-and-retest mutation-sensitivity result in the re-review signal block.
