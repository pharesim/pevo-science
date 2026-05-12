---
title: Strict-superset wrappers inherit the wrapped library's safety-bypass escape hatches
date: 2026-05-12
category: conventions
module: backend/src/logger.ts
problem_type: convention
component: tooling
severity: medium
applies_when:
  - Designing a wrapper that aims to be a strict superset of a third-party library's public interface (logger, redis client, dhive client, ipfs client, nodemailer transporter)
  - Layering a safety contract on top of the wrapped library (PII redaction, key-prefix discipline, TLS/auth pinning, content-addressing invariants, key-management constraints)
  - Widening a wrapper method's signature to forward an additional options parameter from the wrapped library
  - Reviewing a PR that adds a new caller of a wrapper method whose options surface includes policy-override fields
  - Bumping a wrapped library version that adds new option fields to a forwarded options type
related_components:
  - logging
  - security
tags:
  - wrapper-design
  - strict-superset
  - safety-contract
  - escape-hatch
  - redact-policy
  - pino
  - child-logger
  - redis
---

## Context

PEvO's `backend/src/logger.ts` wraps pino's `baseLogger` with an explicit "strict superset" goal: every method pino exposes (`child()`, `isLevelEnabled()`, level methods, `flush()`) is forwarded so future callers like `if (logger.isLevelEnabled('debug'))` or `logger.child({reqId})` don't TypeError or silently bypass pino's cheap-skip optimization. Round-2 fix 3 on `backend-logger-wrapper-pino-runtime-api-surface` widened `child()` from `(bindings)` to `(bindings, options?: pino.ChildLoggerOptions)` to match pino's signature.

That widening inherited two pino option fields that defeat the wrapper's PII-redaction safety contract:

- `options.serializers.err` — MERGES OVER the parent's `safeRedactErr` (pino `proto.js:115-136`); a child can override the err-serializer.
- `options.redact` — REPLACES the parent's redact policy entirely (pino `proto.js:158-165`).

Layer-A (call-site `redactErrInArg` in `makeLevelWrapper`) is intentionally absent on children per the architect's 2026-05-11 option-2 documentary decision (see [`defensive-recursive-serializer-and-pino-err-redact-policy-2026-05-11.md`](./defensive-recursive-serializer-and-pino-err-redact-policy-2026-05-11.md)). With Layer-A absent on children and Layer-B now overridable via the now-exposed `options` argument, both PII-redaction layers can be bypassed by a single innocent-looking call.

This is the dual of [`wrapping-primitive-exhaustive-call-site-audit-2026-04-22.md`](./wrapping-primitive-exhaustive-call-site-audit-2026-04-22.md): that learning says "every shape the underlying primitive accepts must be reachable through the wrapper" (completeness pulls the surface OPEN); the present learning says "completing the superset inherits the wrapped library's policy-override escape hatches" (the safety contract pulls the surface CLOSED). The two rules pull in opposite directions and force per-option triage.

## Guidance

**A wrapper that aims to be a strict superset of the wrapped library's public interface inherits the wrapped library's policy-override escape hatches by construction. When the wrapper layers a safety contract on top (PII redaction, key-prefix discipline, allowlist enforcement, TLS enforcement, content-addressing, sandboxing, rate-limit attribution), the strict-superset relationship silently widens the safety-bypass surface. The wrapper's JSDoc, types, and runtime do NOT automatically warn which option fields defeat which contract.**

When extending a wrapper to forward an options argument, perform per-option triage: for each field in the underlying options type, identify which (if any) of the wrapper's safety contracts that field would defeat if a caller passed it. Then pick a mitigation per field. Mitigation catalog (choose per field, per wrapper — not one global choice):

1. **JSDoc warning at the wrapper method.** Enumerate which option fields defeat which contracts and require future callers to acknowledge the override at the call site. Low cost; relies on reading discipline. Best when the wrapper has zero callers today — the first caller's PR can be reviewed adversarially.

2. **Type narrowing.** Exclude unsafe option fields from the wrapper's TypeScript surface via `Omit<>`:

   ```ts
   type SafeChildOptions = Omit<pino.ChildLoggerOptions, 'serializers' | 'redact'>;
   child(bindings: pino.Bindings, options?: SafeChildOptions): pino.Logger {
     return baseLogger.child(bindings, options);
   }
   ```

   Strictest; trades flexibility for compile-time enforcement. Best when the safety contract is non-negotiable and a future legitimate need for the field is unlikely.

3. **Runtime guard.** Throw or warn when a caller passes a field known to defeat the safety contract. Heavy-handed and obscures the underlying library's signature; usually reserved for fields that have no legitimate use (e.g., `tls.rejectUnauthorized: false` in production paths).

4. **Risk acceptance.** Expose the full option surface and document the safety contract as defeasible by the caller. Acceptable when the caller surface is small, per-PR review is enforced, and there are zero callers today. PEvO's choice for `logger.child` — the foot-gun is gated on a future call site landing.

Order of consideration: triage each field, prefer (2) when the contract is non-negotiable, fall back to (1) when callers are absent today, reserve (3) for fields with no legitimate use, document (4) explicitly when chosen so the choice isn't reversed silently.

## Why This Matters

Without per-option triage, a strict-superset wrapper presents itself as a hardened layer (the wrapper's whole reason for existing is the safety contract) while inheriting every escape hatch the wrapped library exposes. The hatches are invisible: the JSDoc says "forwards pino's options"; the types resolve to `pino.ChildLoggerOptions`; the runtime accepts the field and quietly merges or replaces the wrapper's policy. The next caller writes one line:

```ts
// Defeats Layer-B at the child:
const reqLogger = logger.child({ reqId }, { serializers: { err: (e) => e } });
reqLogger.warn({ err: leakyReplyError }, 'redis ate it');
// leakyReplyError.command.args[] (Redis keys + script bodies + tokens) lands
// in the transport unredacted. Layer-A is absent on children (option-2
// documentary decision). Layer-B was just overridden by the child's serializer.
```

The leak class is the same one [`defensive-recursive-serializer-and-pino-err-redact-policy-2026-05-11.md`](./defensive-recursive-serializer-and-pino-err-redact-policy-2026-05-11.md) was filed to close (WIF Buffer slices via `AssertionError.actual`, Redis `command.args` carrying tokens, VError `jse_info` carrying chain ops). The strict-superset goal silently reopens it for any child logger whose call site passes the wrong options. The wrapper's existence creates false confidence that disables the scrutiny the wrapped library's raw surface would receive.

Triage-at-write-time is cheap (one pass over the options type per wrapper extension) and produces a documented decision per field. Skipping it produces a wrapper whose safety claim is true only for callers who happen not to pass the wrong fields.

## When to Apply

Apply to:

- Extending a wrapper to forward an options argument from the wrapped library, when the wrapper layers any safety contract (PII redaction, key-prefix discipline, allowlist enforcement, TLS enforcement, content-addressing checks, sandboxing, rate-limit attribution, auth-context propagation).
- Writing a new wrapper that aims to be a "strict superset" of an underlying client, helper, or class.
- Reviewing a PR that widens a wrapper's signature to match more of the wrapped library's surface area — especially methods that accept an options object (`child`, `connect`, `add`, `pin`, `sendMail`, `transaction`, `broadcast`).
- Bumping the wrapped library's version when the changelog mentions new option fields.
- Reviewing a wrapper whose JSDoc says "forwards underlying options" without enumerating which fields defeat which contracts.

Do NOT apply to:

- Wrappers that don't layer a safety contract (pure ergonomics shims, type-adapters, currying helpers) — the strict-superset goal carries no safety surface to defeat.
- Wrappers over well-typed internal types where the options surface is finite and project-owned.

## Examples

### Example 1: `logger.child` — pino strict-superset wrapper (PEvO's current case)

The wrapper's safety contract is the two-layer PII-redaction policy. Layer-A (`redactErrInArg`) runs at the call site of `logger.warn/info/error`; Layer-B (`safeRedactErr` as pino's `serializers.err`) runs at the transport. Children inherit Layer-B but not Layer-A (option-2 documentary decision).

Per-option triage of `pino.ChildLoggerOptions`:

| Field | Defeats which contract? | Triage |
|-------|------------------------|--------|
| `level` | None (pino-internal log-level filter) | Forward verbatim. |
| `msgPrefix` | None (prefix string only) | Forward verbatim. |
| `serializers.err` | Layer-B — merges over parent's `safeRedactErr` | Mitigation (1) JSDoc + (4) risk-accepted; zero `.child()` callers in `src/` today. Adversarial review of first caller's PR. |
| `redact` | Layer-B — replaces parent's redact policy entirely | Same as above. |
| `serializers.<other>` | None for non-err keys (no current safety contract on other slots) | Forward verbatim. |

PEvO's chosen mitigation: (1) + (4) — JSDoc warning enumerates the fields, no type narrowing, no runtime guard. The foot-gun is gated on the future first caller. The decision is documented at the wrapper site so a future PR adding a `.child()` call triggers adversarial review of the options payload.

Alternative mitigation under (2) (would be chosen if callers existed today and the leak class were operationally hot): see the `SafeChildOptions = Omit<...>` snippet in the Guidance section.

### Example 2: Hypothetical `ioredisClient.duplicate` wrapper — key-prefix discipline

PEvO's Redis usage requires every key to be prefixed with `${config.appTag}:`. A future wrapper around ioredis that forwards `duplicate(options?)` inherits ioredis's `keyPrefix` option, which REPLACES the parent client's prefix. A duplicated client created with `{ keyPrefix: '' }` (or any other prefix) writes keys to the wrong namespace, defeating the appTag-isolation contract.

Per-option triage of the relevant `RedisOptions` fields:

| Field | Defeats which contract? | Triage |
|-------|------------------------|--------|
| `keyPrefix` | appTag key-prefix discipline | Mitigation (2) — `Omit<RedisOptions, 'keyPrefix'>`. The contract is non-negotiable; no legitimate reason to override the appTag from a duplicated client. |
| `db` | None (DB-number selection is unrelated) | Forward verbatim. |
| `tls` | TLS-required-in-prod contract (if one exists) | Mitigation (3) — runtime guard if `tls === false` in prod. |
| `password` | None (forwarded from env at construction) | Forward verbatim or omit (already set on parent). |

The wrapper after triage:

```ts
type SafeDuplicateOptions = Omit<RedisOptions, 'keyPrefix'>;
function duplicate(options?: SafeDuplicateOptions): Redis {
  // keyPrefix is inherited from the parent client; cannot be overridden.
  return baseClient.duplicate(options);
}
```

The exploit the triage forecloses:

```ts
// Without triage, this compiles and runs, defeating the prefix discipline:
const altClient = redisClient.duplicate({ keyPrefix: '' });
await altClient.set('admin:session', userToken);
// Key lands at 'admin:session' instead of 'pevotest:admin:session'.
// Crosses namespace boundaries; survives an appTag rename; breaks the
// key-isolation invariants the prefix was introduced to enforce.
```

## Related

- [`defensive-recursive-serializer-and-pino-err-redact-policy-2026-05-11.md`](./defensive-recursive-serializer-and-pino-err-redact-policy-2026-05-11.md) — the Layer-A / Layer-B redact policy this learning protects. The leaky-fields-by-subclass table at the bottom is the Layer-B safety contract surface this learning warns can be widened by the strict-superset wrapper.
- [`wrapping-primitive-exhaustive-call-site-audit-2026-04-22.md`](./wrapping-primitive-exhaustive-call-site-audit-2026-04-22.md) — the DUAL of this learning. Exhaustive-coverage pulls the wrapper surface OPEN to match the underlying primitive; the present learning notes that completing the superset inherits the wrapped library's policy-override escape hatches. Per-option triage is the reconciliation: complete the surface AND triage each option for safety-contract defeat.
- [`pino-err-slot-sibling-bypass-redact-policy-2026-05-06.md`](./pino-err-slot-sibling-bypass-redact-policy-2026-05-06.md) — a different bypass mechanism in the same redact-policy family: sibling top-level keys at the log-payload level (`{err, cause: err.cause, originalError}`) bypass the `err`-slot-keyed policy. The present learning is a third bypass surface (child-options forwarding) in the same catalogue.
- [`vi-spyon-mockimplementation-bypasses-function-under-test-2026-05-12.md`](./vi-spyon-mockimplementation-bypasses-function-under-test-2026-05-12.md) — sibling escape-hatch pattern at the test-framework layer: `mockImplementation` is `vi.spyOn`'s strict-superset escape hatch that disables the function under test. Same family (wrapper inherits a defeat-mechanism by construction), different layer (test framework vs production wrapper).
- [`caching-wrapper-discriminated-union-poisoning-2026-05-11.md`](./caching-wrapper-discriminated-union-poisoning-2026-05-11.md) — structural cousin in a different domain. `QueryCache.getOrSet` accepts any non-null/undefined return and stores it; the wrapper's API admits values its contract should reject. Same shape as the present learning at the return-value axis rather than the options-argument axis.
- `backend/src/logger.ts` — current `logger.child()` wrapper. Round-2 fix 3 widened the signature; JSDoc warning (mitigation 1) was the prescribed safety-contract treatment. (auto memory [claude]: `reference_redis_app_tag` and `project_single_instance_only` informed the Example 2 framing and the risk-acceptance rationale in Example 1.)
