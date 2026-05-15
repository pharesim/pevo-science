---
title: All error-shaped data must go in the err slot — sibling top-level keys bypass both pino redact layers
date: 2026-05-06
last_updated: 2026-05-12
category: conventions
module: backend
problem_type: convention
component: logging
severity: high
applies_when:
  - Logging an error object that has a .cause chain
  - Constructing a log payload with any sibling error-shaped key (cause, originalError, wrappedError, postErr, etc.)
  - Adding context fields alongside an err key in a structured log call
  - Writing or reviewing cascade-error handlers that wrap or re-throw inner errors before logging
symptoms:
  - Sibling error-shaped keys (e.g. cause) bypass both redact layers and emit full enumerable Error properties to pino JSON output
  - Sensitive stack traces, command.args, or buffer-derived key material carried in Error.cause appear in structured logs despite redact config
related_components:
  - service_object
tags:
  - pino
  - log-redaction
  - logger
  - security
  - error-serialization
  - log-shape
  - err-slot
  - sibling-keys
  - cause-chain
---

## Context

PEvO's structured logging has two redaction layers that cooperate to prevent sensitive error data from reaching log sinks:

- **Layer A** (`backend/src/logger.ts:189-197`): a call-site `redactErrInArg` wrapper that mutates `obj.err` in place before delegating to pino. It strips known sensitive fields from the Error object.
- **Layer B** (`backend/src/logger.ts` pino `serializers.err` config): a pino serializer that intercepts the `err` slot and recursively traverses `cause` chains, redacting at each level.

Both layers are keyed strictly on the field name `err`. They inspect exactly one slot in the log payload. A payload that places an error-shaped value anywhere other than `err` — for instance `{ err, cause: err.cause, originalError, wrappedError, postErr }` — leaves the sibling keys outside both policies. Those sibling fields hit pino's default JSON serialization, which enumerates all enumerable own properties of the inner Error object, including any sensitive data those properties carry.

The concrete violation site surfaced in `/ce-code-review` of the wave-2 redact-wrapper landing is `backend/src/lib/broadcast-error.ts:270`, where a cascade-error log line spreads both `err` and `cause: err.cause` into the payload as siblings.

## Guidance

**All error-shaped data MUST go in the `err` slot of the log payload. Never hoist an error or an error's cause to a sibling top-level key.**

The pino serializer's recursive `cause` traversal at `logger.ts:140-142` already preserves the full redacted cause chain inside `err.cause`. A sibling `cause:` field is therefore both a leak surface and redundant.

The fix is applied at call sites, not at the policy layer:

```ts
// BEFORE — broadcast-error.ts:270 (violating pattern)
logger.warn(
  { ...opts.logContext, err, cause: err.cause, txId, failedStep, event: 'post_broadcast_write_failed' },
  msg,
);

// AFTER — sibling cause removed; full cause chain preserved inside err via serializer
logger.warn(
  { ...opts.logContext, err, txId, failedStep, event: 'post_broadcast_write_failed' },
  msg,
);
```

**Watch list for code review** — flag any log payload that includes one or more of the following as a sibling top-level key alongside `err`, OR as a standalone key whose value is an Error or Error-like object:

- `cause`
- `originalError`
- `wrappedError`
- `postErr`
- any key not prefixed with `err` whose value is `instanceof Error`, contains a `stack` property, or contains a `message` + `name` pair
- any key named after a known error-wrapper pattern (`innerError`, `rootCause`, `nestedError`, `sourceError`)

## Why This Matters

Error objects in PEvO cascade contexts can carry sensitive data in enumerable properties. The most dangerous examples are transient ioredis `ReplyError` objects (whose `command.args` array may contain tokens or OAuth state) and wrapped assertion errors (whose `actual` / `expected` fields may contain buffer-derived key material).

The redact policy was designed with the mental model "Error-shaped values are covered." The existing convention docs (`pino-spy-serializer-ordering-trap-2026-05-06.md`, `auth-structured-log-shape-2026-04-29.md`) reinforce this by speaking in terms of "the err field" and "the redact serializer" without flagging that the mechanism is field-name-keyed. This creates a gap: authors writing a cascade-error log line for operator readability naturally reach for `cause: err.cause` to surface the root cause prominently. The pattern looks idiomatic. Pino renders it without complaint. CI stays green unless a test specifically pins log-call argument shapes with a leaky-fixture at sibling keys.

Not following this convention produces a silent information leak. The failure mode does not surface in runtime errors or test failures; it surfaces only under log-sink inspection or security review.

**Reachability today (2026-05-06):** current exploitable paths are bounded. `cacheOrcidBinding` swallows `ReplyError`; `seedAccreditationBonus` only re-throws `SyntaxError | RangeError | TypeError`; `updateAccountOrcid` wraps pg errors. None currently lands a leaky shape at a sibling cause key under normal operation. The risk is future-facing: any new cascade function that re-throws a transient ioredis `ReplyError` or wraps an `AssertionError` into a domain error is one log call away from leaking `command.args` or `actual`/`expected` unredacted.

## When to Apply

- When writing any `logger.*` call that includes an `Error` object in the payload.
- When writing cascade-error handlers that wrap or re-throw an inner error and then log the result.
- When adding structured context to a log line where the original error has a `.cause` chain worth surfacing.
- When reviewing any log payload that includes more than one error-shaped value, regardless of key name.
- When adding a new field to a log payload and the value comes from an Error property (e.g. `err.cause`, `err.originalError`).

Does NOT apply to internal `err` field traversal inside the serializer itself, or to test fixtures asserting on the shape of the redacted output.

## Examples

**Pattern 1: cause hoisted to sibling (violating)**

```ts
// Violating — cause is outside the redact policy
logger.error(
  { err, cause: err.cause, requestId, event: 'orcid_callback_failed' },
  'ORCID callback error',
);
```

**Pattern 1: fixed**

```ts
// Correct — full cause chain preserved inside err via serializer's recursive traversal
logger.error(
  { err, requestId, event: 'orcid_callback_failed' },
  'ORCID callback error',
);
```

**Pattern 2: wrapper error with named inner error (violating)**

```ts
// Violating — wrappedError is outside the redact policy
const wrappedError = new Error('broadcast failed');
wrappedError.cause = originalErr;
logger.warn(
  { err: wrappedError, originalError: originalErr, txId },
  'broadcast write failed',
);
```

**Pattern 2: fixed**

```ts
// Correct — assign cause to the wrapper's .cause before logging; serializer traverses it
const wrappedError = new Error('broadcast failed');
wrappedError.cause = originalErr;
logger.warn(
  { err: wrappedError, txId },
  'broadcast write failed',
);
```

**Pattern 3: spread from an error context object (violating)**

```ts
// Violating — postErr and cause both land outside the redact policy
logger.warn(
  { ...errorContext, postErr: err, cause: err.cause, authorAccount },
  'post write failed',
);
```

**Pattern 3: fixed**

```ts
// Correct — place the error in err; drop the redundant cause sibling
logger.warn(
  { ...errorContext, err, authorAccount },
  'post write failed',
);
```

**Architectural posture:** expanding the redact policy to denylist sibling error-shaped keys (e.g. scanning every top-level key for `stack` or `message+name`) is deliberately not the preferred fix. It opens an unbounded question about non-error-named keys that happen to contain nested errors, creates a maintenance surface that drifts with evolving payload shapes, and adds per-log-call overhead. Call-site convention is cheaper, reviewable, and self-documenting. The serializer's recursive `cause` traversal is the correct mechanism for surfacing cause chains; authors should rely on it rather than duplicating cause data at the top level.

## Related

- `agents/docs/solutions/conventions/pino-spy-serializer-ordering-trap-2026-05-06.md` — pino serializer ordering and spy-hook mechanics; documents the `err` field lifecycle from call-site through serializer. Complementary, not contradicted: that doc covers WHEN the serializer fires (Layer-A vs Layer-B firing time); this doc covers WHICH field name it fires on.
- `agents/docs/solutions/conventions/auth-structured-log-shape-2026-04-29.md` — structured log shape conventions for authentication flows; uses "the err field" / "redact serializer" framing. The `err?` field rule there is implicit; this doc strengthens it into an explicit prohibition on sibling error-shaped keys.
- `backend/src/logger.ts:140-142` — serializer recursive cause traversal (the mechanism that makes the sibling cause field redundant).
- `backend/src/lib/broadcast-error.ts:270` — concrete violating site held for fix in the parent task `backend-bridge-key-startup-validation-and-pino-redact` round (architect commit `7684f8e`, 2026-05-06).
- `agents/docs/solutions/conventions/strict-superset-wrapper-inherits-escape-hatches-2026-05-12.md` — third bypass surface in the redact-policy bypass catalogue. This doc covers the **payload-shape axis** (sibling top-level keys bypassing the `err`-slot-keyed redact policy at the log-call surface); `defensive-recursive-serializer-and-pino-err-redact-policy` covers the **depth-recursion axis** (depth/cycle/throwing-getter handling inside the err-slot serializer); and the strict-superset sibling covers the **API-surface axis** (child-options forwarding letting a caller install their own non-redacting `serializers.err` on a child logger). All three are bypass mechanisms against the same Layer-A/Layer-B safety contract.

## Watch-list audit completion (2026-05-15)

The follow-up task `BACKEND-PINO-ERR-SIBLING-WATCH-LIST-AUDIT` swept `backend/src/**/*.ts` for the watch-list names enumerated above (`originalError`, `wrappedError`, `postErr`, `innerError`, `rootCause`, `nestedError`, `sourceError`, plus `cause`). Outcome: zero fixable hits at HEAD. The 6 watch-list names returned zero matches; `postErr` matches were all catch-binding variables passed positionally to `new PostBroadcastWriteError()` constructors (never enter logger payloads); `cause` matches were inside the redact-policy code itself (`logger.ts`, `broadcast-error.ts`) or the string-enum discriminator at `orcid.ts:1316-1328` (no leak surface). The single known violating site (`broadcast-error.ts:270` top-level sibling `cause`) was closed in `BACKEND-BRIDGE-KEY-STARTUP-VALIDATION-AND-PINO-REDACT` rounds 3-4; no other sites match the bypass class as of 2026-05-15. Archived under `BACKEND-PINO-ERR-SIBLING-WATCH-LIST-AUDIT (archived 2026-05-15)` in `agents/docs/tasks-archive.md`.
