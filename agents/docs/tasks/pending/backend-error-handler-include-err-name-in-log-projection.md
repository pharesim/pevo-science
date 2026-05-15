# BACKEND-ERROR-HANDLER-INCLUDE-ERR-NAME-IN-LOG-PROJECTION — project `err.name` / `constructor.name` in errorHandler log payload

**Owner:** Backend Agent
**Created:** 2026-05-07 (filed at architect review of `backend-bridge-key-lazy-fallback-throw-site-closure.md`, reliability finding R1)
**Priority:** P2

## Problem

`backend/src/middleware/errorHandler.ts:11` constructs the log payload as a plain object:

```ts
logger.error({ err: { message: err.message, stack: err.stack } }, 'Unhandled error');
```

The `err` field is a plain object, NOT the actual `Error` instance. Consequences:

- pino's `serializers.err` (which projects `err.constructor.name` as `type`) sees `{ message, stack }` whose `constructor.name` is `'Object'`. The redact serializer's `type` projection collapses to `'Object'` for every error reaching this handler.
- `err.name` (the per-instance class-name property set by every custom Error subclass) is dropped entirely.
- Operator dashboards / log queries that key on `err.type === 'BridgeKeyLazyParseDivergence'` (or any other custom Error class name) cannot distinguish between error classes on the errorHandler path.

The project has multiple custom Error subclasses whose JSDoc explicitly cites operator-dashboard / log-grep distinguishability via `err.type` or `err.name`:

- `BridgeKeyCacheUnpopulated` (existing).
- `BridgeKeyLazyParseDivergence` (introduced in `backend-bridge-key-lazy-fallback-throw-site-closure`, commit `6f47a22` — its docstring says: *"Operator dashboards / log queries can key on `err.type === 'BridgeKeyLazyParseDivergence'` to distinguish from `BridgeKeyCacheUnpopulated`"*. That claim is FALSE on the errorHandler path today.)
- `BootFatalError`, `BroadcastTimeoutError`, plus any future custom Error class.

The earlier `claims-route-migration round-1` review surfaced this as P3 wrong-but-survivable and explicitly named THIS task slug as the load-bearing-trigger filing: *"If this becomes load-bearing in operator workflows, file `backend-error-handler-include-err-name-in-log-projection`."* The lazy-fallback task's introduction of a new sibling class made it load-bearing.

## Goal

Project `err.name` (and ideally also `constructor.name` via pino's serializer) in the errorHandler log payload so that custom Error subclass identity flows through to operator dashboards.

## Acceptance

1. **Migrate `errorHandler.ts:11` log projection.** Choose one of two paths; document the choice in the implementation:

   - **Path A (minimal).** Add `name: err.name` to the projection: `{ name: err.name, message: err.message, stack: err.stack }`. Cheap; preserves the rest of the projection unchanged. Operator dashboards key on `err.name`. Does NOT depend on pino's serializer wiring.

   - **Path B (idiomatic pino).** Pass the real Error instance to pino's `err` slot — `logger.error({ err }, 'Unhandled error')` — and let `redactErrSerializer` (project's pino err serializer) produce the canonical `{ type, message, stack, ... }` shape. Trades plain-object simplicity for serializer-driven projection, which already strips Buffer-derived material per the redact policy. Path B requires verifying `redactErrSerializer` is wired into the pino instance used by errorHandler; if it isn't, Path A is the safer immediate fix.

   Architect's mild preference: **Path A** if the redact-serializer wiring needs investigation (avoids a discovery sub-task); **Path B** if it's already wired (cleaner, single-source-of-truth for error-shape projection).

2. **Add a test.** No `errorHandler`-specific test file exists today (per finding from `error-envelope-helper-sweep` round-1 review). Add `backend/tests/middleware/errorHandler.test.ts` (or co-located in an existing test file if conventions prefer):

   - Construct a custom Error subclass (e.g., test-local `class TestError extends Error { constructor() { super('test message'); this.name = 'TestError'; } }`).
   - Throw it from a stub Express middleware mounted before `errorHandler`.
   - Spy on `logger.error` via `vi.spyOn(logger, 'error')` (project carve-out permits logger spies as observability surface).
   - Assert the resulting payload contains `{ name: 'TestError' }` (Path A) OR `{ type: 'TestError' }` (Path B).
   - Per `tests-must-fail-on-mutation-of-code-under-test-2026-04-22.md`: revert the projection change, confirm the test fails red, restore.

3. **Verify.** `npx tsc --noEmit` clean. `npm run lint` no new errors. Existing route tests stay green.

4. **Project-wide consistency check (advisory, not blocking):** grep for other `logger.error({ err: { message, stack } }, ...)` patterns in `backend/src/`. If others exist with the same anti-pattern, surface in the round-1 signal block — architect decides whether to widen this task's scope or file a separate sweep.

## Out of scope

- Do not change the HTTP envelope shape; `sendError` adoption is already complete via `error-envelope-helper-sweep` (archived 2026-05-07).
- Do not change the redact serializer itself; verify it's compatible with whichever path you pick.
- Do not migrate non-errorHandler log sites in this task — scoped to the 4-arg Express errorHandler only.
- Do not bundle with `backend-bridge-envelope-shape-reconcile` (sibling task filed at the same review cycle, separate concern: wire-shape vs log-projection).

## Coordination

- Surfaced from architect review of `backend-bridge-key-lazy-fallback-throw-site-closure.md` (commit `6f47a22`), reliability finding R1.
- Coupled with `BridgeKeyLazyParseDivergence`'s docstring distinguishability claim (which currently doesn't hold). Once this task lands, the claim becomes truthful and the maintainability M1 finding from the lazy-fallback review (dismissed as coupled-to-this-task) is fully resolved.
- Project-wide effect: every custom Error subclass in the codebase benefits — `BridgeKeyCacheUnpopulated`, `BridgeKeyLazyParseDivergence`, `BootFatalError`, `BroadcastTimeoutError`, plus any future class.
- No file conflict with concurrent backend tasks; the only file edited (`errorHandler.ts`) is otherwise stable. Coordinate with `error-envelope-helper-sweep` archive (the migrated `sendError(res, 500, 'INTERNAL_ERROR', ...)` call is unchanged by this task; this task only touches the preceding `logger.error({ err: ... })` line).

## Cross-references

- `agents/docs/solutions/conventions/pino-err-slot-sibling-bypass-redact-policy-2026-05-06.md` — keep all error-shaped data on the `err:` slot, not as siblings to it (still applies post-fix).
- `agents/docs/tasks-archive.md` `BACKEND-BRIDGE-KEY-LAZY-FALLBACK-THROW-SITE-CLOSURE` (archived 2026-05-07) — this task's parent surface; reliability R1 is the originating finding.
- `agents/docs/tasks-archive.md` `BACKEND-BRIDGE-KEY-CLAIMS-ROUTE-MIGRATION round-1 dismissals` — the original P3 dismissal that named this task slug as the load-bearing trigger.

## Backend re-review signal (2026-05-07, round-1 implementation — commit `f715b07` on `main`, originally `d447b6f` + `37243ce` on `worktree-agent-ae8c974b3d6ce3c40`)

### Decision: Path A (explicit `name: err.name` projection)

Path A vs Path B was decided by reading `backend/src/logger.ts`:

```ts
export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  ...(process.env.NODE_ENV !== 'production' && {
    transport: { target: 'pino/file', options: { destination: 1 } },
  }),
});
```

No `redactErrSerializer` and no `serializers.err` are wired into the logger instance. A repo-wide grep for `redactErrSerializer` returns zero hits. Passing the raw `Error` to pino's `err` slot would silently inherit pino's default error serializer behavior, which differs from how every other `logger.error({ err: ... }, ...)` call site in `backend/src/` projects (all of them use a hand-rolled object literal). Path A keeps the projection explicit and consistent with neighbors. **Note for the architect:** the task body's premise (paragraph mentioning "pino's `serializers.err` ... sees `{ message, stack }` whose `constructor.name` is `'Object'`") is currently inaccurate — no such serializer is wired today. The fix's value is that it adds `name` to the explicit projection; once the deferred `backend-bridge-key-startup-validation-and-pino-redact` task lands its serializer, the projection here may need a follow-up to convert to Path B.

### Files touched (scope respected, no `git add -A`)

- `backend/src/middleware/errorHandler.ts` — added `name: err.name` to the projected payload + comment block explaining the Path A rationale. **Preserved main's `sendError(res, 500, 'INTERNAL_ERROR', ...)` migration** (the original worker's stale base predated the envelope-helper-sweep, and would have regressed to open-coded `res.status(500).json({...})`; the parent merged manually to keep the canonical envelope).
- `backend/tests/middleware/errorHandler.test.ts` — new file. Stub Express app mounts errorHandler, throws a `class TestError extends Error` with `this.name = 'TestError'`, asserts the spied `logger.error` payload contains `{ err: { name: 'TestError', message: 'test message', stack: <string> } }` and HTTP 500 + the standard error envelope. Test file header documents the test-mock carve-out clauses (a)/(b)/(c) per root CLAUDE.md.
- `agents/docs/tasks/pending/backend-error-handler-include-err-name-in-log-projection.md` — this signal block.

### Mutation-kill verification (per `tests-must-fail-on-mutation-of-code-under-test-2026-04-22`)

1. **Mutation applied:** reverted projection to the pre-fix shape `{ err: { message: err.message, stack: err.stack } }` (dropped `name`).
2. **Test result (red):**
   ```
   FAIL  tests/middleware/errorHandler.test.ts > errorHandler middleware
       > logs the error class name in the structured payload
   AssertionError: expected undefined to be 'TestError' // Object.is equality
   - Expected: "TestError"
   + Received: undefined
   ❯ tests/middleware/errorHandler.test.ts:74:30
        72|     ];
        73|     expect(message).toBe('Unhandled error');
        74|     expect(payload.err.name).toBe('TestError');
          |                              ^
   ```
3. **Restore + re-run (green):**
   ```
   Test Files  1 passed (1)
        Tests  1 passed (1)
   ```

(Verification was performed on the worker's stale-base tree; the parent re-runs targeted vitest after the manual merge and reports below in the parent merge note.)

### Advisory: other call sites that drop `err.name`

`grep -rn "logger.error({ err:" backend/src/`:

| File:line | Current shape | Notes |
|-----------|--------------|-------|
| `backend/src/middleware/errorHandler.ts:11` | `{ err: { message, stack } }` | **Fixed in this commit (worker base; on main now reads `{ name, message, stack }`).** |
| `backend/src/hafsql.ts:435` | `{ err: headErr }` | Passes raw Error to pino — no `name` extracted into a field, but pino's default serializer applies. Mixed convention vs other sites. |
| `backend/src/middleware/verifyHiveSignature.ts:185` | `{ err: (err as Error).message }` | Logs only the message string under `err`. Drops `name` AND `stack`. |
| `backend/src/routes/contact.ts:47` | `{ err: (mailErr as Error).message }` | Same — message-only. |
| `backend/src/routes/settings.ts:165` | `{ err: (mailErr as Error).message }` | Same. |
| `backend/src/routes/accreditation.ts:254` | `{ err: (mailErr as Error).message }` | Same. |
| `backend/src/routes/search.ts:276` | `{ err: (err as Error).message }` | Same. |
| `backend/src/routes/ipfs.ts:223` | `{ err: (pinErr as Error).message }` | Same. |
| `backend/src/routes/ipfs.ts:329` | `{ err: (err as Error).message, cid }` | Same — bonus context (`cid`) preserved. |

**Surfaced for architect triage. Not migrated in this task per scope.** A project-wide convention pass might either (a) introduce a shared `projectError(err: Error)` helper that returns `{ name, message, stack, cause? }`, or (b) wire a custom `serializers.err` into the pino instance in `logger.ts` and switch every site to pass the raw Error. Option (b) is the more idiomatic pino fix and would let those sites lose the explicit cast. Out of scope for this task.

### Parent merge note

Original worker (`worktree-agent-ae8c974b3d6ce3c40`, commits `d447b6f` + `37243ce`) branched from a stale base (`2616cc1`) that predated both the parent's `f73a362` checkpoint AND the `89ec691` error-envelope-helper-sweep. Parent attempted cherry-pick — conflicted on `errorHandler.ts` (worker reintroduced the open-coded `res.status(500).json(...)` regression) and on the task file itself (worker recreated it from scratch). Parent aborted the cherry-pick and re-applied the worker's intent manually onto current main: kept the `sendError` migration intact, added `name: err.name` + Path A comment to the existing log call, copied the test file verbatim, and appended this signal block to the task file already on main.

---

## Architect re-review (2026-05-15) — HELD PENDING FIXES (round 2)

`/ce-code-review` ran on commit `f715b07` with 7 personas (correctness, testing, maintainability, project-standards, learnings, reliability, kieran-typescript). The Path A landing's premise is FALSE at HEAD: the implementer's signal-block claim (lines 79-90 of this file) that "no `redactErrSerializer` and no `serializers.err` are wired into the logger instance" was true at round-1 implementation time but stopped being true when `BACKEND-BRIDGE-KEY-STARTUP-VALIDATION-AND-PINO-REDACT` landed. At HEAD, both layers ARE wired and they actively defeat the Path A plain-object projection.

### Items to address

**1. (P1) Path A is silently defeated in production by the Layer-A wrapper**

- File: `backend/src/middleware/errorHandler.ts:18` + `backend/tests/middleware/errorHandler.test.ts:60`
- Cross-reviewer convergence: correctness (100), maintainability M-1 (100), learnings (high), kieran-typescript RR-1 (high) → anchor 100.
- Verified directly at HEAD:
  - `backend/src/logger.ts:326` wires `serializers.err = safeRedactErr` (Layer B).
  - `backend/src/logger.ts:355-368` defines `redactErrInArg` (Layer A wrapper).
  - `backend/src/logger.ts:417` applies `makeLevelWrapper(baseLogger.error.bind(baseLogger))` so every `logger.error(...)` flows through Layer A first.
- Production trace through `logger.error({err: {name, message, stack}}, 'Unhandled error')`:
  1. `redactErrInArg` mutates `obj.err` via `safeRedactErr({name, message, stack})`.
  2. `redactErrSerializer` checks `isErrorLike({name, message, stack})` → true (both name+message are strings).
  3. `out.type = errAny.constructor?.name || errAny.name || 'Error'` — for a plain object, `({}).constructor === Object` so `Object.name === 'Object'`. `out.type = 'Object'`. The class identity Path A was supposed to preserve is dropped.
  4. `SAFE_BASELINE_FIELDS = ['code', 'errno', 'syscall']` does NOT include `name` → the explicit `name: err.name` field is dropped from the output.
- Production log: `{err: {type: 'Object', message, stack}}`. The whole task's goal (preserve subclass class name in operator dashboards) is silently defeated. Custom Error subclasses (TypeError, BridgeKeyParseError, etc.) all serialize as `type: 'Object'`.
- Test passes only because `vi.spyOn(logger, 'error').mockImplementation(() => undefined)` REPLACES the wrapper LogFn entirely; the spy captures the raw arg before `redactErrInArg` runs. The test does not pin production behavior.
- **Fix:** switch to Path B. Pass the raw Error: `logger.error({ err }, 'Unhandled error')`. Then `redactErrSerializer` projects `out.type = err.constructor?.name = 'TestError'` / `'TypeError'` / `'BridgeKeyParseError'`. The Path A comment block (lines 11-16 of errorHandler.ts) becomes obsolete and should be removed (or replaced with a 1-line note that the raw Error is passed to honor the Layer-A serializer).

**2. (P3) Test cleanup nits — fold into the same rewrite**

- File: `backend/tests/middleware/errorHandler.test.ts:60-69`
- Source: kieran-typescript KT-2 (90) + KT-3 (75).
- The test must be rewritten anyway to match Path B (assert `payload.err.type === 'TestError'` not `name`, and replace `mockImplementation(() => undefined)` with `logger.level = 'silent'` so the wrapper actually runs and the assertion verifies post-serializer shape). While rewriting:
  - Drop the double-cast `() => undefined as unknown as void`. Use `() => {}` (returns undefined implicitly, TS accepts as `() => void`).
  - Replace the `mock.calls[0] as [...]` cast with `expect(errorSpy).toHaveBeenCalledWith(expect.objectContaining({err: expect.objectContaining({type: 'TestError', message: 'test message'})}), 'Unhandled error')`. Idiomatic, no cast, better failure message.
- These are cleanup, not blockers; they're called out so the rewrite for item 1 absorbs them.

### Items dismissed during architect triage (do NOT address)

- **`{err: {message: err.message}}` plaintext-message-only sites flagged in advisory table at lines 122-138** (verifyHiveSignature.ts:185, contact.ts:47, settings.ts:165, accreditation.ts:254, search.ts:276, ipfs.ts:223,329) — out of THIS task's scope; surfaces a class-wide gap better tackled as a sweep follow-up, not folded into this task.
- **Plain-Error name-flow gap (testing residual risk)** — theoretical-only; production code reads `err.name` unconditionally; preemptive hardening per memory feedback_dismiss_preemptive_test_hardening.
- **Custom Error subclass `this.name` audit (reliability RR-2)** — confirmed all 8 subclasses already set `this.name` correctly; advisory only.

### Re-review signal

When items 1 + 2 land, `git mv` this file from `tasks/pending/` back to `tasks/review/`. The move itself is the re-review signal.
