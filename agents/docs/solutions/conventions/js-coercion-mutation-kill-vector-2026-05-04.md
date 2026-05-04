---
title: "JS coercion mutation-kill vectors must match the coercion hint of the named mutation"
date: 2026-05-04
category: conventions
module: backend/tests
problem_type: convention
component: testing_framework
severity: medium
applies_when:
  - adding a vector to a differential test intended to kill a specific coercion mutation
  - the mutation under test calls String(), Number(), +x, template-literal interpolation, or string-concat
  - the vector is an object with a custom toString, valueOf, or Symbol.toPrimitive property
  - the test passes before the mutation is reverted (false-pass risk)
  - "two implementations share a vector grid and agreement is the only signal of correctness"
  - the vector comment claims to kill a named mutation without a revert-verify step
  - Symbol.toPrimitive is absent and the hint is ambiguous across call sites
related_components:
  - backend/src/lib/password-policy.ts
  - backend/tests/lib/password-policy-drift.test.ts
tags:
  - testing
  - mutation-testing
  - type-coercion
  - differential-testing
  - javascript
  - test-design
  - string-hint
  - symbol-to-primitive
---

# JS coercion mutation-kill vectors must match the coercion hint of the named mutation

## Context

`backend/tests/lib/password-policy-drift.test.ts` is a cross-stack drift gate: it runs a shared vector grid against both the backend TS helper (`backend/src/lib/password-policy.ts`) and the frontend JS helper (`frontend/src/password-policy.js`), and fails if they disagree on any input. This makes it the right place to add coercion-mutation-kill vectors — inputs that would expose a `pw = String(pw)` coercion bug in one helper but not the other.

In commit `79ac01d`, two such vectors were added:

```ts
['object with toString returning a string that satisfies every class', { toString: () => 'Abcdef1234' }, false],
['object with valueOf returning a string that satisfies every class', { valueOf: () => 'Abcdef1234' }, false],
```

The `toString` vector is correct. The `valueOf` vector is dead coverage with a misleading label.

Empirical verification on Node 20 (architect cluster A walk, 2026-05-04):

```bash
$ node -e "console.log(JSON.stringify(String({ toString: () => 'Abcdef1234' })));"
"Abcdef1234"
$ node -e "console.log(JSON.stringify(String({ valueOf: () => 'Abcdef1234' })));"
"[object Object]"
```

`String(obj)` calls `OrdinaryToPrimitive(obj, hint='string')`, which tries `toString` first. For `{ valueOf: () => 'Abcdef1234' }`, `obj.toString` resolves to `Object.prototype.toString` (callable, returns `'[object Object]'`). The algorithm succeeds at step 1; the custom `valueOf` is never reached. The vector coerces to `'[object Object]'`, which fails password class checks whether or not the `String(pw)` mutation is present. The vector does not kill the mutant — it reduces to the existing `{}` case.

## Guidance

**When adding a coercion-mutation-kill vector, name the mutation it kills, verify by revert, and match the vector to the coercion form.**

### Rule 1 — Name the specific mutation in the comment

The test comment must state which coercion form the vector targets. "kills `String(pw)` coercion" is specific. "object with valueOf returning a string" is not — it names the object shape without stating what mutation it exercises or how.

### Rule 2 — Verify by revert

Insert the named mutation in one of the two implementations and confirm the suite turns red on the new vector before committing. This is the canonical check from `tests-must-fail-on-mutation-of-code-under-test-2026-04-22.md` ("How to apply", point 2). A vector that does not turn the suite red when the named mutation is active is not a coercion-kill vector — it is a passing test waiting to erode trust.

### Rule 3 — Match the vector to the coercion form

| Coercion form | Hint | First call | Fallback |
|---|---|---|---|
| `String(x)` | `'string'` | `toString` | `valueOf` |
| `+x`, `Number(x)`, arithmetic | `'number'` | `valueOf` | `toString` |
| `'' + x`, template literal `` `${x}` `` | `'default'` (for most objects) | `valueOf` | `toString` |
| `if (x)`, `!!x` | no coercion (ToBoolean) | n/a | n/a |
| Object with `[Symbol.toPrimitive]` | passes hint to method | `obj[Symbol.toPrimitive](hint)` | (no fallback) |

For a `String(x)` mutation, the vector must override `toString` (or `Symbol.toPrimitive`). A `valueOf`-only override does not affect `String()` because `OrdinaryToPrimitive` with hint `'string'` calls `toString` first.

### Rule 4 — Prefer `Symbol.toPrimitive` for universal coverage

An object with `[Symbol.toPrimitive]: () => 'X'` returns `'X'` regardless of which coercion form invokes the conversion. One vector kills any coercion mutation — `String(pw)`, `+pw`, template literals — because the symbol method intercepts all hint paths before `toString` or `valueOf` are considered.

Use `Symbol.toPrimitive` when you want a single vector that survives refactoring of the coercion form.

## Why This Matters

The failure mode is silent trust erosion, not an obvious red test. The `valueOf` vector passes (correctly, by accident) whether or not the `String(pw)` mutation is present, because both coerce to `'[object Object]'` and both fail class checks. The suite stays green. An engineer reads the comment ("kills coercion"), trusts the coverage signal, and ships. The actual kill coverage for the `valueOf` path of `String()` is absent.

This is a class of test-design bug: **a vector that looks like a mutation-kill but is not**. It appears in any test that:
- adds an input object to exercise a coercion path, but
- chooses the wrong override method for the coercion form in use.

The sibling failure mode — a mock that asserts the right return value but never verifies the call shape — is documented in `mock-guard-assertion-must-verify-call-shape-2026-04-21.md`. Both stem from the same root: a test that passes for the wrong reason. The `valueOf` coercion case is the input-vector analogue.

The broader principle in `tests-must-fail-on-mutation-of-code-under-test-2026-04-22.md` applies directly: a test that cannot be made red by mutating the code under test is not exercising the code under test.

## When to Apply

Apply this guidance when any of the following are true:

1. **Adding an object-typed vector to a differential or drift-gate test** — any time a test vector is an object (not a primitive) intended to probe type-checking behavior.
2. **The helper under test has a `typeof` guard** — e.g., `if (typeof pw !== 'string') return false` — and you want to cover the path where a mutation removes or relocates that guard. The vector must actually reach the guard in the mutated form.
3. **The coercion form is `String(x)`** — the vector must override `toString` or `Symbol.toPrimitive`. A `valueOf`-only override is a no-op for this form.
4. **A differential test compares a BE TypeScript helper against a FE JavaScript helper** — disagreements between the two only surface if the vector genuinely exercises a different branch in each. A vector that reduces to the same result in both implementations regardless of the mutation is not a differential signal.
5. **Writing a verify-by-revert check** — before committing a new coercion vector, insert the named mutation in one implementation, run the suite, confirm the specific new vector turns red, revert the mutation.
6. **Inheriting a test with object-typed vectors and an over-claiming comment** — audit existing vectors by running the Node one-liner for the coercion form used in the helper. If `String(vector)` does not return the satisfying string, the vector does not kill a `String()` mutation.

## Examples

### Bad — valueOf vector with over-claiming comment

```ts
// backend/tests/lib/password-policy-drift.test.ts

[
  // BAD: comment claims this kills String(pw) coercion, but it does not.
  // String({ valueOf: () => 'Abcdef1234' }) resolves to '[object Object]'
  // because String() uses hint='string', which calls toString() first.
  // Object.prototype.toString returns '[object Object]'. The custom valueOf
  // is never reached. The vector fails class checks for the same reason an
  // empty object {} does — the mutation is not exercised.
  'object with valueOf returning a string that satisfies every class',
  { valueOf: () => 'Abcdef1234' },
  false,
],
```

Verify this is dead:

```bash
node -e "console.log(JSON.stringify(String({ valueOf: () => 'Abcdef1234' })));"
# "[object Object]"  ← same as {}, mutation makes no difference
```

### Good — Symbol.toPrimitive vector with a tightened comment

```ts
// backend/tests/lib/password-policy-drift.test.ts

[
  // GOOD: kills the `pw = String(pw)` coercion mutation.
  // Symbol.toPrimitive intercepts all hint paths before toString/valueOf,
  // so String(obj) returns 'Abcdef1234'. If one helper coerces (String(pw))
  // and the other type-checks (typeof pw !== 'string'), this vector disagrees.
  // Verified by revert: insert `pw = String(pw)` in one helper → suite turns red.
  'object with Symbol.toPrimitive returning a string that satisfies every class',
  { [Symbol.toPrimitive]: () => 'Abcdef1234' },
  false,
],
```

Verify this is live:

```bash
node -e "console.log(JSON.stringify(String({ [Symbol.toPrimitive]: () => 'Abcdef1234' })));"
# "Abcdef1234"  ← coerces to the satisfying string; mutation is exercised
```

### Verify-by-revert procedure

Before committing a coercion vector, confirm it kills the named mutation:

**Step 1.** Insert the mutation in one helper only. In `backend/src/lib/password-policy.ts`:

```ts
// temporary revert mutation — remove before committing
export function isPasswordValid(pw: unknown): boolean {
  pw = String(pw);   // ← insert this line
  if (typeof pw !== 'string') return false;
  // ...
}
```

**Step 2.** Run the drift-gate suite:

```bash
source ~/.nvm/nvm.sh && nvm use 20
npx vitest run backend/tests/lib/password-policy-drift.test.ts
```

**Step 3.** Confirm the new vector turns red. If it stays green, the vector does not kill the mutation — fix the vector before committing.

**Step 4.** Revert the mutation. Commit the vector only after step 3 passes.

This is the "How to apply" check from `tests-must-fail-on-mutation-of-code-under-test-2026-04-22.md`, applied to the coercion-vector shape.

## Related

- `tests-must-fail-on-mutation-of-code-under-test-2026-04-22.md` — broader principle this convention specializes. General verify-by-revert rule; this convention is an instance restricted to coercion mutation vectors. The parent's "How to apply" checklist enumerates four concrete failure-mode categories (SQL filter mismatch, tautological Playwright predicate, mock-shape/extra-call, wrong implementation shape); the JS-coercion-vector failure is a fifth.
- `mock-guard-assertion-must-verify-call-shape-2026-04-21.md` — sibling failure mode. Assertions that look like mutation kills but admit a satisfying default path; different mechanism (mock fallback vs. coercion-hint mismatch), same meta-pattern (test passes for the wrong reason).
- `alpine-factory-exposure-vs-template-mutation-coverage-2026-04-28.md` — adjacent. Test layer with mutation sensitivity zero against the named regression class; different domain (Alpine factory vs. JS coercion) but same meta-shape.
