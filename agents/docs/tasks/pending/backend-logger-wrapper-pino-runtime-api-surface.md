# BACKEND-LOGGER-WRAPPER-PINO-RUNTIME-API-SURFACE — Restore pino runtime API surface lost in the redact wrapper

**Owner:** Backend Agent
**Created:** 2026-05-06 (architect, surfaced by `/ce-code-review` triage on `backend-bridge-key-startup-validation-and-pino-redact`)
**Priority:** P2 (future-bug magnet; not blocking)

## Why now

The wave-2 wrapper landed at `backend/src/logger.ts:218-244` exports a hand-built object with only `info` / `warn` / `error` / `debug` / `fatal` / `trace` / `flush`. Pino's actual runtime surface includes:

- `.child(bindings)` — for scoped child loggers (request-id binding, user-id binding)
- `.isLevelEnabled(level)` — for cheap-skip guards before constructing expensive log payloads
- `.level` — runtime log-level adjustment (read/write)
- `.bindings()` — introspect the current binding set

None of these are forwarded by the wrapper. No PEvO call site uses them today, so the gap is invisible in CI. But:

- Future code calling `logger.child({reqId})` for request-scoped logging would `TypeError: logger.child is not a function`.
- Future code using `if (logger.isLevelEnabled('debug')) { logger.debug({heavy: computeHeavy()}, 'msg') }` for the cheap-skip optimization silently breaks the cheap-skip path.
- A copy-paste from any pino documentation example drops dead.

Reliability reviewer surfaced this in the parent task's `/ce-code-review` pass at confidence 75 as a future-bug surface.

## Goal

Make the wrapper a strict superset of `baseLogger`'s public interface — every method/property an end-consumer of pino expects is forwarded.

## Open question — child-wrapping decision

`logger.child(bindings)` returns a NEW pino logger that does NOT have the wrapper's call-site `redactErrInArg` applied to its level methods. Two viable shapes:

1. **Apply the wrapper recursively.** Define a `wrapPinoLogger(p)` factory that produces a wrapped instance for any pino logger, including children. `logger.child(bindings)` returns `wrapPinoLogger(baseLogger.child(bindings))`. Children inherit redaction at the call-site layer too. ~15 lines added; recursive-wrapping factory pattern.
2. **Document and accept the unwrapped child.** Children skip Layer-A redaction but Layer-B `serializers.err` still applies (children inherit pino config). Suitable iff no PEvO call site logs raw err objects through children. ~3 lines (just forward `child` verbatim) plus a clear JSDoc warning.

Option 1 is the architecturally cleanest but adds a recursive-wrapping factory pattern. Option 2 is documentary-only and matches today's usage (no PEvO code calls `logger.child` yet). **Decide before implementing — the choice shapes the wrapper's structure.**

The child-wrapping question is the reason this task is decoupled from the parent's hold cycle — the parent's hold round is already touching the wrapper for findings 4, 5, 6 (cycle/depth guard, throw-safety, LogFn overload preservation), and adding the child-wrapping deliberation on top would inflate it. Land this as a follow-up after the parent's hold round closes so the wrapper's structure is settled first.

## Acceptance

- `logger` exports `child` / `isLevelEnabled` / `level` (getter/setter) / `bindings`, all forwarding to `baseLogger`.
- The child-wrapping decision is recorded in a JSDoc on the wrapper's `child` method and (if option 1) implemented in a `wrapPinoLogger` factory.
- A test in `backend/tests/lib/logger-redact.test.ts` (or a sibling new file, e.g. `logger-wrapper-api.test.ts`) verifies each forwarded method behaves identically to `baseLogger`'s direct method:
  - `logger.isLevelEnabled('debug')` matches `baseLogger.isLevelEnabled('debug')` after `logger.level = 'info'`.
  - `logger.level = 'debug'; expect(logger.level).toBe('debug')`.
  - `logger.bindings()` returns the bindings object pino exposes.
  - For option 1: a child logger returned via `logger.child({reqId: 'x'})` redacts err shapes the same way the root wrapper does.
  - For option 2: a child logger returned via `logger.child({reqId: 'x'})` does NOT redact err shapes at the call-site layer (Layer-B still strips known-leaky fields at write time).

## Out of scope

- Other pino features (transports, hooks, mixin) — only the runtime methods that callers reach via the public `logger` export.
- Restructuring the redact policy itself or its allowlist.
- Re-touching the parent task's wrapper structure beyond adding the missing methods.

## Dependencies

- Best landed AFTER the parent `backend-bridge-key-startup-validation-and-pino-redact` hold round closes, since that round re-touches the same wrapper code (parent hold items 3, 4, 5 — cycle/depth guard, throw-safety, LogFn overloads).
