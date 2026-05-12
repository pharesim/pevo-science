---
title: vi.spyOn().mockImplementation() replaces the function under test — ratchet tests that depend on in-place mutation observe nothing
date: 2026-05-12
category: conventions
module: backend
problem_type: convention
component: testing_framework
severity: high
applies_when:
  - Writing a ratchet test that must discriminate between two architectural options by observing an in-place side effect on the input
  - Using vi.spyOn(obj, 'method').mockImplementation(noop) on a function whose execution the test contract depends on
  - Asserting on the contents of an argument that the function-under-test is supposed to mutate in place
  - Adding mockImplementation to a logger spy to silence stdout — the silencing also disables the wrapper layer the test was meant to observe
  - Negative-assertion tests of the form "function X does NOT mutate Y" — these are the easiest to break vacuously
symptoms:
  - Ratchet test passes green under both the "feature present" and "feature absent" states it was designed to discriminate between
  - Reverting the wrapper-under-test has no effect on the test outcome
  - mock.calls captures raw input identically regardless of whether the wrapper ran
  - The negative-assertion variant of "function X does NOT mutate Y" passes vacuously because nothing ran at all
related_components:
  - logger
  - redact_policy
  - service_object
tags:
  - vitest
  - vi-spy-on
  - mock-implementation
  - ratchet-test
  - in-place-mutation
  - logger
  - redact-policy
---

## Context

PEvO's `logger-wrapper-api.test.ts` contains a negative-assertion ratchet test whose contract is: "a child logger returned by `logger.child(bindings)` does NOT apply the Layer-A `redactErrInArg` mutation." The intended ratchet: if a future change wraps children via `wrapPinoLogger(...)` (option 1), the in-place mutation would strip `err.command` before pino sees it, and the assertion on `err.command` would flip red — forcing the JSDoc to be updated before the suite re-greens.

The test as landed in commit `2da0eae` used `vi.spyOn(child, 'warn').mockImplementation((() => {}) as never)` to stub out `child.warn`, then asserted that `warnSpy.mock.calls[0][0].err.command` was still defined (unredacted). The architect's round-2 hold block on `agents/docs/tasks/pending/backend-logger-wrapper-pino-runtime-api-surface.md` identified this as a broken ratchet: the assertion passed green under both option 1 AND option 2, defeating the ratchet entirely.

The root mechanism: `mockImplementation` replaces the target function with a no-op. Neither `child.warn` (option 2, raw pino) nor any future wrapped version (option 1, `wrapPinoLogger`) ever executes. The spy captures whatever argument the test passes in — raw and unmodified in both cases. The Layer-A mutation contract (`redactErrInArg` rewrites `obj.err` in place on the same reference) is what makes the input reference the observable. When `mockImplementation` suppresses all call-through, that mutation never happens, and the test can no longer distinguish option 1 from option 2.

This failure mode is a separate and additive trap on top of the pino-serializer ordering trap documented in `pino-spy-serializer-ordering-trap-2026-05-06.md`. The ordering-trap doc explains WHY call-site redaction is designed to mutate in place. The present entry explains a failure mode that disables BOTH layers simultaneously, making the test meaningless regardless of which layer ordering problem you understand. The foundational principle this instantiates is `tests-must-fail-on-mutation-of-code-under-test-2026-04-22.md`: a test that does not fail when the code under test is mutated is providing zero protection.

## Guidance

**When a test's contract is "function X mutates input Y in place," do not use `vi.spyOn(obj, 'X').mockImplementation(noop)`.** The `mockImplementation` call replaces the function entirely before it can execute. The in-place mutation never occurs. The input reference looks identical whether the real function ran or not.

Use one of two alternatives:

**Variant (a) — spy without mock implementation.** Call `vi.spyOn(obj, 'X')` without chaining `.mockImplementation(...)`. The real function executes and mutates the input. Set `logger.level = 'silent'` to suppress real log output. Assert on `spy.mock.calls[0][0]`, which is the SAME reference the wrapper mutated. Useful when you want to verify both that the function ran AND what the mutation produced.

```ts
const warnSpy = vi.spyOn(logger, 'warn'); // NO mockImplementation
const originalLevel = logger.level;
logger.level = 'silent';
try {
  logger.warn({ err: hostileErr }, 'should not throw');
} finally {
  logger.level = originalLevel;
}
const captured = warnSpy.mock.calls[0][0] as { err: Record<string, unknown> };
expect(captured.err.type).toBe('RedactSerializerFailed'); // mutation is visible
warnSpy.mockRestore();
```

This is the pattern used in `backend/tests/lib/logger-redact.test.ts` (the hostile-getter `safeRedactErr` fallback test), where the spy observes the post-mutation sentinel on the SAME reference.

**Variant (b) — skip the spy entirely, observe the input reference directly (preferred for in-place mutation contracts).** Capture the input object as a local variable before passing it. After the call, assert on that variable. The input reference IS the observable — no spy needed to see the mutation.

```ts
const argObj = { err: leakyErr };
const savedLevel = logger.level;
logger.level = 'silent';
try {
  child.warn(argObj, 'leaky shape test');
} finally {
  logger.level = savedLevel;
}
// Under option 2 (current): child.warn is raw pino, no Layer-A mutation.
// argObj.err.command stays intact — assertion passes.
// Under a future option-1 migration: redactErrInArg mutates argObj.err
// to SerializedErr shape, dropping command. Assertion flips red.
expect(argObj.err.command).toBeDefined();
expect(argObj.err.command?.args).toContain(`pevotest:probe:${verifyToken}`);
```

Variant (b) is preferred because it makes the observable explicit: there is no spy involved and no ambiguity about what layer is being asserted. The mutation IS the event under test; observing the mutated reference directly is the clearest possible test of that contract.

The in-place mutation contract that makes both variants work is documented explicitly in `backend/src/logger.ts:340-354` (the `redactErrInArg` docblock):

> IMPORTANT — in-place mutation of the `err` field is INTENTIONAL: `vi.spyOn(logger, 'warn').mock.calls` captures argument references at the wrapper-call boundary. If the wrapper substituted a new shallow copy of the arg via spread (`{...obj, err: redacted}`), the spy's captured reference would still point at the ORIGINAL unredacted obj … By overwriting `obj.err` on the same reference the spy holds, the redacted form is visible to the spy at the moment the test inspects `.mock.calls` — closing the spy-vs-serializer ordering trap.

## Why This Matters

A negative-assertion ratchet that passes green under both the "feature present" AND "feature absent" states provides zero protection. The entire value of the ratchet is that it goes red when the thing it is protecting against happens. Using `mockImplementation(noop)` silently destroys that protection without any test-failure signal.

The failure is particularly deceptive because:

1. **The test looks correct on inspection.** The spy is set up, `child.warn` is called, the spy's `mock.calls` is inspected. The assertion matches the intended contract. Nothing in the test output indicates it is vacuous.
2. **The assertion passes for the wrong reason in both option-1 and option-2 worlds.** Flipping from option 2 to option 1 would not flip the test red — it would still pass, because `mockImplementation` already prevented any mutation from occurring.
3. **The failure mode compounds the ordering trap.** The sibling entry `pino-spy-serializer-ordering-trap-2026-05-06.md` explains that `vi.spyOn` captures pre-serializer state (Layer-A runs before the spy, Layer-B runs after). Understanding that ordering correctly still does not help if `mockImplementation` has disabled both layers.
4. **Cross-reviewer corroboration is what surfaced it.** The `/ce-code-review` pass on commit 2da0eae had both the correctness reviewer and the testing reviewer independently flag this finding. A single-reviewer pass might have missed the spy-vs-`mockImplementation` distinction; the cross-reviewer agreement is part of what gives this learning institutional weight.

## When to Apply

- Any test whose contract is "calling function X produces an in-place side effect on input Y."
- Any ratchet test asserting "this code path does NOT mutate the input" or "this code path DOES mutate the input."
- Any `vi.spyOn(obj, 'method').mockImplementation(...)` pattern where the test then asserts on the contents of the argument that was passed — if the real function's job was to mutate that argument, the mock will hide whether it did or not.
- Specifically: `vi.spyOn(pinoLogger, 'levelMethod').mockImplementation(noop)` followed by assertions on `mock.calls[N][0]` for any test that also involves a call-site wrapper that runs before pino's own call.

The inverse also applies: if you need to assert that a function does NOT mutate an argument (as in the option-2 documentary contract), variant (b) is the clearest expression — pass a known reference, call the real function with output suppressed, then assert the reference was not changed.

## Examples

**Before (broken — `mockImplementation` disables the mutation, making the ratchet vacuous):**

```ts
// backend/tests/lib/logger-wrapper-api.test.ts (commit 2da0eae, lines 113-136)
it('child level methods do NOT apply Layer-A redaction (option 2 documentary contract)', () => {
  const child = logger.child({ scope: 'layer-a-gap' });
  const warnSpy = vi.spyOn(child, 'warn').mockImplementation((() => {}) as never);

  const verifyToken = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  const leakyErr = Object.assign(new Error('Redis rejected eval'), {
    name: 'ReplyError',
    command: { name: 'eval', args: ['lua-script-body', '1', `pevotest:probe:${verifyToken}`] },
  });
  child.warn({ err: leakyErr }, 'leaky shape test');

  const firstCall = warnSpy.mock.calls[0] as unknown[];
  const firstArg = firstCall[0] as { err: { command?: { args: string[] } } };
  expect(firstArg.err.command).toBeDefined();           // passes in BOTH option 1 and option 2
  expect(firstArg.err.command?.args).toContain(`pevotest:probe:${verifyToken}`);  // same
  warnSpy.mockRestore();
});
// Problem: mockImplementation replaced child.warn entirely. The Layer-A wrapper
// (redactErrInArg) never ran in any world. The spy captured the raw input
// reference identically under option 2 (raw pino, no mutation) and would
// capture it identically under option 1 (wrapper present, mockImplementation
// prevents it from running). The ratchet is dead.
```

**After (variant b — observe input reference directly, spy not needed):**

```ts
// backend/tests/lib/logger-wrapper-api.test.ts (post-fix, per round-2 hold prescription)
it('child level methods do NOT apply Layer-A redaction (option 2 documentary contract)', () => {
  const child = logger.child({ scope: 'layer-a-gap' });
  const verifyToken = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  const leakyErr = Object.assign(new Error('Redis rejected eval'), {
    name: 'ReplyError',
    command: { name: 'eval', args: ['lua-script-body', '1', `pevotest:probe:${verifyToken}`] },
  });
  const argObj: { err: { command?: { name: string; args: string[] } } } = { err: leakyErr };

  // Silence stdout — child.warn is the real pino method, not a stub.
  const savedLevel = logger.level;
  logger.level = 'silent';
  try {
    child.warn(argObj, 'leaky shape test');
  } finally {
    logger.level = savedLevel;
  }

  // Under option 2 (current): child.warn is the raw pino method. No Layer-A
  // mutation. argObj.err.command stays intact — assertion passes.
  // Under a future option-1 migration (wrapPinoLogger applied to child):
  // redactErrInArg mutates argObj.err to SerializedErr shape before pino sees
  // it, dropping command. That mutation flips this assertion red — the
  // intended ratchet fires.
  expect(argObj.err.command).toBeDefined();
  expect(argObj.err.command?.args).toContain(`pevotest:probe:${verifyToken}`);
});
```

**Contrast — variant (a) spy WITHOUT mockImplementation (hostile-getter fallback test in `logger-redact.test.ts`):**

```ts
// This pattern works because the real logger.warn executes (no mockImplementation),
// mutates the err slot to the RedactSerializerFailed sentinel, and the spy
// captures the post-mutation reference.
const warnSpy = vi.spyOn(logger, 'warn');  // no .mockImplementation(...)
expect(() => logger.warn({ err: hostileErr }, 'should not throw')).not.toThrow();
const captured = warnSpy.mock.calls[0][0] as { err: Record<string, unknown> };
expect(captured.err.type).toBe('RedactSerializerFailed');
warnSpy.mockRestore();
```

The spy here observes the mutated sentinel because the real `logger.warn` wrapper ran and called `safeRedactErr`, which caught the throwing getter and returned the sentinel — overwriting `obj.err` in place on the same reference the spy captured. `mockImplementation` was absent, so the real path executed.

## Related

- [`pino-spy-serializer-ordering-trap-2026-05-06.md`](./pino-spy-serializer-ordering-trap-2026-05-06.md) — the COMPLEMENTARY trap: `vi.spyOn` captures BEFORE pino's `serializers.err` runs (Layer-B fires after spy interception). That entry explains why Layer-A in-place mutation is necessary for spy-visible redaction at all. The present entry explains a failure mode that disables BOTH layers regardless of ordering understanding: `mockImplementation` removes the function entirely, so Layer-A never runs and there is nothing for the spy to see. **Both traps can compound — a developer who understands one and not the other will still write vacuous tests.**
- [`tests-must-fail-on-mutation-of-code-under-test-2026-04-22.md`](./tests-must-fail-on-mutation-of-code-under-test-2026-04-22.md) — the foundational principle this instantiates. Revert-verify the code under test, including the wrapper layer, before declaring a ratchet test sound. If `mockImplementation` is in scope, the revert-verify amounts to: confirm the test fails when the wrapper code is reverted, WITHOUT removing or adjusting the spy. If the test still passes with the wrapper reverted, the spy is hiding the property.
- [`defensive-recursive-serializer-and-pino-err-redact-policy-2026-05-11.md`](./defensive-recursive-serializer-and-pino-err-redact-policy-2026-05-11.md) — defines the canonical shape of `redactErrSerializer` (the layer whose in-place mutation the test is meant to observe). The mutation contract codified here is what makes the spy-observable / direct-input-observable variants work.
- [`pino-spy-level-filter-ordering-trap-2026-05-07.md`](./pino-spy-level-filter-ordering-trap-2026-05-07.md) — third member of the `vi.spyOn`-on-logger family. Covers a level-filter ordering trap distinct from the present entry's elimination trap. Reference for the broader "spy lives at the logger object, not at the transport" structural fact.
- `backend/src/logger.ts:340-354` — the `redactErrInArg` docblock naming the in-place mutation contract explicitly ("INTENTIONAL") and explaining why a spread-copy would leave the spy holding the unredacted reference.
- `agents/docs/tasks/pending/backend-logger-wrapper-pino-runtime-api-surface.md` — round-2 hold block (2026-05-12) prescribing variant (b) verbatim as the fix for finding 1.
