---
title: Pino level filter runs after vi.spyOn capture — spy-based event-emission tests do not verify production-level reachability
date: 2026-05-07
category: conventions
module: backend
problem_type: convention
component: testing_framework
severity: medium
applies_when:
  - Testing structured log emission via vi.spyOn on logger methods
  - Asserting a logger.debug or logger.trace call fired in a canary
  - Canary's stated purpose is to prove production observability of a hot-path event
  - Choosing log levels for events with mixed runtime visibility (security/attack-signal vs noisy 404 paths)
symptoms:
  - Canary test asserts logger.debug was called and passes; production at default LOG_LEVEL=info silently drops the call
  - Spy-based mutation-kill matrix shows clean RED/PASS but production observability is decoupled from the test result
  - Operator searching production logs for the asserted event finds nothing during incident response
  - Multiple independent reviewers (adversarial + testing + maintainability) flag observability gap on the same canary
related_components:
  - tooling
tags:
  - pino
  - vitest
  - vi-spy-on
  - canary-test
  - observability
  - log-level-filter
  - mutation-kill
  - test-design
---

# Pino level filter runs after vi.spyOn capture — spy-based event-emission tests do not verify production-level reachability

## Context

Tests that spy on logger methods (`vi.spyOn(logger, 'debug')`, `vi.spyOn(logger, 'info')`, etc.) intercept calls at the logger-object boundary — *before* pino's level filter runs. A canary asserting that a structured log event was emitted will pass at test time regardless of the configured log level, but in production at `LOG_LEVEL=info` (the default), any `logger.debug(...)` call is silently dropped at the filter layer. The canary attests observability the production runtime does not actually have.

This is a sibling axis to `agents/docs/solutions/conventions/pino-spy-serializer-ordering-trap-2026-05-06.md` (spies see the pre-serializer object, so redaction shape assertions don't prove `serializers.err` is wired). Both are instances of the same structural fact: **the spy lives at the logger object, not at the transport.** Anything pino does between the call site and the wire — level filter, serializer pipeline, redact policy, transport routing — is invisible to the spy.

The walker-canary task `backend-canonical-walker-canary-layer-mutation-kill` round-1 (commit `d76c0c8`) surfaced this concretely. The implementer added 4 START-bail event tags in `findCanonicalRoot` (`canonical_root_walker_no_pool`, `canonical_root_walker_start_invalid` with `reason: 'sql_filter_or_missing' | 'js_is_pevo_any_paper' | 'cont_columns_invalid'`) and chose `logger.debug` for all four — a deliberate deviation from the task spec's `logger.warn`, justified by `sql_filter_or_missing` firing on every benign 404 lookup of a non-PEvO post (warn would create production noise). The per-layer mutation-kill canary in `backend/tests/routes/canonical-root-walker.test.ts` spied on `logger.debug` via `vi.spyOn` and got a clean mutation-kill matrix at test time:

| Mutation | SQL canary | JS canary |
|----------|-----------|-----------|
| HEAD | PASS | PASS |
| Drop validPevoPaperWhere predicate | FAIL RED | PASS |
| Drop JS isPevoAnyPaper check | PASS | FAIL RED |

The structural mutation-kill the canary attests does not imply production observability — at default `LOG_LEVEL=info` the events are dropped at the level filter. Three reviewers (adversarial, testing, maintainability) cross-corroborated this independently in `/ce-code-review` on commit `d76c0c8`; the three-reviewer convergence is the signal that this is a structural trap, not a one-off mistake.

## Guidance

When you write a canary that asserts a structured log event was emitted, the assertion only proves the call site reached the logger object. It does not prove the event ever leaves the process at production log level. Treat the spy boundary explicitly:

```ts
// TRAP: canary "proves" observability that production doesn't have
import { logger } from '../../src/logger';

const debugSpy = vi.spyOn(logger, 'debug');

// findCanonicalRoot emits logger.debug(...) on START-bail
expect(debugSpy).toHaveBeenCalledWith(
  expect.objectContaining({
    event: 'canonical_root_walker_start_invalid',
    reason: 'sql_filter_or_missing',
  }),
  expect.any(String),
);
// PASS in vitest. In prod with LOG_LEVEL=info: nothing emitted.
```

Three fix shapes, in order of preference:

**Fix 1 — emit at a level production actually surfaces.** For security signals, attack-signal events, or anything an on-call engineer would page on, use `warn` or `error` so default `LOG_LEVEL=info` carries the event:

```ts
logger.warn(
  { event: 'canonical_root_walker_start_invalid', reason: 'js_is_pevo_any_paper' },
  'walker rejected non-PEvO start row',
);
```

**Fix 2 — keep `debug` and document the opt-in explicitly.** When the event fires on benign noise paths (e.g., the 404-lookup case for `sql_filter_or_missing`) and `warn` would drown signal in noise, accept that production observability requires `LOG_LEVEL=debug` for incident response. Document this at the call site so future readers don't assume the canary's pass implies prod visibility:

```ts
// NOTE: emitted at debug because this fires on every 404 lookup of a
// non-PEvO post. Production must set LOG_LEVEL=debug to observe; the
// canary spy in canonical-root-walker.test.ts intercepts BEFORE pino's
// level filter, so its pass does NOT imply the event is visible at
// LOG_LEVEL=info.
logger.debug(
  { event: 'canonical_root_walker_start_invalid', reason: 'sql_filter_or_missing' },
  'walker bailed at start',
);
```

**Fix 3 — test against an actual pino transport.** If level-filter fidelity must be asserted at the test boundary, configure pino with a write stream the test controls and assert the serialized output. Heavier and rarely worth it; reserve for cases where Fix 1 / Fix 2 don't apply.

## Why This Matters

False-positive observability claims silently degrade production incident response. The canary's green tick reads as "the event is emitted, the pipeline catches the failure mode" — but at the next outage the operator greps logs for `canonical_root_walker_start_invalid` and finds nothing, because the production runtime never wrote it.

The mutation-kill convention (`agents/docs/solutions/conventions/tests-must-fail-on-mutation-of-code-under-test-2026-04-22.md`) is silently violated: the test fails on mutation only at the logger-object boundary, not at the production-emission boundary the convention is meant to defend.

The three-reviewer cross-corroboration on `d76c0c8` is the structural-trap indicator — adversarial flagged the production-silence gap, testing flagged the spy-vs-transport mismatch, maintainability flagged the missing call-site documentation. Multiple lenses landing on the same gap independently means this is a pattern, not a slip.

## When to Apply

- Writing canary tests that assert structured log events fire (any `vi.spyOn(logger, ...)` + `toHaveBeenCalledWith` shape).
- Choosing log levels for events with mixed runtime visibility — security/attack-signals vs. high-cardinality noise paths (404 lookups, validation rejects on user input, etc.).
- Designing observability for production-deployed Node.js/pino services where `LOG_LEVEL` is set per-environment.
- Reviewing PRs that add new structured events alongside spy-based tests; check the level against `LOG_LEVEL` in `.env.example` / production config.
- Any time a sibling axis applies (`pino-spy-serializer-ordering-trap-2026-05-06.md`, `pino-err-slot-sibling-bypass-redact-policy-2026-05-06.md`) — the spy-at-logger-object structural fact is the same; verify all axes (level, serializer, redact, transport) for the event under test.

## Examples

**Before — trap shape (from walker-canary round-1, `d76c0c8`):**

```ts
// backend/src/routes/papers.ts — findCanonicalRoot
if (!validPevoPaperWhere(startRow)) {
  logger.debug(
    { event: 'canonical_root_walker_start_invalid', reason: 'sql_filter_or_missing' },
    'walker bailed at start',
  );
  return null;
}
```

```ts
// backend/tests/routes/canonical-root-walker.test.ts
const debugSpy = vi.spyOn(logger, 'debug');
// ... drive the SQL-filter-drop mutation
const events = debugSpy.mock.calls.map(([obj]) => obj);
expect(events[0]?.reason).toBe('sql_filter_or_missing');
// PASS at test time. In prod at LOG_LEVEL=info: zero events written.
```

The mutation-kill matrix passes cleanly, but the canary's green tick is decoupled from production reachability. An on-call engineer searching production logs for `canonical_root_walker_start_invalid` during a walker regression sees nothing.

**After — Fix 1 (genuine attack signal at warn):**

```ts
// Hypothetical: walker rejecting a row whose continuation columns are tampered.
// This is not noisy; it indicates suspect input.
if (!contColumnsValid(startRow)) {
  logger.warn(
    { event: 'canonical_root_walker_start_invalid', reason: 'cont_columns_invalid' },
    'walker rejected start row with invalid continuation columns',
  );
  return null;
}
```

`LOG_LEVEL=info` (production default) emits the event. The spy-based canary still mutation-kills, and the production runtime actually carries the signal. Update the test spy to `vi.spyOn(logger, 'warn')` to match.

**After — Fix 2 (debug acceptable + documented opt-in for noisy path):**

```ts
// sql_filter_or_missing fires on every 404 lookup of a non-PEvO post.
// warn would drown signal in noise; we accept debug + document the opt-in.
//
// Production observability requires LOG_LEVEL=debug for incident response.
// The canary spy in canonical-root-walker.test.ts intercepts at the logger
// object boundary, BEFORE pino's level filter — its pass at default level
// does NOT imply this event is visible in production at LOG_LEVEL=info.
if (!validPevoPaperWhere(startRow)) {
  logger.debug(
    { event: 'canonical_root_walker_start_invalid', reason: 'sql_filter_or_missing' },
    'walker bailed at start',
  );
  return null;
}
```

The call-site comment is the artifact that closes the loop — future readers (and the next reviewer running `/ce-code-review`) see the explicit acknowledgement that production needs `LOG_LEVEL=debug` to observe this path.

## Related

- `agents/docs/solutions/conventions/pino-spy-serializer-ordering-trap-2026-05-06.md` — sibling axis on the same structural fact (spies see pre-serializer objects). The two docs together cover the two layered ordering hazards between `vi.spyOn` and pino's transport pipeline.
- `agents/docs/solutions/conventions/pino-err-slot-sibling-bypass-redact-policy-2026-05-06.md` — adjacent pino observability/redact convention; different mechanism (field-name-keyed bypass) but same family of pino-mechanics-vs-test-spy hazards.
- `agents/docs/solutions/conventions/tests-must-fail-on-mutation-of-code-under-test-2026-04-22.md` — the convention this trap silently violates. Mutation-kill at the logger-object boundary is incomplete coverage when production filters at a level the test runtime doesn't.
- `agents/docs/solutions/conventions/test-mock-carve-out-clause-c-2026-05-04.md` — authorizes `vi.spyOn(logger, ...)` as a carve-out-eligible observability surface; readers of that carve-out should consult the two pino-spy-ordering traps before relying on the spy as a "real-path enough" stand-in.
- Origin: `/ce-code-review` of commit `d76c0c8` (`backend-canonical-walker-canary-layer-mutation-kill` round-1), three-reviewer cross-corroboration (adversarial, testing, maintainability).
