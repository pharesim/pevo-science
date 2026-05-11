---
title: "Defensive recursive serializer pattern + pino err-redact policy"
date: 2026-05-11
category: conventions
module: backend/src/logger.ts
problem_type: convention
component: logging
severity: high
applies_when:
  - "Writing a serializer that walks user-supplied or library-supplied object graphs (errors, request payloads, log objects)"
  - "Using pino's `serializers.err` config OR a call-site wrapper that mutates the `err` slot before pino formats the log line"
  - "An error subclass enumerates leaky fields by default (e.g., `AssertionError.actual/expected`, `ioredis.command.args`, VError `info/jse_*`)"
  - "Adding a new error subclass to a project — audit its default enumerables before allowing it to flow through `{err, ...}` log calls"
  - "Bumping a logging library version that changes default serializer behavior"
tags:
  - pino
  - serializer
  - redact
  - depth-guard
  - cycle-guard
  - defensive-coding
  - allowlist
  - error-subclass
---

# Defensive recursive serializer pattern + pino err-redact policy

## Context

`BACKEND-BRIDGE-KEY-STARTUP-VALIDATION-AND-PINO-REDACT` closed a 6-round arc on pino's `err` serializer. The original failure (`backend-bridge-custody-broadcast-discrimination` and `backend-verify-broadcast-attempts-cap`) was a class: pino's default err serializer enumerates ALL enumerable own properties of the error and copies them to the serialized payload. For error subclasses that carry leaky enumerables (AssertionError's `actual/expected` Buffer slices, ioredis ReplyError's `command.args` carrying Redis keys + script bodies, VError's `info/jse_info/jse_shortmsg/jse_cause` carrying chain RPC details), the default serializer dumps the secret to operator logs.

Round-1/2 added a custom pino `serializers.err` (Layer-B). Round-2 added a call-site wrapper that runs the serializer BEFORE pino sees the args (Layer-A), so `vi.spyOn(logger.warn)` captures the redacted shape. Rounds 3-5 closed the defensive-recursion gaps the initial implementation missed: depth/cycle guard, throwing-getter fault tolerance, plain-object cause bypass, plain-object aggregate-error bypass, array-cause element-wise recursion.

This entry documents the canonical shape that emerged. It has two layers — a **general defensive recursive serializer pattern** (reusable for any serializer that walks user-supplied object graphs) and a **pino-specific err-redact policy** (the allowlist of leaky fields by error subclass).

## Guidance

### Layer 1: General defensive recursive serializer pattern

Any serializer that walks recursively-shaped inputs (errors with `cause` chains, AggregateError with `errors[]`, request payloads, arbitrary log objects) needs five primitives to be safe against hostile or buggy inputs:

#### 1. Depth/cycle guard with discriminated-sentinel bail

```ts
const MAX_DEPTH = 10;

function serialize(value: unknown, depth = 0): SerializedShape | { type: 'MaxDepthExceeded'; depth: number } {
  if (depth > MAX_DEPTH) {
    return { type: 'MaxDepthExceeded', depth };
  }
  // ... recurse into cause / errors[] with depth + 1
}
```

A 2-step cycle (`A.cause = B; B.cause = A`) or a long linear chain (`A → B → C → ... ad infinitum`) crashes the process via stack overflow without this guard. On single-instance deployments that's a full availability outage. The sentinel `{type: 'MaxDepthExceeded', depth: N}` lets operators see WHY the serializer bailed — without it, the truncation is invisible.

#### 2. Try/catch fallback with sentinel

```ts
function safeSerialize(value: unknown): SerializedShape | { type: 'SerializerFailed'; message: string } {
  try {
    return serialize(value);
  } catch (serializerErr) {
    return {
      type: 'SerializerFailed',
      message: String(serializerErr?.message ?? serializerErr),
    };
  }
}
```

A custom Error subclass with a throwing getter (`get stack() { throw new Error('boom'); }`), a Proxy whose `getOwnPropertyDescriptor` throws, or an AggregateError member with throwing `Symbol.toPrimitive` propagates the throw out of every `logger.error({err}, 'msg')` site that already has an err in hand. Wrap the serializer invocation in try/catch and surface the failure as a discriminated sentinel, so the log call returns a structured record instead of throwing.

#### 3. Plain-object branch for non-discriminated recursive shapes

```ts
function isErrorLike(value: unknown): value is Error {
  return value !== null && typeof value === 'object' && 'name' in value && 'message' in value;
}

function serializePlainObject(value: unknown, depth: number): unknown {
  if (depth > MAX_DEPTH) return { type: 'MaxDepthExceeded', depth };
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    return value.map((item) =>
      isErrorLike(item) ? serialize(item, depth + 1) : serializePlainObject(item, depth + 1),
    );
  }
  const out: Record<string, unknown> = {};
  for (const key of SAFE_BASELINE_FIELDS) {
    if (key in value) out[key] = (value as Record<string, unknown>)[key];
  }
  if ('cause' in (value as object)) {
    out.cause = isErrorLike((value as Record<string, unknown>).cause)
      ? serialize((value as Record<string, unknown>).cause, depth + 1)
      : serializePlainObject((value as Record<string, unknown>).cause, depth + 1);
  }
  return out;
}
```

The trap: a recursive serializer that starts with `if (!isErrorLike(input)) return input;` returns a non-Error plain object VERBATIM, bypassing the allowlist. If that plain object is reached via `error.cause = leakyContextObject`, the leaky context dumps to logs. The fix is a parallel `serializePlainObject` helper that applies the same allowlist + depth guard to non-Error inputs, with NO `isErrorLike` short-circuit.

#### 4. Element-wise array recursion at every array site

```ts
// In serialize(...) at the errors[] site:
const maybeErrors = err.errors;
if (Array.isArray(maybeErrors)) {
  out.errors = maybeErrors.map((e) =>
    isErrorLike(e) ? serialize(e, depth + 1) : serializePlainObject(e, depth + 1),
  );
}
```

AggregateError's `errors[]` and any custom error subclass that stuffs related-errors-in-an-array (or causes-as-an-array) need element-wise dispatch. A blanket `Array.isArray(value) → return value` shortcut at `serializePlainObject` would let an array of plain-object errors leak verbatim.

#### 5. Allowlist by name (NOT a denylist)

```ts
const SAFE_BASELINE_FIELDS = ['name', 'message', 'stack', 'code', 'errno', 'syscall'] as const;
const RELAXED_EXTRA_FIELDS = ['port', 'address', 'hostname', 'path']; // dev-mode only
```

A denylist (e.g., `delete err.actual; delete err.expected; ...`) is unmaintainable: every new error subclass with a leaky enumerable extends the list, and a forgotten subclass leaks silently. An allowlist by name is the opposite — every new error subclass starts safe; only operationally-needed fields are added to the allowlist after audit. The dev-mode `RELAXED_EXTRA_FIELDS` extension via env knob (e.g., `PINO_ERR_REDACT_LEVEL=relaxed`) gives debug builds extra context without changing prod behavior.

### Layer 2: Pino-specific err-redact policy

The general pattern above, applied to pino's err-serializer surface, instantiates this policy:

#### Known-leaky standard fields by error subclass

| Subclass | Leaky fields | Why redact |
|----------|--------------|------------|
| Node `AssertionError` | `actual`, `expected`, `operator` | Buffer slices of the comparison values (dhive `PrivateKey.fromString` throws `assert.deepStrictEqual` on parse divergence — actual/expected are slices DERIVED from the WIF) |
| ioredis `ReplyError` | `command`, `command.name`, `command.args` | `command.args[]` includes Redis keys + script bodies; for the verify-broadcast-attempts INCR site, `args[0]` is the raw 64-hex token |
| VError-shaped | `info`, `jse_info`, `jse_shortmsg`, `jse_cause` | Chain-internal RPC details; may include custom_json payloads, broadcast op contents |
| Plain `Error` | (none; the baseline is safe) | `name`/`message`/`stack` are the only enumerables; all are allowlisted |

#### Allowlist + recursive `cause` and `errors[]`

```ts
function redactErrSerializer(err: unknown, depth = 0): SerializedErr | { type: 'MaxDepthExceeded'; depth: number } | unknown {
  if (depth > MAX_CAUSE_DEPTH) return { type: 'MaxDepthExceeded', depth };
  if (!isErrorLike(err)) return err;
  const errAny = err as Error & Record<string, unknown>;
  const out: SerializedErr = {
    type: errAny.constructor?.name ?? 'Error',
    name: String(errAny.name),
    message: String(errAny.message),
    stack: typeof errAny.stack === 'string' ? errAny.stack : undefined,
  };
  for (const field of SAFE_BASELINE_FIELDS) {
    if (field in errAny) out[field] = errAny[field];
  }
  if (REDACT_LEVEL === 'relaxed') {
    for (const field of RELAXED_EXTRA_FIELDS) {
      if (field in errAny) out[field] = errAny[field];
    }
  }
  if (errAny.cause !== undefined) {
    out.cause = isErrorLike(errAny.cause)
      ? redactErrSerializer(errAny.cause, depth + 1)
      : redactPlainObject(errAny.cause, depth + 1);
  }
  const maybeErrors = errAny.errors;
  if (Array.isArray(maybeErrors)) {
    out.aggregateErrors = maybeErrors.map((e) =>
      isErrorLike(e) ? redactErrSerializer(e, depth + 1) : redactPlainObject(e, depth + 1),
    );
  }
  return out;
}
```

`redactPlainObject` is the Layer-1 plain-object branch above.

#### Two-layer placement (call-site + transport)

```ts
function redactErrInArg(arg: unknown) {
  if (arg && typeof arg === 'object' && 'err' in (arg as object)) {
    (arg as Record<string, unknown>).err = safeRedactErr((arg as Record<string, unknown>).err);
  }
  return arg;
}

export const logger = {
  warn: (...args: unknown[]) => baseLogger.warn(...args.map(redactErrInArg) as Parameters<typeof baseLogger.warn>),
  // ... etc for info/error/debug/fatal/trace
  flush: baseLogger.flush.bind(baseLogger),
};
```

- **Layer A (call-site wrapper):** `redactErrInArg` runs BEFORE pino sees the args. Required because `vi.spyOn(logger.warn).mock.calls[0][0].err` captures the args AT THE CALL, not after pino serializes. Without Layer A, spy-based redaction tests pass by construction; the real path FAILS the negative regex.
- **Layer B (pino serializer):** `pino({ serializers: { err: safeRedactErr } })` is defense-in-depth. Any direct-baseLogger call site (e.g., pinoHttp's per-request child logger) inherits Layer-B redaction even when Layer-A is bypassed.

Both layers MUST exist. Removing Layer A breaks spy-based tests AND lets the err arg flow through the runtime serializer's TIMING (post-call, pre-emit) without the wrapper's mutation.

#### Env-knob for dev-mode relaxed redaction

`PINO_ERR_REDACT_LEVEL=relaxed` extends the allowlist with `port`, `address`, `hostname`, `path` for debugging. Default `strict`. Captured at module-load — `vi.resetModules() + process.env.X = 'relaxed' + await import('logger.js')` is the test-fixture pattern to exercise the relaxed branch.

#### Extension procedure for new error subclasses

When adding a new error subclass to the codebase (custom, library, framework):

1. Run a one-off audit: `console.log(Object.keys(new YourErrorSubclass()))` — what enumerable own properties does it carry by default?
2. Categorize each property: stable identity (e.g., `code`, `name`) vs incidental payload (e.g., `request`, `raw`).
3. Add stable-identity fields to `SAFE_BASELINE_FIELDS` only if they're operationally needed. Incidental-payload fields stay in the implicit deny set.
4. Add a unit-test canary in `tests/lib/logger-redact.test.ts` exercising the new subclass: assert the allowlisted fields survive, assert the incidental fields are stripped.
5. If the subclass carries a `cause` chain or an `errors[]` aggregate, the existing recursive branch covers it — no new code, just the test canary.

## Why This Matters

- **WIF leak class (security):** The original failure mode dumped `AssertionError.actual` Buffer slices of the bridge admin posting key to operator logs. Anyone with log-read access could reconstruct the WIF. The redact policy closes that class.
- **Token leak class (security):** The δ-task surfaced the same shape via `ioredis.command.args` carrying the verify-broadcast-attempts INCR's raw 64-hex token. Replay-attack window is the token's 24h TTL.
- **Future-proofing:** Every new error subclass in PEvO (or a future dependency-bumped library version) carries the risk of new leaky enumerables. The allowlist + extension procedure is the structural defense — without it, the next leak class is one `npm install` away.
- **Recursive-input resilience:** PEvO's chain-error paths produce nested causes (`brodcast → ioredis.eval → dhive.client → ...`). Depth/cycle guards prevent serializer crashes; element-wise array recursion prevents aggregate-error bypasses; plain-object cause branch prevents the future-`error.cause = contextObj` shape.

## When to Apply

- Pino err serializer (the canonical instantiation).
- Any custom serializer that walks recursively-shaped inputs (user payloads, chain ops, structured log objects).
- Any code path that calls `JSON.stringify` on user-supplied data — JSON.stringify has the same default-enumerable problem and benefits from a replacer that uses the same allowlist.
- Any reducer/visitor pattern that walks an object tree of unknown shape.

Do NOT apply to:
- Serializers over well-typed internal data structures (e.g., a DTO ↔ DB mapper) — the type system already constrains the shape.
- One-off `JSON.stringify` of constants for debugging — the inputs are known and trusted.

## Examples

### Before (round-1 — `serializers.err` only, no Layer A wrapper)

```ts
// backend/src/logger.ts (pre-round-2)
const logger = pino({
  serializers: {
    err: (err) => ({ name: err.name, message: err.message, stack: err.stack }),
  },
});
```

Defect:
```ts
// Test passes by construction:
const spy = vi.spyOn(logger, 'warn');
logger.warn({ err: new Error('flap') }, 'redis flap');
expect(spy.mock.calls[0][0].err).toMatchObject({ /* no command */ });
// ✗ The mock rejection is plain Error with no `.command`, so the assertion
//   passes regardless of whether the redact policy works.

// Real path FAILS:
logger.warn({ err: Object.assign(new Error(), { command: { args: ['secret'] } }) }, 'msg');
// → operator log payload includes `args: ['secret']` because pino's serializer
//   fires at WRITE time, but the spy captures at CALL time — pre-serialization.
```

### After (round-3 — Layer A + Layer B + depth guard + try/catch + plain-object + element-wise)

```ts
// backend/src/logger.ts
const SAFE_BASELINE_FIELDS = ['name', 'message', 'stack', 'code', 'errno', 'syscall'] as const;
const MAX_CAUSE_DEPTH = 10;

export function redactErrSerializer(err: unknown, depth = 0) { /* ... */ }
export function redactPlainObject(value: unknown, depth = 0) { /* ... */ }
function safeRedactErr(input: unknown) {
  try { return redactErrSerializer(input); }
  catch (e) { return { type: 'RedactSerializerFailed', message: String(e?.message ?? e) }; }
}
function redactErrInArg(arg: unknown) {
  if (arg && typeof arg === 'object' && 'err' in (arg as object)) {
    (arg as Record<string, unknown>).err = safeRedactErr((arg as Record<string, unknown>).err);
  }
  return arg;
}
const baseLogger = pino({ serializers: { err: safeRedactErr } });
export const logger = {
  warn: (...args: unknown[]) => baseLogger.warn(...args.map(redactErrInArg) as Parameters<typeof baseLogger.warn>),
  // ...
};
```

Both layers fire. Spy-based tests assert the wrapper's Layer A behavior; integration tests assert the transport's Layer B behavior. A deep cause chain bounded at 10 levels. A throwing-getter err yields the `RedactSerializerFailed` sentinel instead of propagating. A plain-object cause routes through `redactPlainObject`. An `errors[]` array recurses per-element.

## Related

- `agents/docs/solutions/conventions/pino-spy-serializer-ordering-trap-2026-05-06.md` — Layer A vs Layer B placement story; explains WHY a call-site wrapper is required (not just a `serializers.err` config).
- `agents/docs/solutions/conventions/pino-err-slot-sibling-bypass-redact-policy-2026-05-06.md` — sibling-cause bypass at the LOG OBJECT level (outside the err slot). Complementary to this entry (which is about depth-recursion bypass at the ERROR OBJECT level).
- `agents/docs/solutions/conventions/auth-structured-log-shape-2026-04-29.md` — established the structured-log discipline that this policy extends.
- `backend/src/logger.ts` — canonical implementation (~250 lines).
- `backend/src/lib/log-pii.ts` — `hashEmailForLogs`, `hashTokenForLogs` — per-field redaction helpers; this policy is the project-wide structural complement.
- `agents/docs/tasks-archive.md` — `BACKEND-BRIDGE-KEY-STARTUP-VALIDATION-AND-PINO-REDACT` archive entry, full 6-round history including the round-3 `errors[]` map → round-4 `cause` branch → round-5 array-element-wise + `errors[]` plain-object closure arc.
