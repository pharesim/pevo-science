---
title: Discipline interfaces silently lose compile-time enforcement when consumers live outside the tsc include perimeter
date: 2026-05-11
category: conventions
module: backend
problem_type: convention
component: testing_framework
severity: high
applies_when:
  - Adding a new TypeScript interface specifically to enforce a compile-time invariant (typo-protection, excess-property rejection, discriminated-union exhaustiveness, exhaustive narrowing)
  - Refining an existing discipline interface (adding fields, tightening types)
  - Auditing existing interfaces for compile-time coverage of every consumer
  - Reviewing tsconfig.json include or exclude changes
  - Reviewing test additions that pass deliberate extra fields to typed parameters
  - Reviewing PRs that introduce new test files in directories not currently covered by tsc
related_components:
  - tooling
  - documentation
tags:
  - typescript
  - tsconfig
  - tsc-perimeter
  - discipline-interface
  - excess-property-checking
  - vitest
  - esbuild
  - test-files
  - typo-protection
---

# Discipline interfaces silently lose compile-time enforcement when consumers live outside the tsc include perimeter

## Context

During architect batch-1 review of the broadcast-idempotency cluster on 2026-05-11, kieran-typescript and maintainability reviewers independently flagged a load-bearing gap in `backend/src/lib/broadcast-error.ts`: the `LogContext` interface was introduced at line ~114 explicitly to prevent typo'd structured-log fields from compiling silently. The inline comment captures the design intent verbatim: *"a typo at a call site compiles silently and operators got an inconsistent log shape."* The interface narrows the accepted keys to a documented union (`username?: string`, etc.).

Shortly after the interface landed, `backend/tests/lib/broadcast-error.test.ts` was found to pass `{ user: 'alice', action: 'test' }` as `logContext` values at roughly eleven call sites. Neither `user` nor `action` is declared in `LogContext`; `username` is the correct field. The tests then asserted against those invalid keys (`expect(call.user).toBe('alice')`), codifying the bypass as the expected behavior. No compile error fired because `backend/tsconfig.json` has `include: ['src']` (line 15) — `backend/tests/` is outside the type-check perimeter — and Vitest uses esbuild, which strips type annotations and emits JS without running tsc.

The interface's compile-time discipline applied only to `src/` callers. The test suite documented a wrong contract.

## Guidance

**Rule: every consumer of a discipline interface must live inside the tsc type-check perimeter, or the interface's compile-time protection is void.**

A *discipline interface* is any TypeScript interface or type alias introduced specifically to enforce a compile-time invariant: typo-protection, excess-property rejection, discriminated-union exhaustion, exhaustive narrowing. If a consumer (production caller, test fixture, codegen output, generated stub) lives outside the path that `tsc` checks, the protection does not apply to that consumer.

**Checkable form:** after introducing or refining a discipline interface, verify that `tsc --noEmit` (or its CI equivalent) is run over every file that passes a value of that type. For Vitest projects the default configuration runs esbuild, not tsc, so tests require an explicit, separate typecheck step.

**Structural fix (Vitest project shape):**

1. Extend the type-check perimeter to cover tests. Add a sibling tsconfig that widens `include`:

   ```json
   // backend/tests/tsconfig.json
   {
     "extends": "../tsconfig.json",
     "compilerOptions": {
       "rootDir": "..",
       "noEmit": true
     },
     "include": ["../src", "../tests"]
   }
   ```

2. Add a CI step that runs `tsc --noEmit -p backend/tests/tsconfig.json` alongside the existing src-only typecheck. Both must pass.

3. Fix every excess-property error surfaced. For each site, choose one path:
   - **Correct the field name** (preferred): `{ user: 'alice' }` → `{ username: 'alice' }`. Update assertions to the corrected key: `expect(call.username).toBe('alice')`.
   - **Explicit cast for intentional extra keys**: when a test genuinely needs to exercise spread-robustness (e.g., verifying the helper drops unknown keys), declare a local type and add a one-line comment naming the intent:

     ```typescript
     // Intentional: testing that the helper drops unknown keys rather than
     // forwarding them. Do NOT copy this pattern for normal log fixtures.
     type TestLogContext = LogContext & Record<string, unknown>;
     const ctx: TestLogContext = { username: 'alice', probeField: 'x' };
     ```

4. Land a spot-check fixture: write a deliberately-typo'd call site (e.g., `logContext: { usrname: 'alice' }`) in a scratch file, confirm the CI typecheck step rejects it, then remove the scratch. This verifies the structural perimeter extension actually catches the original failure class.

## Why This Matters

**Excess-property checking is load-bearing.** TypeScript's excess-property check fires only on "fresh" object literals assigned to a known type. It is the primary mechanism that catches typos at the construction site. Without it, a caller writing `{ usrname: 'alice' }` compiles silently; the key passes through to the log payload under the wrong name; operators see an inconsistent shape; monitoring alerts keyed on `username` miss the event. This is precisely the failure mode that prompts discipline interfaces in the first place.

**Test files commonly land outside the perimeter, and this is not a project-specific accident.** It is the default configuration for several common setups:
- **Vitest + esbuild**: esbuild is a transpiler, not a type-checker. It strips type annotations and emits JS without running tsc. Unless a separate `tsc --noEmit` step covers the test directory, test files have no compile-time type discipline.
- **Jest + ts-jest with `isolatedModules: true`**: similarly transpiles file-by-file without cross-file type checking.
- **Codegen stubs, server-side render helpers, and e2e fixtures** often live in directories excluded from the root tsconfig for build-output cleanliness reasons, inadvertently pulling them out of the type-check perimeter.
- **`rootDir` mismatches**: a tsconfig with `rootDir: 'src'` structurally cannot include `tests/` without a tsconfig error, so developers often just exclude tests rather than add a second tsconfig.

**The bypass is self-reinforcing.** Once a test asserts on an invalid shape, the assertion documents that shape as "the expected behavior." A future reader sees `expect(call.user).toBe('alice')` and infers that `user` is a valid `LogContext` field. A future production caller copies the test's pattern and writes `logContext: { user: req.account }`. The wrong convention propagates because the test looked authoritative. Once N test sites assert on the same wrong shape, untangling becomes a sweep — not a one-line fix.

**The asymmetry that makes it invisible to code review.** The production interface (`LogContext` in `lib/broadcast-error.ts`) and the test fixture (`{ user: 'alice' }` in `tests/lib/broadcast-error.test.ts`) live in different files. A reviewer looking at either file in isolation sees something reasonable. The reviewer looking at the test sees a passing test that correctly describes the observable behavior (the key DOES appear in the log output, because the spread passes it through). Nothing is obviously wrong until you cross-reference the interface definition and notice the field name mismatch. Automated excess-property checking would catch the mismatch in milliseconds; human review may not catch it at all.

## When to Apply

- **Introducing a new discipline interface.** Immediately verify that all planned consumers — including tests — are inside the tsc perimeter. If they are not, extend the perimeter as part of the same change.
- **Refining an existing interface** (adding fields, removing fields, tightening types). Re-run the perimeter check; a new field means new potential mismatch sites in tests.
- **Reviewing or modifying tsconfig.json `include` / `exclude` arrays.** Any change that removes a directory from `include` can silently pull consumers out of the perimeter.
- **Reviewing test additions that pass object literals to a typed parameter.** If the test file is not covered by a `tsc --noEmit` step, the type annotation is decoration, not a contract.
- **Post-review audits of interfaces that replaced `Record<string, unknown>` predecessors.** Interfaces introduced to replace an open record type are the highest-priority targets, because the original callers were written against the open type and are most likely to carry over invalid keys.
- **When `ce-code-review`'s kieran-typescript or maintainability persona flags a test-file shape that doesn't match a production interface.** This is the signature symptom of the failure class.

## Examples

**Before (perimeter gap; invalid keys accepted and codified):**

`backend/tsconfig.json`:
```json
{
  "include": ["src"],
  "exclude": ["node_modules", "dist"]
}
```

`backend/tests/lib/broadcast-error.test.ts` (excerpt — one of ~11 similar sites):
```typescript
const outcome = handleBroadcastError(res, err, {
  logContext: { user: 'alice', action: 'test' },  // 'user' and 'action' not in LogContext
  routeLabel: 'test.route',
  // ...
});

expect(warnSpy).toHaveBeenCalledWith(
  { err, username: undefined, user: 'alice', action: 'test', event: 'broadcast_timeout' },
  'test.route broadcast timed out',
);
// Asserts on 'user' key → codifies the bypass as expected behavior
```

**After (perimeter extended; excess-property errors surfaced and corrected):**

`backend/tests/tsconfig.json` (new file):
```json
{
  "extends": "../tsconfig.json",
  "compilerOptions": {
    "rootDir": "..",
    "noEmit": true
  },
  "include": ["../src", "../tests"]
}
```

CI step added alongside the existing src-only typecheck:
```bash
tsc --noEmit -p backend/tests/tsconfig.json
```

`backend/tests/lib/broadcast-error.test.ts` (corrected excerpt):
```typescript
const outcome = handleBroadcastError(res, err, {
  logContext: { username: 'alice' },  // canonical field per LogContext
  routeLabel: 'test.route',
});

expect(warnSpy).toHaveBeenCalledWith(
  { err, username: 'alice', event: 'broadcast_timeout' },
  'test.route broadcast timed out',
);
```

**Optional pattern: `TestLogContext` cast for intentional-extra-key sites**

```typescript
// backend/tests/lib/broadcast-error.test.ts (top of file)

// Used only in the spread-robustness test below. Allows verifying that the
// helper strips unknown keys rather than forwarding them. Do NOT copy this
// pattern for normal log-context fixtures; use the canonical LogContext shape.
type TestLogContext = LogContext & Record<string, unknown>;

it('strips unknown keys from the spread before logging', () => {
  const ctx: TestLogContext = { username: 'alice', unknownField: 'probe' };
  handleBroadcastError(res, err, { logContext: ctx, /* ... */ });
  expect(warnSpy.mock.calls[0][0]).not.toHaveProperty('unknownField');
});
```

## Related

Same flavor of "the discipline doesn't protect what you think it protects" but different mechanisms; cross-reference rather than supersede:

- [test-seams-export-shape-as-const-2026-05-04.md](test-seams-export-shape-as-const-2026-05-04.md) — strongest structural analogue. TypeScript discipline silently defeated for test consumers via a different mechanism (writability instead of perimeter exclusion). Same root question: "is the consumer actually bound by the type the author intended?"
- [pino-err-slot-sibling-bypass-redact-policy-2026-05-06.md](pino-err-slot-sibling-bypass-redact-policy-2026-05-06.md) — runtime sibling-key bypass of pino redact; same logging-shape flavor at a different layer.
- [pino-spy-serializer-ordering-trap-2026-05-06.md](pino-spy-serializer-ordering-trap-2026-05-06.md) — spy capture vs serializer pipeline ordering; "the test verifies the wrong thing" pattern.
- [pino-spy-level-filter-ordering-trap-2026-05-07.md](pino-spy-level-filter-ordering-trap-2026-05-07.md) — pino level filter timing vs spy capture; same "test passes, production invariant silently unprotected" flavor.

Implementation task spawned by this learning: `agents/docs/tasks/pending/backend-tests-typecheck-coverage.md` (extends tsc perimeter over `backend/tests/`, patches the ~11 known `broadcast-error.test.ts` bypass sites).
