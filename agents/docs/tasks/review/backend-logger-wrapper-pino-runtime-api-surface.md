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

## Architect decision (2026-05-11) — child-wrapping = **option 2 (documentary)**

Parent task `backend-bridge-key-startup-validation-and-pino-redact.md` archived 2026-05-11 (round-6 clean ✓). The wrapper structure is settled: `makeLevelWrapper(method: LogFn): LogFn` factory + in-place `redactErrInArg` mutation + Layer-B `safeRedactErr` in pino's `serializers.err` config + the wrapper's `redactPlainObject` + depth/cycle guard + try/catch fallback. No further file-conflict risk on `backend/src/logger.ts`; this task is free to proceed.

**Decision on the open question:** go with **option 2 (documentary, accept the unwrapped child)**. Rationale:

1. **PEvO has no `.child(...)` call sites today** — and the project memory `project_single_instance_only` (single-instance forever) plus the broader "no premature complexity" stance argue against adding a recursive-wrapping factory for a hypothetical future requirement.
2. **Layer-B (transport `serializers.err`) still fires on children.** Children inherit the parent pino instance's `serializers` config; the known-leaky-field-by-subclass redact policy applies to ANY pino call through `baseLogger` or its descendants. The security defense is intact regardless of child-wrapping shape.
3. **Layer-A spy-visibility is the only thing children "skip."** That matters for `vi.spyOn(logger, 'warn').mock.calls` test discipline — but no PEvO test currently spies on a child logger (there are no children to spy on). If a future call site lands `logger.child(...)`, the implementer can either spy on the child's transport stream directly OR migrate to option 1 at that point — additive change, no breaking refactor.
4. **YAGNI applies.** Three similar lines (forwarding `child` verbatim with a JSDoc warning) is better than a premature recursive-wrapping factory. The cost to switch from option 2 → option 1 if a future call site needs Layer-A on children is ~12 LOC of new factory code, no caller migration.

**JSDoc on the forwarded `child` method MUST name the gap explicitly.** Suggested wording (implementer may adapt while preserving the substantive warning):

```ts
/**
 * Forwards to baseLogger.child(...) verbatim. The returned child logger
 * inherits Layer-B redaction (pino's `serializers.err` config — see
 * agents/docs/solutions/conventions/defensive-recursive-serializer-and-
 * pino-err-redact-policy-2026-05-11.md) but does NOT inherit the call-
 * site Layer-A wrapper (`redactErrInArg`). vi.spyOn on a child logger's
 * level methods will see UNREDACTED `err` arguments at call time —
 * redaction fires at write time via the serializer config.
 *
 * If a call site needs Layer-A on a child, migrate this method to wrap
 * the child via a `wrapPinoLogger(baseLogger.child(bindings))` factory
 * (option 1 of the original task). Today's PEvO has no .child callers,
 * so the documentary approach (option 2) is the architect's call per
 * the 2026-05-11 archive of the parent task.
 */
child(bindings: pino.Bindings): pino.Logger { return baseLogger.child(bindings); }
```

The Acceptance section's "for option 2" sub-bullet under tests is the binding one — implement the negative-assertion test that pins the child does NOT redact at the call-site layer (`vi.spyOn(child, 'warn').mock.calls[0][0].err` contains the unredacted shape), so a future inadvertent migration to option 1 fails red until the JSDoc is updated.

Moving back to `tasks/pending/` for backend pickup.

## Architect re-review (2026-05-12) — HELD PENDING FIXES:

`/ce-code-review` on commit 2da0eae (round-2) returned three actionable findings plus one dismissal. Six reviewers dispatched (correctness, testing, maintainability, project-standards, kieran-typescript, reliability); cross-reviewer corroboration on findings 1 and 3.

### 1. Broken negative-assertion ratchet — `backend/tests/lib/logger-wrapper-api.test.ts:111-136`

The 2026-05-11 architect decision named this ratchet as load-bearing: *"a future inadvertent migration to option 1 fails red until the JSDoc is updated."* The test as landed does NOT fire. `vi.spyOn(child, 'warn').mockImplementation(() => {})` replaces `child.warn` entirely with a no-op stub before any wrapper code can run. Under option 2 (today) and under a future option-1 migration, the spy captures the raw input arg identically — `mock.calls[0][0].err.command` is defined in both cases. The assertion passes green in both. (Cross-reviewer: correctness + testing.)

**Fix:** Stop relying on the spy to observe Layer-A's effect. Layer-A mutates `args[0].err` in place (see `redactErrInArg` at `logger.ts:355-368` and its `IMPORTANT — in-place mutation … is INTENTIONAL` docblock); observe that mutation directly via the input object reference. The in-place mutation contract is itself the observable — no spy needed.

Sketch (adapt to suite style):

```ts
it('child level methods do NOT apply Layer-A redaction (option 2 documentary contract)', () => {
  const child = logger.child({ scope: 'layer-a-gap' });
  const verifyToken = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  const leakyErr = Object.assign(new Error('Redis rejected eval'), {
    name: 'ReplyError',
    command: { name: 'eval', args: ['lua-script-body', '1', `pevotest:probe:${verifyToken}`] },
  });
  const argObj = { err: leakyErr };

  // Silence stdout — child.warn is the real pino method, not a stub.
  const originalLevel = logger.level;
  logger.level = 'silent';
  try {
    child.warn(argObj, 'leaky shape test');
  } finally {
    logger.level = originalLevel;
  }

  // Under option 2 (current), child.warn is the raw pino method — no Layer-A
  // mutation — argObj.err.command stays intact. Under a future option-1 migration
  // that wraps child via wrapPinoLogger(...), redactErrInArg would mutate
  // argObj.err to the SerializedErr shape before pino sees it, dropping
  // command. That mutation flips this assertion red, forcing the JSDoc on
  // logger.child to be updated before the suite re-greens — the intended ratchet.
  expect(argObj.err.command).toBeDefined();
  expect(argObj.err.command?.args).toContain(`pevotest:probe:${verifyToken}`);
});
```

### 2. Task-reference rot in block comment — `backend/src/logger.ts:403-414`

Per root CLAUDE.md ("Doing tasks"): *"Don't reference the current task, fix, or callers … since those belong in the PR description and rot as the codebase evolves."* The block opens with the task slug (`Backend-logger-wrapper-pino-runtime-api-surface`) and the architect date stamp (`architect 2026-05-11`); both decay when the task file is `git rm`d on archive (rule #7). The substantive content (option 2, Layer-A gap, migration path) is already verbatim in the JSDoc on `child` immediately below — the block adds no information, only decay surface.

**Fix:** Delete lines 403-414 entirely. The JSDoc on `child` (lines 442-456 of the as-landed file) is the load-bearing rationale and survives.

### 3. `child()` wrapper drops pino's `options` parameter — `backend/src/logger.ts:423,457`

Pino's actual `Logger.child` signature is `child(bindings, options?: pino.ChildLoggerOptions): pino.Logger`. The wrapper exposes only the first parameter, so a future caller using `logger.child({reqId}, {level: 'debug'})` gets a TS error at the call site — not at the wrapper — and may widen the signature without reading the Layer-A JSDoc context. The original Goal of this task ("Make the wrapper a strict superset of baseLogger's public interface") covers this in scope. (Cross-reviewer: correctness + kieran-typescript + testing.)

**Fix:**

- Update the type annotation at line 423: `child: (bindings: pino.Bindings, options?: pino.ChildLoggerOptions) => pino.Logger`
- Update the method body at line 457:
  ```ts
  child(bindings: pino.Bindings, options?: pino.ChildLoggerOptions): pino.Logger {
    return baseLogger.child(bindings, options);
  }
  ```
- Add a coverage test that verifies options are actually forwarded (so a future signature regression that silently drops the second arg again fails red):
  ```ts
  it('forwards options to baseLogger.child — level override survives', () => {
    logger.level = 'info';
    const child = logger.child({}, { level: 'debug' });
    expect(child.isLevelEnabled('debug')).toBe(true);  // child-level override wins
  });
  ```

### Dismissed (recorded for completeness)

- **P3 advisory: `level` setter has no guard against pino's throw on unknown level (`logger.ts:471`).** Pino's `Error('unknown level <X>')` is the correct contract — wrapping it at the wrapper layer would mask invalid input from a legitimate caller. PEvO has no dynamic-level call site today; a future admin/config-driven setter is responsible for input validation at its own layer. Not worth a comment, test, or guard now.

### Pre-existing, not blocking

- `flush` callback type `(cb?: (err?: Error | null) => void) => void` is wider than pino's declared `(cb?: (err?: Error) => void)`. Surface inaccuracy only; callback-parameter contravariance makes it safe at compile time and runtime. Predates this task. Optional cleanup if the implementer touches the type annotation for finding 3 anyway; otherwise leave for a future round.

---

Round-2 hold. Implementer lands the three fixes above; `git mv`s back to `tasks/review/` per rule #8 (the move itself is the re-review signal).
