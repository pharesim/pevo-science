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
