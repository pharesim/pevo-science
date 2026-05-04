---
title: "Test-only `__test_seams` exports must use `as const` so the seam shape is locked at the type level"
date: 2026-05-04
category: conventions
module: backend/src/routes
problem_type: convention
component: testing_framework
severity: low
applies_when:
  - A backend route module exports a test-only namespace (`__test_seams`) so tests can drive private functions or helpers directly
  - The namespace is mirrored across multiple route files (the pattern is established and likely to spread)
  - Tests will reference the seam by destructured import or by full property access
tags:
  - test-seams
  - typescript
  - export-shape
  - as-const
  - mock-discipline
related_components:
  - testing_framework
  - tooling
---

# Test-only `__test_seams` exports use `as const`

When a backend route module exports a `__test_seams` namespace for tests to reach private functions, the export shape MUST be locked with `as const`:

```ts
// In a route module that needs a test seam:
async function decrementBroadcastAttempts(token: string): Promise<void> {
  // ... private to the module's runtime path
}

export const __test_seams = { decrementBroadcastAttempts } as const;
//                                                          ^^^^^^^^
```

## Context

PEvO backend routes occasionally need a test-only escape hatch — a function that's private to the runtime call graph but that tests must drive directly to exercise narrow branches (e.g., race-recovery DEL paths, error-handler internals). The established pattern is a `__test_seams` namespaced export at the bottom of the route file. The `__` prefix signals "do not import from production code"; the value is a plain object containing function references.

Cluster-B `/ce-code-review` of `backend-verify-broadcast-attempts-cap.md` round-3 (commit `e4f822a`) surfaced that the seam exports landed without `as const`. The inferred type is the OBJECT type with WRITABLE properties:

```ts
// Bug shape (without as const):
export const __test_seams = { decrementBroadcastAttempts };
// inferred: { decrementBroadcastAttempts: (token: string) => Promise<void> }
//   ^ object literal type — properties are writable
```

A test file can mutate the seam at runtime and the TypeScript checker won't complain:

```ts
// In a test file — no compile error, no runtime error, silently breaks coverage:
import { __test_seams as accreditationTestSeams } from '../../src/routes/accreditation.js';
accreditationTestSeams.decrementBroadcastAttempts = async () => { /* swap-in */ };
```

That mutation is invisible at the type level today and trivially easy to introduce by accident — `vi.mocked(__test_seams.fn).mockImplementation(...)` is the kind of pattern that LOOKS innocuous but works precisely because the slot is mutable.

## Guidance

Always append `as const` to the seam export. The change is one character per export site and locks the shape:

```ts
export const __test_seams = { decrementBroadcastAttempts } as const;
// inferred: { readonly decrementBroadcastAttempts: (token: string) => Promise<void> }
//   ^ properties are readonly — runtime mutation produces a TS2540 error
```

Tests can still READ the seam (the function reference is unchanged) and pass it to `vi.spyOn` / `vi.fn()` if they need to instrument it — they just can't reassign the slot itself. Spying on a function reference doesn't require slot mutation.

If a test genuinely needs to swap an entire function out (rare — usually the right pattern is `vi.mock('../../src/routes/<file>.js', ...)` instead), it can do so via the module-mock pattern, which doesn't go through the seam at all.

## Why This Matters

1. **Mutability of the seam is invisible at the type level.** Without `as const`, TypeScript treats the export as a plain object literal whose properties can be reassigned. There is NO compile-time signal that mutating the slot is dangerous.

2. **The seam is load-bearing for narrow-branch test coverage.** When tests reach into the seam to drive race-recovery DEL paths, error-handler internals, or other branches that aren't reachable through the public API, swapping the function silently changes what's being tested.

3. **The pattern will spread.** As more routes need test seams, the convention propagates by example. Establishing `as const` now (in the two existing sites — `routes/accreditation.ts` and `routes/orcid.ts`) means new sites mirror the locked shape, not the unlocked precedent.

4. **The fix is trivial.** One character per site. There is no reason to NOT lock the shape.

## When to Apply

Every time:
- A backend module declares `export const __test_seams = { ... }` (or any equivalent test-only namespace export).
- A new test seam is added to an existing module.
- A code review encounters a test seam without `as const`.

The rule applies to BACKEND routes specifically because that's where the pattern is established. If the pattern spreads to frontend or shared modules, the same rule applies — the underlying TypeScript semantic is identical regardless of where the file lives.

## Examples

### Existing sites at convention-landing time (2026-05-04)

- `backend/src/routes/orcid.ts` — original pattern. Test seam established for ORCID lock-acquisition tests.
- `backend/src/routes/accreditation.ts` — mirrored from orcid.ts during cluster-B δ round-3 (commit `e4f822a`); used for race-recovery DEL spec.

Both sites are flagged for the `as const` fix in the cluster-B δ round-4 hold block (single pass; one-character change per file).

### Future-tooling hook

An ESLint rule `no-mutable-test-seams-export` could enforce this convention mechanically — flag any `export const __test_seams` (or matching pattern) that lacks an `as const` assertion. Filed as a possible addition to `backend-discipline-guard-pipeline-integration.md` (the cluster-B follow-up task that proposes AST-based discipline rules), but not blocking — the convention itself is sufficient for code review to catch.

## Cross-references

- `agents/docs/tasks/pending/backend-verify-broadcast-attempts-cap.md` — cluster-B δ round-4 hold block, item 5: "as const on `__test_seams` in BOTH this task's accreditation.ts AND the orcid.ts precedent."
- `agents/docs/tasks/pending/backend-discipline-guard-pipeline-integration.md` — cluster-B follow-up task; future ESLint rule home if mechanical enforcement becomes valuable.
- `backend/src/routes/orcid.ts` — original `__test_seams` pattern (pre-existing, fix lands in δ round-4).
- `backend/src/routes/accreditation.ts` — mirrored `__test_seams` pattern (added in cluster-B δ round-3, fix lands alongside orcid in δ round-4).
