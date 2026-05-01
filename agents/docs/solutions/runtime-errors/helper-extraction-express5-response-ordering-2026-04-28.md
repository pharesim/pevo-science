---
title: "Helper-extraction migrations can invert response/cleanup ordering under Express 5, producing ERR_HTTP_HEADERS_SENT"
date: 2026-04-28
category: runtime-errors
module: backend/src/routes
problem_type: runtime_error
component: authentication
severity: high
symptoms:
  - "ERR_HTTP_HEADERS_SENT thrown into Express 5 error pipeline when post-broadcast cleanup (deleteToken) rejects after the helper has already sent a 502 response"
  - "Express 5 async error handler attempts res.status(500).json(...) against an already-written response; final status code is non-deterministic depending on which write finishes last"
  - "Pre-helper, the same Redis hiccup produced a clean 500 because cleanup ran before sendError; post-helper, the cleanup throw escapes a fully-written response"
  - "Orphan tokens accumulate in Redis when the cleanup throw is caught by Express before the deleteToken promise resolves"
root_cause: async_timing
resolution_type: code_fix
related_components:
  - database
  - tooling
tags:
  - express-5
  - helper-extraction
  - response-ordering
  - err-http-headers-sent
  - broadcast-error
  - cleanup-after-send
  - migration-audit
  - async-error-handler
---

# Helper-extraction migrations can invert response/cleanup ordering under Express 5

## Problem

When a helper extraction moves response-writing out of a route's catch block, any `await` statements that follow the helper call now execute after the response is already committed. Under Express 5's async error handler, an unhandled rejection from those post-response awaits triggers a second `res.json()` attempt against the already-written response, producing `ERR_HTTP_HEADERS_SENT` and delivering an indeterminate status code to the client.

The regression is invisible to "behavioral parity" tests that only assert the response shape under successful cleanup. It only fires on the cleanup-failure code path, which most existing test suites don't exercise.

## Symptoms

- `ERR_HTTP_HEADERS_SENT` appears in server logs on the cleanup-failure path.
- Clients on that path receive a 500 (from Express 5's error handler) instead of the intended 502 `BROADCAST_FAILED` (or whatever the helper wrote first).
- The actual response status code is non-deterministic: whichever of the two concurrent writes finishes last wins, so the client may see 502 or 500 depending on runtime scheduling.
- Orphan tokens or other resources accumulate in the data store: when the cleanup `await` throws and Express catches it before the cleanup promise resolves, the resource is never released and persists until its TTL expires (if any).

## What Didn't Work

The implementer's parity audit framed "behavioral parity" as "same response shape when things go right." The pre-extraction and post-extraction paths both produced the same 502 body under the happy path for the failure branch, and existing tests confirmed this. The audit did not separately audit what happens when the cleanup side-effect itself fails.

The structural gap the implementer missed: in the pre-extraction code at `backend/src/routes/accreditation.ts /verify`, the order was `deleteToken → sendError`. A throw from `deleteToken` blocked `sendError` entirely, so Express 5's error handler produced a clean 500 with no prior response written. In the post-extraction code, the helper writes the 502 synchronously, then control returns to the caller, which awaits `deleteToken`. A rejection from `deleteToken` now escapes into Express 5 with the response already committed.

The test suite used an in-memory mock of `deleteToken` that never rejects, so this path was never exercised. The change passed type-check, lint, and the existing test suite. Only the architect re-review's `/ce-code-review` cross-persona fan-out (correctness + reliability + api-contract + adversarial, cross-reviewer convergence at confidence anchor 100) caught the regression. Without the multi-persona review, it would have shipped silently.

The broader framing failure: "same response when things go right" is insufficient parity for catch blocks. Catch blocks must be audited for "same behavior when the secondary side-effect inside the catch block also fails."

## Solution

Wrap the post-helper cleanup in a local try/catch that swallows the rejection and logs it. At `backend/src/routes/accreditation.ts /verify`, after the `handleBroadcastError` call:

**Before (regression — only the failure-branch lines shown; the BroadcastTimeoutError early-return above them is unchanged):**
```ts
} catch (err) {
  const outcome = handleBroadcastError(res, err, { ... });
  if (outcome === 'failure') {
    await deleteToken(token);
  }
}
```

**After (fix):**
```ts
} catch (err) {
  const outcome = handleBroadcastError(res, err, { ... });
  if (outcome === 'failure') {
    try {
      await deleteToken(token);
    } catch (deleteErr) {
      logger.error(
        { err: deleteErr, token },
        'token cleanup failed after broadcast failure — orphan will TTL out'
      );
    }
  }
}
```

The only diff is the wrapping `try/catch` around `deleteToken`. Branching, logging shape, and response path are unchanged.

`deleteErr` is typed `unknown` under TypeScript strict mode (`useUnknownInCatchVariables: true`, default since TS 4.4). Pass it through as `{ err: deleteErr }` — pino accepts `unknown` values in bindings and serializes safely. Do **not** reach for `(deleteErr as Error).message`: any non-Error rejection (e.g. a string thrown by a downstream library) silently becomes `undefined.message`, which then prints as `undefined` in the log line, losing the operational signal the catch was added to provide.

The rejection is contained inside the route handler's success path. The response has already been written cleanly. The cleanup failure becomes a logged operational event rather than a protocol error, and orphan-resource cleanup falls back to whatever TTL safety net exists.

## Why This Works

The root cause is **ordering inversion introduced by helper extraction**. Pre-extraction, `sendError` was the final statement in the catch block; any exception from a preceding `await` prevented `sendError` from executing, so Express 5's error handler saw a route handler that threw before writing a response — a clean single-response outcome. Post-extraction, the helper writes the response first and returns a discriminant value. The caller then awaits a cleanup operation. Any rejection from that cleanup propagates out of the route handler after the response is committed, which Express 5's `asyncHandler` wrapper treats as a new error and routes to the global error handler. The global error handler unconditionally calls `res.status(500).json(...)`, hitting the already-committed response and producing `ERR_HTTP_HEADERS_SENT`.

Wrapping the cleanup in a local try/catch prevents the rejection from escaping the route handler entirely. Express 5 never sees it. The response path is correct. The cleanup failure becomes a logged operational event rather than a protocol error.

**Express 4 vs Express 5 distinction**: this class of bug does not fire on Express 4, which does not auto-route async rejections from route handlers to the error handler. Backends mid-upgrade from Express 4 to Express 5 will encounter it only after the upgrade lands. Any helper extraction that happened pre-upgrade and still looks "fine" at code-review time may start firing this regression the moment Express 5 is enabled.

## Prevention

- **Call-site audit on helper extraction.** When extracting a helper that takes over response-writing from a catch block, enumerate every `await` statement that follows the helper call at each call site. Each one is a candidate ordering-inversion site. Ask: "does this await's rejection now escape after the response is written, where before it would have blocked the response?" Sites without post-helper awaits (e.g., the migration's other route catch blocks at `orcid.ts`, `papers.ts`, `claims.ts`) are safe; sites with post-helper awaits (`accreditation.ts /verify`'s `deleteToken`) are candidates.

- **Before/after structural checklist.** During the review of any helper migration, verify: "did `sendError` (or equivalent response-write) move from BEFORE a side-effect to AFTER it?" If yes, the side-effect's failure mode now operates against an already-committed response. Require explicit handling.

- **Test pattern for failure-branch cleanup.** For every catch block that contains both a response-write and a subsequent async cleanup, add a test variant that injects a cleanup rejection and asserts: (a) the response carries the expected 5xx status code (e.g. `expect(res.status).toBe(502)`), (b) the cleanup-failure log line was emitted exactly once with the expected message, NOT a generic `logger.error` call count (use `expect(loggerErrorSpy).toHaveBeenCalledWith(expect.objectContaining({ token: ... }), expect.stringContaining('token cleanup failed'))` — pino's `logger.error` is called from many other branches, so a bare `toHaveBeenCalled()` would pass even if the cleanup log were absent), (c) `expect(loggerErrorSpy).not.toHaveBeenCalledWith(expect.anything(), expect.stringMatching(/ERR_HTTP_HEADERS_SENT/))` — the regression's load-bearing signal. The test that existed for the 502 path only asserted the response shape under successful cleanup; the cleanup-failure variant was missing entirely.

- **Express 4 → 5 migration as a re-audit trigger.** Express 5's async route handler wrapping turns previously-silent cleanup rejections into double-response attempts. Treat any Express major-version upgrade as a trigger to re-audit all helpers that take over response-writing AND all catch blocks that contain post-response awaits.

- **Survivor log fields for orphan resources.** Independent of this fix, when a cleanup is swallowed with a log, include a structured field (e.g. `token`, `ttl_expiry`, resource ID) so an operator can query for orphaned resources later and confirm the TTL safety net is adequate for the use case.

- **Multi-persona review at archive time.** This regression was caught only because the architect ran `/ce-code-review` with the full persona fan-out at archive time, with cross-reviewer convergence among correctness, reliability, api-contract, and adversarial personas. Single-reviewer reads (or skipped reviews on "obvious refactors") would not have caught it. The broader policy lesson: behavior-preservation refactors deserve full review fan-out, not a "trivial — skip review" exemption.

## Related

- `agents/docs/solutions/conventions/wrapping-primitive-exhaustive-call-site-audit-2026-04-22.md` — structural sibling on migration audits. That doc audits for *coverage* (did every site adopt the wrapper?) and *error-class propagation* (does every `.catch()` rethrow all error classes?). This doc adds a third axis to the same migration-audit discipline: *response/side-effect ordering parity*. The three axes are complementary: coverage proves you reached every site; error-class propagation proves each site propagates correctly; ordering parity proves each site's failure-mode timing is preserved.

- `agents/docs/solutions/conventions/chain-write-timeout-ambiguous-outcome-2026-04-22.md` — directly relevant shared context. That doc established `handleBroadcastError` and named the same call sites (`accreditation.ts`, `orcid.ts`, `papers.ts`, `claims.ts`). This doc documents a *second* failure mode introduced when migrating `accreditation.ts` to use that helper. The reader encountering one should be directed to the other; future broadcast-helper extensions should consider both axes (idempotency on ambiguous outcomes AND ordering parity on cleanup failure).

- `agents/docs/solutions/conventions/timing-equalization-smtp-failure-mode-oracle-2026-04-22.md` — structural parallel on partial-execution error collapse. SMTP `sendMail` fails after a token is written → the 500 leaks "email exists." Helper cleanup fails after response is written → Express 5 emits a 500 against an already-written response. Same shape (side effect after primary operation, failure on side effect creates observable symptom), different domain, different mitigation.

- `agents/docs/solutions/conventions/object-shape-fix-every-reset-site-2026-04-21.md` — the "fix covered the reported site but not sibling sites" meta-pattern. Other migration sites (`orcid.ts`, `papers.ts`, `claims.ts`) don't trigger this regression because they lack post-response cleanup, but the doc above notes them and explains why they're safe — preserving the audit trail.

- Task `backend-handle-broadcast-error-helper.md`: the HELD PENDING FIXES block on that task captures the round-2 fix landing this remediation, alongside the implementer's fix-application notes.

- `agents/docs/solutions/runtime-errors/constructor-throw-in-settimeout-escapes-as-uncaught-exception-2026-05-01.md` — **third failure mode in the same `BroadcastTimeoutError` / `handleBroadcastError` / `accreditation.ts` cluster.** Round-4 of `BACKEND-HANDLE-BROADCAST-ERROR-HELPER` added a constructor-time guard on `BroadcastTimeoutError`'s `timeoutMs` parameter. The class is only thrown from inside a `setTimeout(() => reject(new BroadcastTimeoutError(...)))` callback, so a synchronous throw from the constructor escapes as Node `uncaughtException` rather than reaching `Promise.race`'s timeout half — single-process worker dies. Round-5 fix moved the guard to the wrapper entry. Same cluster, different mechanism (timer-callback throw escape vs. post-response cleanup throw); same root structural lesson — when a throw escapes the frame the author thought was catching it, the failure mode is invisible until reviewed against the call frame, not the construction location.
