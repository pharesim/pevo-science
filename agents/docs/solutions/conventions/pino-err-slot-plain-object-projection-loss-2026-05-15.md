---
title: Pass real Error objects in the err slot — plain-object projections lose class identity to type='Object'
date: 2026-05-15
category: conventions
module: backend
problem_type: convention
component: logging
severity: high
applies_when:
  - Logging an Error subclass (TypeError, BridgeKeyParseError, BootFatal, etc.) where class identity must reach operator dashboards
  - Constructing a logger.error / logger.warn call where the err slot value is an object literal with name/message/stack fields
  - Wrapping or "cleaning" an error before logging by extracting its fields into a plain object
  - Writing or reviewing middleware or route error handlers that build their own err payload shape
  - Reviewing tests that assert on err.name or err.type using vi.spyOn(...).mockImplementation(...)
symptoms:
  - Pino log output shows type='Object' instead of the expected Error subclass name
  - Custom Error subclass identity (BridgeKeyParseError, BootFatal, BroadcastTimeoutError, etc.) is absent from structured operator logs
  - Test assertions on err.name pass against vi.spyOn but the field is missing in production log sinks
  - Operator alerts that pattern-match err.type to triage errors by class receive 'Object' for hand-rolled projection sites
related_components:
  - testing_framework
tags:
  - pino
  - log-redaction
  - logger
  - error-serialization
  - err-slot
  - plain-object
  - constructor-name
  - class-identity
  - convention
---

## Problem

PEvO's project-wide pino wrapper at `backend/src/logger.ts` runs a Layer-A serializer (`redactErrInArg` → `safeRedactErr` → `redactErrSerializer`) on every log call's `err` slot before pino sees it. The serializer's `isErrorLike` guard (logger.ts:102-108) is intentionally permissive: it accepts any object whose `name` AND `message` are strings, not just `instanceof Error` instances. That permissiveness exists for defensive reasons — it prevents leaky plain-object causes from bypassing the allowlist — but it silently turns the err-slot into a trap for any caller who hand-rolls a plain-object projection of an Error.

Concrete defect: `backend/src/middleware/errorHandler.ts:18` was written as

```ts
logger.error({ err: { name: err.name, message: err.message, stack: err.stack } }, 'Unhandled error');
```

The intent (a deliberate choice over `logger.error({ err }, ...)`) was to preserve the custom Error subclass class name (`'TypeError'`, `'BridgeKeyParseError'`, `'BootFatal'`) in operator logs by hand-projecting `err.name`. The actual production output is `{ err: { type: 'Object', message: '...', stack: '...' } }`. The class identity the projection was specifically constructed to preserve is silently gone.

## How the projection is silently rewritten

Walk-through against the wrapper at HEAD (verified 2026-05-15 against `backend/src/logger.ts`):

1. `logger.error` is `makeLevelWrapper(baseLogger.error.bind(baseLogger))` (logger.ts:417). Every call goes through Layer A.
2. `redactErrInArg` (logger.ts:355-368) detects the `err` key and calls `safeRedactErr(obj.err)`.
3. `safeRedactErr` delegates to `redactErrSerializer(plainObj, 0)`.
4. `isErrorLike(plainObj)` (logger.ts:102-108) returns **true** for `{name: 'TestError', message: 'x', stack: '...'}`: both `name` and `message` are typeof string. The duck-type check accepts the plain object.
5. The serializer enters its Error body. Line 139 builds `out`:
   ```ts
   const out: SerializedErr = {
     type: errAny.constructor?.name || errAny.name || 'Error',
     message: typeof errAny.message === 'string' ? errAny.message : String(errAny.message ?? ''),
   };
   ```
6. For the plain object literal, `errAny.constructor === Object` and `Object.name === 'Object'` (truthy string). The first branch of the `||` chain wins. `out.type = 'Object'`. The hand-set `name: 'TestError'` field is never read for `type`.
7. The serializer then iterates `SAFE_BASELINE_FIELDS` (logger.ts:74), which is `['code', 'errno', 'syscall']`. It does **not** include `name`. The hand-set `name` field is silently dropped from the output.
8. Production payload: `{ err: { type: 'Object', message, stack } }`. The custom class identity the call site was trying to surface is gone, replaced by the literal string `'Object'`.

## Convention

**Always pass a real Error instance to the `err` slot. Never project an Error into a plain object before logging.**

```ts
// WRONG — hand-rolled projection produces a plain object; serializer sets type='Object'
// and silently drops the name field. Class identity is lost in production logs.
logger.error(
  { err: { name: err.name, message: err.message, stack: err.stack } },
  'Unhandled error',
);

// RIGHT — pass the raw Error; serializer extracts type from constructor.name correctly
logger.error({ err }, 'Unhandled error');
```

For a real Error subclass:

- `isErrorLike(err)` returns true.
- `out.type = err.constructor?.name` resolves to `'TypeError'`, `'BridgeKeyParseError'`, `'BootFatal'`, `'BroadcastTimeoutError'`, etc. — the actual class identity operator dashboards key on.
- `out.message = err.message`, `out.stack = err.stack` (when string), and the `cause` chain is recursively redacted via the same serializer.

The same rule applies to wrapping patterns that construct intermediate plain objects:

```ts
// WRONG — extracting fields from cause defeats the recursive cause traversal
const payload = { name: err.name, message: err.message, cause: { name: err.cause?.name } };
logger.warn({ err: payload }, 'cascading failure');

// RIGHT — let the serializer's recursive cause traversal handle the chain
logger.warn({ err }, 'cascading failure');
```

If additional context fields are needed alongside the error, they live as **sibling scalar fields in the log payload — not inside the err slot**:

```ts
// WRONG — context folded into the err projection destroys both type identity and context legibility
logger.error({ err: { name: err.name, message: err.message, txId, authorAccount } }, 'broadcast failed');

// RIGHT — context at the top level; err is the raw Error
logger.error({ err, txId, authorAccount }, 'broadcast failed');
```

The sibling-field constraint has its own axis: error-shaped values must not appear as sibling top-level keys (e.g., a separate `cause: someError` alongside `err`). That bypass is covered by `pino-err-slot-sibling-bypass-redact-policy-2026-05-06.md`. The present convention governs the shape of the value **inside** the err slot itself.

## Why the trap is invisible at authorship time

Three compounding reasons the failure mode is silent:

1. **The projection looks semantically correct.** It contains the right field names, the right values, and (in the original errorHandler.ts case) an explanatory comment justifying the hand-projection over `{err}`. There is no syntax error, no type error, no runtime warning.

2. **Tests using `mockImplementation` pass vacuously.** The original errorHandler test at `backend/tests/middleware/errorHandler.test.ts:60` used `vi.spyOn(logger, 'error').mockImplementation(() => undefined as unknown as void)`. `mockImplementation` REPLACES the wrapper LogFn entirely, so the spy captures the raw arg at the call site BEFORE `redactErrInArg` runs. The assertion `payload.err.name === 'TestError'` was true — at the call site, the projection literally contained `name: 'TestError'`. In production, where the wrapper actually executes, it was false. See `vi-spyon-mockimplementation-bypasses-function-under-test-2026-05-12.md` for the wrapper-bypass mechanism in general; the present trap is a production-side consequence the bypass concealed.

3. **The serializer's transformation is not loud.** `out.type` going from the intended class name to `'Object'` does not throw, does not warn, does not break any other field. The log record is still well-formed, with the right message and stack. Only the class-identity slot is silently wrong.

The combined effect: a well-intentioned hand-projection lands in main, the test passes mutation-kill (`name` field's removal flips the spy assertion red because the projection literally has `name: 'TestError'`), and the production failure is only detectable by reading actual production log output.

## When this rule applies

- Any `logger.*` call site where the `err` slot value is constructed with object literal syntax (`{ name: ..., message: ..., stack: ... }`) rather than passing a live Error reference directly.
- Any call site that extracts fields from an Error to construct a "safe" or "projected" version before logging — including patterns referencing `err.name`, `err.message`, or `err.stack` in the log argument.
- Any cascade-error handler that wraps an inner error into a plain object before logging rather than wrapping it in a real Error subclass with `.cause` assignment.
- Any test that uses `vi.spyOn(logger, 'error').mockImplementation(...)` and asserts on `err.name` or `err.type`. The assertion tests call-site shape, not production-effective shape, and cannot catch this defect class. See cross-references for the wrapper-bypass mechanism and the revert-verify discipline that should catch it.

Does **not** apply to passing a real Error subclass directly: `logger.error({ err }, ...)` where `err` is an `Error` instance is the correct form and needs no change.

## Examples

**Pattern 1: errorHandler projection (the original defect site)**

```ts
// BEFORE — backend/src/middleware/errorHandler.ts (defect)
// Intent: preserve err.name (e.g. 'BridgeKeyParseError') in the log output.
// Actual production output: { err: { type: 'Object', message: '...', stack: '...' } }
// err.name is dropped (not in SAFE_BASELINE_FIELDS); type is 'Object' from constructor.name.
logger.error(
  { err: { name: err.name, message: err.message, stack: err.stack } },
  'Unhandled error',
);

// AFTER — pass the raw Error; serializer sets type = err.constructor.name correctly
logger.error({ err }, 'Unhandled error');
```

**Pattern 2: spy assertion that pins production-effective shape (not call-site shape)**

```ts
// WRONG — mockImplementation replaces the wrapper; the spy sees the raw projection at the call site,
// not the post-serializer output. err.name === 'TestError' here is true regardless of whether the
// production code is correct.
vi.spyOn(logger, 'error').mockImplementation(() => undefined as unknown as void);
errorHandler(testErr, req, res, next);
// later: expect(payload.err.name).toBe('TestError')  ← passes vacuously

// RIGHT — spy WITHOUT mockImplementation; suppress stdout via logger.level = 'silent'
// so the wrapper actually runs and the spy captures post-serializer output.
const prevLevel = logger.level;
logger.level = 'silent';
const spy = vi.spyOn(logger, 'error');
try {
  errorHandler(testErr, req, res, next);
  const [payload] = spy.mock.calls[0] as [{ err: { type: string; message: string } }, string];
  // wrapper ran; serializer ran; check what production actually emits:
  expect(payload.err.type).toBe('TestError');     // constructor.name of the real Error
  expect(payload.err).not.toHaveProperty('name'); // name not in SAFE_BASELINE_FIELDS — dropped
} finally {
  logger.level = prevLevel;
}
```

**Pattern 3: a "cleaning" projection that still loses identity**

```ts
// WRONG — fields are copied to a plain object; class identity lost on the way through the wrapper
const safeErr = {
  name: err.name,
  message: err.message,
  stack: process.env.NODE_ENV === 'development' ? err.stack : undefined,
};
logger.error({ err: safeErr }, 'route handler failed');

// RIGHT — pass the real Error. The wrapper applies the redact policy uniformly;
// the PINO_ERR_REDACT_LEVEL knob controls extras (port/address/hostname/path).
logger.error({ err }, 'route handler failed');
```

## Mutation-kill discipline for affected tests

The defect at errorHandler.ts:18 + errorHandler.test.ts:60 would have been caught by the convention in `tests-must-fail-on-mutation-of-code-under-test-2026-04-22.md` if the revert-verify had been performed against production-effective output (the wrapper running) rather than call-site shape (the wrapper bypassed). Concrete check:

1. Configure the test to use spy-without-mockImplementation + `logger.level = 'silent'` (per Pattern 2 above).
2. Revert the production code to its broken form (e.g., remove the `name: err.name` field from the projection, or revert Path B to Path A).
3. Run the test. It MUST go red. If it stays green, the assertion is testing call-site shape, not production output; the assertion is vacuous and needs to assert on `err.type` (post-serializer) instead.
4. Restore. Re-run. It MUST go green.

A test that asserts on `err.message` only is also vacuous against this trap class — the message survives the serializer regardless of whether the input is a plain object or a real Error. The mutation-killing assertion is on `err.type` (the field the trap silently rewrites).

## Architectural posture

`isErrorLike`'s acceptance of plain objects is correct defensive behavior — see `defensive-recursive-serializer-and-pino-err-redact-policy-2026-05-11.md` for why the duck-type check exists (preventing leaky plain-object causes from bypassing the allowlist). Tightening it to `instanceof Error` only would close this trap but reopen the defensive surface the duck-type check exists to cover. The right boundary is at the call site: pass real Errors, never hand-project them.

The serializer's `out.type = errAny.constructor?.name || errAny.name || 'Error'` line is also correct for its primary purpose (extracting class name from real Errors). Re-ordering to `errAny.name || errAny.constructor?.name` would respect a hand-set `name` field on a plain object but would break the canonical case (real Error subclasses where `constructor.name` and `errAny.name` should both produce the same value, but `constructor.name` is the more reliable source). The fix is at the call site, not the serializer.

## Related

- `agents/docs/solutions/conventions/pino-err-slot-sibling-bypass-redact-policy-2026-05-06.md` — sibling-key axis of the same err-slot discipline. Error-shaped values placed at sibling top-level keys (e.g. `cause: err.cause` alongside `err`) bypass both redact layers. The present doc covers the complementary axis: a non-Error plain object placed inside the err slot is processed by the serializer with the wrong `type` derivation, silently discarding class identity.
- `agents/docs/solutions/conventions/defensive-recursive-serializer-and-pino-err-redact-policy-2026-05-11.md` — documents the serializer's plain-object branch (`redactPlainObject`) and why `isErrorLike` was extended to accept plain objects. The defensiveness that causes the projection trap in the present doc exists to prevent leaky plain-object causes from bypassing the allowlist; the trap is the call-site cost of that defensiveness.
- `agents/docs/solutions/conventions/vi-spyon-mockimplementation-bypasses-function-under-test-2026-05-12.md` — covers the test-side mechanism that concealed this defect: `mockImplementation` replaces the wrapper LogFn, so the spy captures call-site arguments before `redactErrInArg` runs. The present doc covers the production-side trap the bypass concealed; together they explain the full invisibility chain.
- `agents/docs/solutions/conventions/pino-spy-serializer-ordering-trap-2026-05-06.md` — Layer-A vs Layer-B firing order. Foundational context for why call-site projection tests cannot detect serializer-level transformation bugs.
- `agents/docs/solutions/conventions/tests-must-fail-on-mutation-of-code-under-test-2026-04-22.md` — the revert-verify discipline that should have caught this. A test that asserts call-site shape is vacuous against this trap class; only assertions on post-serializer output (Pattern 2 above) are mutation-killing.
- `agents/docs/solutions/conventions/strict-superset-wrapper-inherits-escape-hatches-2026-05-12.md` — same wrapper-can-be-silently-defeated risk class, different axis (child-options forwarding letting a caller install a non-redacting `serializers.err` on a child logger). Both this doc and that one document call-site or API-surface paths that defeat the Layer-A/Layer-B safety contract.
- `agents/docs/solutions/conventions/auth-structured-log-shape-2026-04-29.md` — the canonical structured-log shape says `err? carries the underlying Error (or its .message)`. This doc operationalizes that more precisely: `err? carries the raw Error instance, never a hand-rolled plain object projecting its fields`. The string-only `.message` carve-out remains safe (a string in the err slot does not hit the `isErrorLike` Error branch and is handled by the plain-object branch with the type sentinel).
- `backend/src/logger.ts:74` — `SAFE_BASELINE_FIELDS = ['code', 'errno', 'syscall']`. Explains why an explicit `name` field on a hand-rolled projection is silently dropped from the serializer output.
- `backend/src/logger.ts:102-108` — `isErrorLike`. The duck-type guard whose plain-object acceptance creates the projection trap.
- `backend/src/logger.ts:124-204` — `redactErrSerializer`. The body that sets `out.type = errAny.constructor?.name || errAny.name || 'Error'`, producing `'Object'` for plain-object inputs.
- `backend/src/middleware/errorHandler.ts` — the original defect site. Held in `tasks/pending/backend-error-handler-include-err-name-in-log-projection.md` for round-2 fix to switch to Path B (raw Error).
