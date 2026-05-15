---
title: Pino serializers.err runs after vi.spyOn capture — spy-based redaction tests do not verify serializer-level scrubbing
date: 2026-05-06
category: conventions
module: backend
problem_type: convention
component: testing_framework
severity: high
applies_when:
  - Testing pino log redaction via vi.spyOn on logger methods
  - Asserting log payload does not contain sensitive fields using spy.mock.calls
  - Using pino serializers.err (or custom replacements) for transport-level scrubbing
  - Error objects carry sensitive enumerable own properties (ioredis ReplyError, AssertionError, VError)
symptoms:
  - Spy assertions on mock.calls pass even when serializer-level redaction is absent or broken
  - vi.spyOn captures raw unscrubbed error object; test appears to verify redaction but does not
  - serializers.err correctly scrubs transport output but spy sees pre-serializer state
  - Adding or removing serializers.err has no effect on spy-based redaction test outcomes
related_components:
  - authentication
  - service_object
tags:
  - pino
  - vitest
  - vi-spy-on
  - log-redaction
  - serializer
  - test-isolation
  - call-site-wrapper
  - sensitive-data
---

# Pino serializers.err runs after vi.spyOn capture — spy-based redaction tests do not verify serializer-level scrubbing

## Context

PEvO's backend uses pino as its logger, configured in `backend/src/logger.ts` with custom `serializers.err` to strip sensitive fields from error objects before they reach the transport stream. Tests use vitest with `vi.spyOn(logger, 'warn')` to assert that log payloads do not contain secrets such as 64-hex token strings.

The first wave of the project-wide pino-redact policy (commit `23bdae9`) added `serializers: { err: redactErrSerializer }` to the pino config. The serializer correctly strips fields like `err.command.args` (ioredis `ReplyError`, which embeds Redis keys containing tokens), `err.actual` / `err.expected` (Node `AssertionError`, which may carry sensitive Buffer slices), and `err.info` / `err.jse_info` (VError / dhive chain-RPC details). Transport output became clean. Yet tests asserting "log payload must not contain a 64-hex token" via `vi.spyOn` continued to fail red.

The cause is layer ordering. `vi.spyOn(logger, 'warn')` intercepts at the call site — the exact moment `logger.warn({err}, 'message')` is invoked. pino's `serializers.err` fires later, during format-and-write to the destination transport stream. So `loggerWarnSpy.mock.calls[N]` exposes the raw, unredacted `err` object. The serializer never ran yet. An engineer who adds `serializers.err` and then checks the test run will see the suite still red, with no obvious explanation in the stack trace.

## Guidance

Decide where redaction needs to be visible and design for both layers using a shared policy function:

**Rule 1 — call-site redaction (for spy-based tests).** Wrap pino behind a plain object whose methods run `redactErrSerializer` on any `{err, ...}` argument before delegating to the base logger.

```ts
// backend/src/logger.ts
const baseLogger = pino({
  serializers: { err: redactErrSerializer }, // defense-in-depth on transport
});

function redactErrInArg(arg: unknown): unknown {
  if (arg && typeof arg === 'object' && !Array.isArray(arg)) {
    const obj = arg as Record<string, unknown>;
    if ('err' in obj) {
      // In-place mutation is intentional: vi.spyOn captures the argument
      // reference at the wrapper boundary, so a spread-copy (`{...obj, err: redacted}`)
      // would leave the spy holding the ORIGINAL unredacted reference. Overwriting
      // `obj.err` on the same reference makes the redacted form visible to the spy.
      obj.err = redactErrSerializer(obj.err);
    }
  }
  return arg;
}

// Use pino's `LogFn` type directly (NOT `Parameters<typeof baseLogger.warn>`).
// `Parameters<>` reduces an overload set to the LAST overload's tuple — pino's
// LogFn is a 3-overload union (msg-only string, obj+optional-msg, obj+msg+
// placeholders), so a per-level `Parameters<...>` alias collapses to one shape
// and silently loses both the msg-only overload AND `%s`/`%d` placeholder
// type-checking at every call site. A `makeLevelWrapper(method: LogFn): LogFn`
// factory preserves the full overload surface.
function makeLevelWrapper(method: LogFn): LogFn {
  const wrapped: LogFn = ((...args: unknown[]) => {
    if (args.length > 0) {
      args[0] = redactErrInArg(args[0]);
    }
    (method as (...a: unknown[]) => void).apply(baseLogger, args);
  }) as LogFn;
  return wrapped;
}

export const logger = {
  warn:  makeLevelWrapper(baseLogger.warn.bind(baseLogger)),
  error: makeLevelWrapper(baseLogger.error.bind(baseLogger)),
  info:  makeLevelWrapper(baseLogger.info.bind(baseLogger)),
  debug: makeLevelWrapper(baseLogger.debug.bind(baseLogger)),
  fatal: makeLevelWrapper(baseLogger.fatal.bind(baseLogger)),
  trace: makeLevelWrapper(baseLogger.trace.bind(baseLogger)),
  flush: baseLogger.flush.bind(baseLogger),
};
```

**Rule 2 — transport redaction (for log file / aggregation pipeline protection).** Keep `serializers.err` on the base pino config. This is the layer that protects operator log archives, log-shipping pipelines, and third-party SaaS log services. It ALSO catches any direct call to `baseLogger` that bypasses the wrapper (defense-in-depth).

**Rule 3 — single source of truth.** Both layers call the same exported `redactErrSerializer`. Redact-policy changes propagate to both without drift.

**Test-discipline corollary.**

- `vi.spyOn(logger, 'warn')` assertions on `.mock.calls` test **call-site** redaction. They require the wrapper layer (Rule 1).
- Assertions on actual transport stream output test **serializer** redaction. To isolate that layer in a test, inject a mock write stream directly into pino:

```ts
const writeStream = { write: vi.fn(), end: vi.fn() };
const baseLogger = pino({ serializers: { err: redactErrSerializer } }, writeStream);
baseLogger.warn({ err: ioredisError }, 'message');
expect(writeStream.write).toHaveBeenCalledWith(
  expect.not.stringMatching(/[0-9a-f]{64}/),
);
```

| Layer where redaction runs | What `vi.spyOn(logger, 'warn')` sees | What the transport output sees |
|----------------------------|--------------------------------------|---------------------------------|
| pino `serializers.err` only | RAW err (NOT scrubbed) | scrubbed |
| logger-wrapper layer (around `logger.warn`) | scrubbed | scrubbed |
| Both (defense-in-depth) | scrubbed | scrubbed |

## Why This Matters

The failure mode is non-obvious: the code looks correct (serializer is in place), the transport output is clean, but tests still fail. Without knowing the layer boundary, the natural diagnosis is "my serializer logic is wrong" rather than "my serializer runs after the spy's interception point." PEvO's pino-redact work ran an entire wave-1 implementation under this misunderstanding before a project-wide vitest run surfaced it.

There is also a complementary regression risk in the opposite direction. If tests rely only on `vi.spyOn` and the wrapper is present but `serializers.err` is accidentally reverted, the spy-based tests pass green while the transport output leaks sensitive data into log archives. Neither layer alone is sufficient for full confidence; both layers, tested at their own interception point, close the gap.

The threat-model rationale is concrete. Operator logs (aggregation pipelines, archives, log-shipping pipelines, third-party SaaS log services) consume the transport output — pino-side `serializers.err` PROTECTS them. But if a test suite asserts "no leak" using only `vi.spyOn`, it misses the layer where production redaction actually runs and may pass under a regression that reverts the serializer. Conversely, a wrapper-only design without `serializers.err` leaves any direct-`baseLogger` call site (and any future code that bypasses the wrapper) un-redacted at transport.

## When to Apply

- Any TypeScript project using pino with vitest where `vi.spyOn` is used to assert log-payload contents.
- When adding or modifying a pino `serializers.err` implementation and tests remain red despite the serializer appearing correct.
- When designing log-redaction policy: choose wrapper (call-site) vs. serializer (transport) vs. both, based on what each layer's consumers need to see.
- When a regression causes tests to flip unexpectedly — check which layer the test is actually asserting against before concluding the redactor is broken.
- When writing a new test that asserts "log payload does not contain X": pick the right interception point first (spy on logger method for call-site, spy on transport stream's `write` for serializer-level), then write the assertion.

## Examples

**Before (wave-1, broken — pino serializer alone is invisible to the spy):**

```ts
// backend/src/logger.ts
const logger = pino({
  serializers: { err: redactErrSerializer },
});

// In a test:
const loggerWarnSpy = vi.spyOn(logger, 'warn');
// ... trigger an ioredis ReplyError flowing through logger.warn({err}, ...) ...
expect(JSON.stringify(loggerWarnSpy.mock.calls)).not.toMatch(/[0-9a-f]{64}/);
// FAILS RED — spy sees raw err.command.args[0] containing the 64-hex token.
// redactErrSerializer has not run yet; it fires later at transport write time.
```

**After (wave-2, working — wrapper + serializer share the same policy):**

```ts
// backend/src/logger.ts
const baseLogger = pino({
  serializers: { err: redactErrSerializer }, // defense-in-depth on transport
});

function redactErrInArg(arg: unknown): unknown {
  if (arg && typeof arg === 'object' && !Array.isArray(arg)) {
    const obj = arg as Record<string, unknown>;
    if ('err' in obj) {
      obj.err = redactErrSerializer(obj.err); // in-place mutation: spy must see the redacted reference
    }
  }
  return arg;
}

// LogFn factory preserves pino's 3-overload set (msg-only, obj+optional-msg,
// obj+msg+placeholders). Earlier shapes used `Parameters<typeof baseLogger.warn>`
// per-level, which silently collapsed the overloads to one — losing placeholder
// type-checking at every call site.
function makeLevelWrapper(method: LogFn): LogFn {
  const wrapped: LogFn = ((...args: unknown[]) => {
    if (args.length > 0) args[0] = redactErrInArg(args[0]);
    (method as (...a: unknown[]) => void).apply(baseLogger, args);
  }) as LogFn;
  return wrapped;
}

export const logger = {
  warn: makeLevelWrapper(baseLogger.warn.bind(baseLogger)),
  // error, info, debug, fatal, trace — same pattern
};

// Same test assertion now passes:
const loggerWarnSpy = vi.spyOn(logger, 'warn');
// ... trigger the same ReplyError path ...
expect(JSON.stringify(loggerWarnSpy.mock.calls)).not.toMatch(/[0-9a-f]{64}/);
// PASSES — the wrapper ran redactErrSerializer before pino's call site,
// so mock.calls contains the scrubbed object.
```

**Test-fixture discipline.** A negative-regex assertion is only load-bearing if the mock rejection actually carries the sensitive shape. A plain `new Error('flap')` has no `.command` property, so `not.toMatch(/[0-9a-f]{64}/)` passes by construction regardless of the redact policy. To exercise the real ioredis leak surface, construct the rejection with the real shape:

```ts
mockRedis.eval.mockRejectedValueOnce(
  Object.assign(new Error('flap'), {
    command: { name: 'eval', args: [counterKey] },
    name: 'ReplyError',
  }),
);
```

The same principle applies to `AssertionError` (`actual`/`expected`/`operator` properties), VError (`info`/`jse_info`/`jse_shortmsg`/`jse_cause`), and dhive errors. Use a 64-hex-shaped token in the fixture so the negative regex has actual surface — a 16-hex stub passes vacuously.

**Use distinct per-field markers when fields may leak independently.** A common shape for VError / dhive errors stamps the same string onto multiple fields (`err.message === err.jse_shortmsg === opts.shortmsg`, and `err.cause.message === err.jse_cause === opts.cause`). A fixture that reuses one value per field-pair has two failure modes:

1. When `not.toContain(SHORT)` fails, the test can't tell WHICH field leaked — `message`, `jse_shortmsg`, or both — because they share the value.
2. A regression that correctly strips one field but leaks the other passes spuriously: the surviving leaked field still matches the assertion's expected string, so `not.toContain(SHORT)` doesn't fire.

Fix: give each potentially-leaking field its own unique marker, and assert against each marker independently:

```ts
function makeDhiveLikeError(opts: { shortmsg: string; cause: string; ... }) {
  // Per-field markers — caller may pin them or accept the auto-generated default.
  const messageMarker      = opts.messageMarker      ?? `${opts.shortmsg}::message`;
  const jseShortMsgMarker  = opts.jseShortMsgMarker  ?? `${opts.shortmsg}::jse_shortmsg`;
  const causeMessageMarker = opts.causeMessageMarker ?? `${opts.cause}::cause_message`;
  const jseCauseMarker     = opts.jseCauseMarker     ?? `${opts.cause}::jse_cause`;

  const err = Object.assign(new Error(messageMarker), {
    jse_shortmsg: jseShortMsgMarker,
    jse_cause:    jseCauseMarker,
    cause: new Error(causeMessageMarker),
  });
  // Surface the markers on the returned object so test sites don't re-derive them.
  return Object.assign(err, { messageMarker, jseShortMsgMarker, causeMessageMarker, jseCauseMarker });
}

// In a test:
const dhiveErr = makeDhiveLikeError({ shortmsg: 'SHORT', cause: 'CAUSE' });
// ... drive the leak surface ...
expect(JSON.stringify(res.body)).not.toContain(dhiveErr.messageMarker);
expect(JSON.stringify(res.body)).not.toContain(dhiveErr.jseShortMsgMarker);
expect(JSON.stringify(res.body)).not.toContain(dhiveErr.causeMessageMarker);
expect(JSON.stringify(res.body)).not.toContain(dhiveErr.jseCauseMarker);
```

Now each field's leak path is independently asserted. A regression that strips three of four fields fails on the fourth's marker, naming the surviving leak. Belt-and-braces: keep the original coarse `not.toContain(SHORT)` assertion alongside the per-field markers — a future caller that doesn't pin markers and lets the auto-generated defaults handle it still has the shortmsg substring as a backstop.

## Related

- [`defensive-recursive-serializer-and-pino-err-redact-policy-2026-05-11.md`](./defensive-recursive-serializer-and-pino-err-redact-policy-2026-05-11.md) — the recursive serializer pattern (`safeRedactErr`, depth guard, plain-object branch, element-wise array recursion) that the wrapper in the present doc invokes; documents the canonical `redactErrSerializer` shape this doc's wrapper layer depends on.
- [`vitest-fake-timers-module-private-state-isolation-2026-04-29.md`](./vitest-fake-timers-module-private-state-isolation-2026-04-29.md) — establishes the `vi.spyOn(logger, 'info').mock.calls` call-site capture pattern and the pino `LogFn` overload cast (`undefined as never`); the present doc explains WHY that call-site capture layer is distinct from `serializers.err`.
- [`auth-structured-log-shape-2026-04-29.md`](./auth-structured-log-shape-2026-04-29.md) — establishes that `err` carries the raw Error for pino to serialize; the present doc explains why that convention, combined with a `serializers.err` redact hook, is insufficient for spy-visible redaction without a wrapper layer.
- [`test-mock-carve-out-clause-c-2026-05-04.md`](./test-mock-carve-out-clause-c-2026-05-04.md) — authorizes `vi.spyOn(logger, 'warn')` as a carve-out-eligible observability surface; the wrapper pattern in the present doc keeps the spy meaningful (sees redacted args) while remaining carve-out-eligible.
- [`tests-must-fail-on-mutation-of-code-under-test-2026-04-22.md`](./tests-must-fail-on-mutation-of-code-under-test-2026-04-22.md) — the "by-construction passing" failure mode the trap produces (mock rejection has no `.command` property; `not.toMatch` assertion passes vacuously) is a specific instance of this general principle.
- `backend/src/logger.ts` (the existing pino + `serializers.err` config — wave-1 implementation at commit `23bdae9`).
- `backend/src/lib/log-pii.ts` (the per-field hashed-PII helpers `hashEmailForLogs` and `hashTokenForLogs` — complementary call-site defense for known-safe redactions like emails and tokens, applied at log-construction time before `err` is even attached).
