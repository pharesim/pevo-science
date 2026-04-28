---
title: "Correlated fields in options interfaces must be encoded as a TypeScript discriminated union, not as independent optionals with a runtime fallback"
date: 2026-04-28
category: conventions
module: backend/src/lib
problem_type: convention
component: type-system
severity: high
applies_when:
  - "Adding a boolean flag to an options interface that enables a semantic mode (e.g., `forceAmbiguousOutcome`, `requireAuth`, `redactSecrets`)"
  - "Adding a string field to an options interface whose value MUST match a flag's semantic (e.g., a user-facing message that must align with the envelope the flag selects)"
  - "Reviewing a `?? fallback` chain where the fallback returns a value from a sibling field (e.g., `ambiguousMsg ?? failMsg`, `errorCode ?? defaultCode`)"
  - "An options interface has two or more fields whose required-ness is correlated (one's required-ness depends on another's value)"
  - "A round-N hold-fix tightens an optional field to required, and the same module has another optional field nearby — check whether THAT field is also load-bearing"
  - "Designing HTTP-envelope helpers, broadcast-envelope helpers, or any helper that emits user-facing strings keyed on a mode flag"
  - "Re-reviewing a hold-block fix whose previous round caught a silent-regression vector from optional fields — check the same pattern hasn't recurred one field over"
tags:
  - typescript
  - options-pattern
  - discriminated-union
  - silent-regression
  - envelope-helper
  - api-contract
---

# Correlated Options Must Be a Discriminated Union, Not Independent Optionals

## Context

When designing an options interface for a helper that takes a boolean flag enabling a semantic mode (e.g., "use the ambiguous-outcome envelope" or "redact secrets in the response") plus a separate string field whose value must match the flag's semantic (e.g., the user-facing message that goes with that envelope), the natural-feeling shape is two independent optional fields with a runtime fallback:

```ts
// ANTI-PATTERN — independent optionals with a `??` fallback
interface HandleBroadcastErrorOpts {
  forceAmbiguousOutcome?: boolean;
  ambiguousMsg?: string;
  failMsg: string;
  // ...
}

function handleBroadcastError(err: Error, opts: HandleBroadcastErrorOpts) {
  if (opts.forceAmbiguousOutcome) {
    const userMsg = opts.ambiguousMsg ?? opts.failMsg; // fallback chain
    // ... emit 504 envelope with userMsg
  }
}
```

This shape has a silent-regression vector. A future caller setting `forceAmbiguousOutcome: true` without `ambiguousMsg` falls back to `failMsg` — which on `forceAmbiguousOutcome: true` is **the wrong message** (it says "Failed to broadcast..." while the envelope says `outcome: 'uncertain'`). TypeScript doesn't catch the omission. Lint doesn't catch it. The caller compiles, runs, and emits a contradictory envelope at runtime.

This pattern recurred on the same task across two consecutive review rounds in PEvO's `BACKEND-ORCID-BROADCAST-TIMEOUT-OUTCOME-HANDLING`:

- **Round-1 #3** caught the analogue at the wrapper layer: `ambiguousOutcomeOpts: HandleBroadcastErrorOpts | undefined` was optional → caller-omission silently re-opened a consumed-state-token + 500 INTERNAL_ERROR hard-block class. Fix: tighten to required at the type level.
- **Round-2 #1** caught the same pattern one field over: `ambiguousMsg ?? failMsg` recreates the round-1 #2 envelope-message contradiction whenever a future caller passes `forceAmbiguousOutcome: true` without `ambiguousMsg`. **4-reviewer convergence** in the `/ce-code-review` fan-out: testing + adversarial + maintainability + kieran-typescript.

The recurrence is the signal. Implementers can repeat this shape even when a recent precedent on the same module just caught its sibling. Capturing the convention closes that loop.

## Guidance

When two fields in an options interface are **correlated** — one's required-ness depends on another's value — encode the correlation at the type level using a discriminated union. Drop the runtime fallback once the type guarantees the field is set.

```ts
// CONVENTION — discriminated union encodes the correlation
type AmbiguousOutcomeFields =
  | { forceAmbiguousOutcome?: false; ambiguousMsg?: never }
  | { forceAmbiguousOutcome: true; ambiguousMsg: string };

interface BaseOpts {
  failMsg: string;
  timeoutMsg: string;
  // ...other always-present fields
}

type HandleBroadcastErrorOpts = BaseOpts & AmbiguousOutcomeFields;

function handleBroadcastError(err: Error, opts: HandleBroadcastErrorOpts) {
  if (opts.forceAmbiguousOutcome) {
    // TS narrows `opts` to the second variant; `ambiguousMsg` is guaranteed string.
    // No `?? failMsg` fallback needed.
    const userMsg = opts.ambiguousMsg;
    // ... emit 504 envelope with userMsg
  }
}
```

Three properties this shape buys you:

1. **Compile-time enforcement of the correlation.** A caller setting `forceAmbiguousOutcome: true` and omitting `ambiguousMsg` is a TypeScript error, not a silent runtime fallback.
2. **No dead fallback path.** Removing `?? failMsg` removes a code path that runtime tests can't reach (every legitimate caller now MUST supply `ambiguousMsg` to compile). Less code, less to test, less to drift.
3. **Self-documenting at the call site.** Hovering the call site shows the variant; the IDE highlights the fields the chosen variant requires. The "if you set this flag, you must also set this string" rule lives in the type, not in a docblock that future renamers may miss.

The `ambiguousMsg?: never` on the false-variant is load-bearing: without it, TS would let a caller pass both `forceAmbiguousOutcome: false` and `ambiguousMsg: 'foo'` (silly but legal). Marking it `never` on the false-variant catches the nonsense state too.

## Why This Matters

**Silent regressions on options-pattern flags are the most common kind of recurrence in /ce-code-review fan-outs.** Adversarial reviewers find them by constructing concrete callers that satisfy the type but miss the runtime invariant. Type-level enforcement removes the entire class.

The cost of the discriminated-union shape is **one extra type alias and ~3 lines of TS**. The cost of the independent-optionals shape is:

- Adversarial review must re-run on every round to surface new caller patterns (token-expensive)
- Hold-fix cycles repeat the same shape one field over (round-1 caught flag, round-2 caught message — could compress to one round if the original interface was a discriminated union)
- Documentation must encode the correlation in prose (`agents/docs/api-contracts/*.md` rows, helper docblocks) and stay in sync as fields change

Compile-time enforcement compounds; prose enforcement decays.

## When to Apply

- **Always:** when a boolean flag in an options interface enables a semantic mode (envelope, redaction policy, retry strategy, auth requirement) AND a separate string or object field carries the mode-specific data.
- **Always:** when reviewing or extending an options interface that currently has a `?? fallback` chain across sibling fields. The fallback is a smoke signal that the correlation isn't type-encoded.
- **Always:** when a round-N hold-fix tightens an optional → required field. Audit every other optional field in the same interface for correlated-required-ness; promote the whole correlation to a discriminated union in the same diff (or file as a follow-up).
- **Skip:** when fields are genuinely independent (e.g., `timeout?: number` and `retries?: number` — neither's value depends on the other).
- **Skip:** when the fallback is a generic default unrelated to a mode flag (e.g., `pageSize ?? 25` — `pageSize` doesn't have a sibling flag whose semantic the value must match).

## Examples

### Before (PEvO `broadcast-error.ts` round-2)

```ts
// Independent optionals; `?? failMsg` fallback recreates round-1 #2 envelope-message contradiction
// whenever a future caller sets `forceAmbiguousOutcome: true` without `ambiguousMsg`.
interface HandleBroadcastErrorOpts {
  forceAmbiguousOutcome?: boolean;
  ambiguousMsg?: string;
  failMsg: string;
  timeoutMsg: string;
  // ...
}

const userMsg = opts.ambiguousMsg ?? opts.failMsg; // line 122 — silent regression vector
```

### After (convention-conformant)

```ts
type AmbiguousOutcomeFields =
  | { forceAmbiguousOutcome?: false; ambiguousMsg?: never }
  | { forceAmbiguousOutcome: true; ambiguousMsg: string };

interface BaseHandleBroadcastErrorOpts {
  failMsg: string;
  timeoutMsg: string;
  // ...always-present fields
}

type HandleBroadcastErrorOpts = BaseHandleBroadcastErrorOpts & AmbiguousOutcomeFields;

// At the consumer:
if (opts.forceAmbiguousOutcome) {
  const userMsg = opts.ambiguousMsg; // TS-narrowed; no fallback
  // ...
}
```

### Other PEvO surfaces this convention applies to

- Argon2 service-unavailable envelopes: any flag selecting "shutdown drain" vs "queue full" mode + the user-facing message paired with each.
- Auth/login error envelopes: any flag selecting "rate-limited" vs "credential-failure" vs "account-locked" + the matching message.
- ORCID `/callback` retriable-discriminator surfaces: any future flag adding a new envelope class plus its correlated user-facing message.

When extending these helpers, prefer the discriminated-union shape from day one — retrofitting after a hold-block surfaces the bug is more expensive than designing it in.

## Related conventions

- `agents/docs/solutions/conventions/chain-write-timeout-ambiguous-outcome-2026-04-22.md` — documents the broadcast-envelope convention this type-level pattern supports. The envelope rule (504 + `outcome:'uncertain'` + `verify_before_retry`) lives there; the type-level enforcement that the user-facing message MATCHES that envelope lives here.
- `agents/docs/solutions/conventions/wrapping-primitive-exhaustive-call-site-audit-2026-04-22.md` — call-site audit pattern for wrapping primitives. Discriminated unions are the type-level analogue: TypeScript audits at compile time, not the implementer at PR time.
