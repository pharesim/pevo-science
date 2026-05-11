---
title: "Boot-fatal call-stack-unwind via subclassed throw + outer catch — and the catch-rethrow re-entry trap"
date: 2026-05-11
category: conventions
module: backend/src/index.ts
problem_type: convention
component: authentication
severity: high
applies_when:
  - "A boot-fatal site (validateConfig, initSecretCache, initDbPool, any sync boot step) needs to abort the process AND prevent post-validate boot code (createApp, migrations, listen) from running"
  - "Existing code uses `logger.fatal(...); flushAndExit(); return;` synchronously — that pattern lets module-evaluation continue during the async flush window"
  - "A boot try/catch is being introduced and the implementer is considering `throw err;` at the end of the catch"
  - "`process.on('uncaughtException')` and `process.on('unhandledRejection')` handlers already exist and call `flushAndExit()` unconditionally — re-throws from inner catches will re-enter them"
  - "Migrating from CJS to ESM module-evaluation semantics (top-level await, etc.) where module-scope `return` is or isn't available"
tags:
  - boot-fatal
  - call-stack-unwind
  - error-subclass
  - uncaughtException
  - definite-assignment
  - catch-rethrow-trap
---

# Boot-fatal call-stack-unwind via subclassed throw + outer catch — and the catch-rethrow re-entry trap

## Context

`BACKEND-BRIDGE-KEY-STARTUP-VALIDATION-AND-PINO-REDACT` rounds 3-5 closed three sequential failure modes around boot-fatal exit semantics:

**Round-3 failure:** `validateConfig()` and `initBridgePostingKeyCache()` called `logger.fatal(...); logger.flush(() => process.exit(1)); return;` on the missing-required and parse-divergence paths. The `return` propagated synchronously to module-evaluation, so `createApp()` and `initAppDb()` (database migrations!) ran during the async flush window on a fatal-misconfigured boot.

**Round-4 fix:** introduced `BootFatalError` subclass; the boot-fatal sites THROW instead of `return`. An outer try/catch at module-evaluation scope (around `validateConfig()` + `createApp()`) catches the throw BEFORE any post-validate boot code runs. The catch routes through `flushAndExit()` (the watchdog-protected exit; see separate compound entry). `instanceof BootFatalError` suppresses redundant fatal logging — the boot-fatal sites already logged before throwing.

**Round-5 failure:** the round-4 catch ended with `throw err;` to propagate the BootFatalError out of the boot try/catch so the rest of module-evaluation would skip. But `throw err;` at module-evaluation scope routes to Node's `process.on('uncaughtException')` handler — which unconditionally logged `'Uncaught exception — shutting down'` AND called `flushAndExit()` AGAIN. Two timers, two flush calls, duplicate fatal log line. The `instanceof BootFatalError` suppress-re-log guard at the inner catch was contractually nullified.

**Round-5 fix:** drop the `throw err;`. Replace with definite-assignment narrowing on `app` (`let app: ReturnType<typeof createApp> | undefined`) and a positive-guard `if (app) { ... }` block that wraps all post-validate boot orchestration.

This entry documents both the success shape AND the failure-mode trap. Future implementers MUST learn both halves — otherwise they re-derive only the throw-from-validateConfig half and re-introduce the catch-rethrow defect at the next module boundary.

## Guidance

### The success pattern (4 pieces)

#### 1. Subclassed `BootFatalError`

```ts
// backend/src/startup-checks.ts
export class BootFatalError extends Error {
  readonly type = 'BootFatalError';
}
```

- `extends Error` so `instanceof` works.
- `readonly type` field with stable string value. This is what survives the `redactErrSerializer` policy (the project-wide convention; see related compound entry on the defensive recursive serializer).
- The string `'BootFatalError'` is what operator alerting keys on. Never rename in a refactor without coordinating with the alerting layer.

#### 2. Boot-fatal sites THROW the subclass after logging

```ts
// backend/src/startup-checks.ts
export function validateConfig(): void {
  if (/* required config missing */) {
    logger.fatal({ /* op-actionable context */ }, 'Required config missing — boot aborting');
    throw new BootFatalError('validateConfig: required configuration missing');
  }
}

export function initBridgePostingKeyCache(): void {
  const parsed = PrivateKey.fromString(config.pevoBridgePostingKey);
  if (parsed.toString() !== config.pevoBridgePostingKey) {
    logger.fatal({ /* op context */ }, 'Bridge posting key parse-divergence — boot aborting');
    throw new BootFatalError('initBridgePostingKeyCache: parse-divergence');
  }
  // ...
}
```

The boot-fatal site is responsible for ALL of:
- Producing the human-readable fatal log (the operator's signal).
- Producing the structured throw (the call-stack-unwind signal to the outer catch).

The outer catch does NOT re-log the same content — the `instanceof BootFatalError` guard suppresses redundant logging.

#### 3. Outer try/catch at module-evaluation scope

```ts
// backend/src/index.ts (module-evaluation scope; NOT inside a function)
// CONSTRAINT: validateConfig and createApp MUST remain synchronous and at
// module-evaluation scope. Introducing await or moving these into a .then
// chain would route BootFatalError to the wrong handler.
let app: ReturnType<typeof createApp> | undefined;
try {
  validateConfig();
  app = createApp();
} catch (err) {
  if (!(err instanceof BootFatalError)) {
    logger.fatal({ err }, 'Boot failed — unexpected throw during startup');
  }
  flushAndExit();
}
```

Three properties:
- **Module-evaluation scope** (not inside `async function main()` or `initAppDb().then(...)`) so the synchronous throw unwinds the stack before ANY post-validate boot code runs.
- **Synchronous** — no `await`, no `.then()` — because the unwind has to happen synchronously to beat the next statement.
- **Suppress-re-log on the subclass** so the operator sees ONE fatal line, not the boot site's fatal + an "Uncaught exception" duplicate.
- **No `throw err;` at the end of the catch.** This is the round-5 trap; see the next section.

#### 4. Positive-guard post-try block (instead of `if (!app) return;`)

```ts
if (app) {
  const bootedApp = app;
  initAppDb()
    .then(/* warm caches, then app.listen */)
    .catch((err) => {
      logger.fatal({ err }, 'Failed to initialize app database');
      flushAndExit();
    });
}
```

- `if (app) { ... }` wraps ALL post-validate boot orchestration (DB init, cache warmups, listen, background jobs/schedulers/drainers).
- `const bootedApp = app;` gives TypeScript a definite-assigned narrowed reference inside the block. The `app.listen(...)` reference becomes `bootedApp.listen(...)` to satisfy strict null checks.
- The closing brace is its own structural signal — no trailing `// end if (app)` comment needed; indent the block body so the structure is visually self-evident.
- **WHY positive guard and not `if (!app) return;`:** module-evaluation scope cannot use `return` in CJS-style modules without wrapping in `(async () => { ... })()`. In ESM with top-level await, `return` at module scope is a syntax error. The positive `if (app)` block achieves identical runtime behavior in both module styles.

### The catch-rethrow re-entry trap (failure mode the success pattern MUST guard against)

```ts
// ❌ WRONG — the round-5 anti-pattern
try {
  validateConfig();
  app = createApp();
} catch (err) {
  if (!(err instanceof BootFatalError)) {
    logger.fatal({ err }, 'Boot failed — unexpected throw');
  }
  flushAndExit();
  throw err;   // ← THIS LINE IS THE TRAP
}
```

What goes wrong:
1. `validateConfig()` throws `BootFatalError` after logging its own fatal.
2. Catch catches it. `instanceof BootFatalError` guards correctly suppress the re-log.
3. `flushAndExit()` starts: 2s watchdog timer + `logger.flush(cb)` race.
4. `throw err;` propagates the BootFatalError to MODULE-EVALUATION scope (no enclosing try left to catch it).
5. Node routes the unhandled module-evaluation throw to `process.on('uncaughtException')`.
6. That handler unconditionally calls `logger.fatal({err}, 'Uncaught exception — shutting down')`. **The `instanceof` guard at the inner catch did NOT propagate; the runtime handler doesn't know this err was already-logged.**
7. The handler calls `flushAndExit()` AGAIN. Two timers, two flush callbacks, double `process.exit(1)`.

Symptoms in operator logs:
- The boot-fatal site's fatal line (correct, single).
- The synthetic `'Uncaught exception — shutting down'` fatal (duplicate, with the same err).
- Two flush attempts; one of them races the watchdog.
- `process.exit` is idempotent so the process eventually exits with code 1. But the operator sees a CONFUSED log stream that wrongly suggests the boot-fatal was caused by an uncaught exception of unknown origin.

The trap is subtle because:
- The `throw err;` line LOOKS like it's preventing post-validate boot code from running (the implementer's stated goal).
- The `instanceof BootFatalError` guard IS correct AT THE INNER CATCH.
- The pattern looks "TypeScript-friendly" if you're using a try/catch + re-throw to satisfy definite-assignment.

### How the positive-guard fix prevents the trap

```ts
// ✓ RIGHT — drop the throw, use definite-assignment narrowing
let app: ReturnType<typeof createApp> | undefined;
try {
  validateConfig();
  app = createApp();
} catch (err) {
  if (!(err instanceof BootFatalError)) {
    logger.fatal({ err }, 'Boot failed — unexpected throw');
  }
  flushAndExit();
  // ← no throw; let control fall through
}

if (app) {
  // ... rest of boot
}
```

- Catch completes without re-throwing. Control falls through to the post-try `if (app)` check.
- `app` is `undefined` because `app = createApp()` never ran (the throw happened before the assignment).
- `if (app)` is false → the rest of boot is skipped.
- `flushAndExit()` from the catch is the SOLE exit path. The 2s watchdog ensures process.exit(1) fires.

No `uncaughtException` re-entry, no duplicate fatal log, no double `flushAndExit`.

## Why This Matters

- **Single-instance availability:** PEvO runs one process. A clear, single fatal log is the difference between a 1-minute operator response and a 15-minute investigation chasing the spurious "Uncaught exception" message.
- **Operator alert reliability:** Alerts keyed on `event.err.type === 'BootFatalError'` correctly identify the failure class. Alerts keyed on the synthetic `'Uncaught exception — shutting down'` message page on an EFFECT, not the CAUSE.
- **Test-suite reliability:** if tests mock `process.exit` to throw a sentinel and call the boot code via `await import('../src/index.js')`, the catch-rethrow trap surfaces as a duplicate-exit test failure that's hard to diagnose.
- **Refactor-safety:** the CONSTRAINT comment above the boot try/catch (the round-5 hold #7 guardrail) prevents a future maintainer from converting the synchronous boot try/catch into an async chain — which would route `BootFatalError` to `initAppDb().catch(...)` and log it as `'Failed to initialize app database'`, defeating the whole pattern.

## When to Apply

- ANY boot-fatal site that must prevent post-validate boot code from running.
- ANY refactor that introduces a new boot-time async-init step (e.g., `initOrcidPool`) — the new step must throw `BootFatalError` to participate in the same outer-catch fallthrough.
- ANY new error subclass used at boot scope where re-throwing past the immediate catch would re-enter `uncaughtException`.

Do NOT apply to:
- Per-request error handling. Routes have their own express/middleware error path; this pattern is exclusively boot-fatal.
- Graceful-shutdown paths. SIGTERM/SIGINT have their own drain protocol with `process.exit(0)`.
- Test fixtures that throw deliberately to assert boot semantics — those should `await expect(import('../src/index.js')).rejects.toThrow(BootFatalError)` rather than running the catch.

## Examples

### Before (round-4 — the catch-rethrow anti-pattern)

```ts
let app: ReturnType<typeof createApp>;
try {
  validateConfig();
  app = createApp();
} catch (err) {
  if (!(err instanceof BootFatalError)) {
    logger.fatal({ err }, 'Boot failed — unexpected throw');
  }
  flushAndExit();
  throw err;  // ← re-enters uncaughtException
}
```

### After (round-5 canonical — definite-assignment narrowing + positive guard)

```ts
let app: ReturnType<typeof createApp> | undefined;
try {
  validateConfig();
  app = createApp();
} catch (err) {
  if (!(err instanceof BootFatalError)) {
    logger.fatal({ err }, 'Boot failed — unexpected throw during startup');
  }
  flushAndExit();
}

if (app) {
  const bootedApp = app;
  initAppDb()
    .then(async () => {
      // warm caches, register watchers, then:
      server = bootedApp.listen(config.port, () => { /* post-listen jobs */ });
    })
    .catch((err) => {
      logger.fatal({ err }, 'Failed to initialize app database');
      flushAndExit();
    });
}
```

### Unit-test pattern for the BootFatalError throw contract

```ts
// backend/tests/startup-checks.test.ts
import { validateConfig, BootFatalError } from '../src/startup-checks.js';

it('validateConfig throws BootFatalError when required env is missing', () => {
  // ... arrange env so a required field is missing
  expect(() => validateConfig()).toThrow(BootFatalError);
  // ... assert the message contains an operator-grep-friendly token
});
```

Reverting `throw new BootFatalError(...)` to bare `return;` breaks the test. Reverting to `throw new Error(...)` (string-typed, no subclass) breaks the `instanceof` assertion. Both mutations are killed by the canary.

## Related

- `agents/docs/solutions/conventions/validate-once-cache-secret-pattern-2026-05-11.md` — the secret-cache pattern that USES `BootFatalError` for its parse-divergence path.
- `agents/docs/solutions/conventions/boot-fatal-flush-watchdog-pattern-2026-05-11.md` — `flushAndExit()` is the exit primitive this pattern routes through.
- `agents/docs/solutions/conventions/defensive-recursive-serializer-and-pino-err-redact-policy-2026-05-11.md` — the redact policy that preserves `BootFatalError.type` through serialization for operator alerting.
- `backend/src/startup-checks.ts` — `BootFatalError`, `validateConfig`, `initBridgePostingKeyCache`.
- `backend/src/index.ts` — the boot try/catch + positive-guard `if (app)` block (lines 60-90).
- `agents/docs/tasks-archive.md` — `BACKEND-BRIDGE-KEY-STARTUP-VALIDATION-AND-PINO-REDACT` archive: round-3 introduced the `return`-after-flush defect; round-4 introduced the structured-throw success pattern AND the catch-rethrow re-entry trap; round-5 closed the trap via definite-assignment narrowing.
