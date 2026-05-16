---
module: backend
date: 2026-05-16
problem_type: convention
component: testing_framework
severity: medium
tags:
  - eslint
  - custom-rule
  - ast
  - ruletester
  - mutation-kill
  - vacuous-coverage
  - visitor-descent
applies_when:
  - "Adding a new wrapper-node unwrap arm (TSAsExpression, TSNonNullExpression, TSTypeAssertion, ChainExpression, etc.) to a custom ESLint rule's resolver"
  - "Reviewing RuleTester test cases that claim to cover an unwrap arm via bare-form wrapper invalid cases"
  - "Auditing whether a rule's new resolver branch is actually exercised by the test suite vs. silently dead code"
related_components:
  - tooling
---

# ESLint custom-rule unwrap arms need a compound-form canary — bare-form wrapper invalid cases fire via the registered visitor, not via the unwrap arm

## Context

When a custom ESLint rule registers visitors for a fixed set of node types (e.g., `Literal`, `BinaryExpression`, `CallExpression`, `TemplateLiteral`) and the resolver function adds an unwrap branch for a wrapper-node type the visitor list does NOT register (e.g., `TSAsExpression`, `TSNonNullExpression`, `TSTypeAssertion`), the natural test shape is to add invalid cases that wrap the rule-triggering literal in the new wrapper:

```ts
// Intent: pin that the TSNonNullExpression unwrap branch fires.
{
  filename: abs('src/routes/papers.ts'),
  code: "const x = 'bridge_paper'!;",
  errors: [{ messageId: 'forbidden' }],
},
```

This test PASSES. The rule fires. Coverage looks satisfied. **But the unwrap branch never executed.** ESLint's traversal descends INTO the `TSNonNullExpression` wrapper and fires the registered `Literal` visitor on the inner `'bridge_paper'` literal directly. The resolver is called on the `Literal`, never on the wrapper. The unwrap branch is dead code: deleting it leaves the test green.

The bare-form wrapper invalid case is structurally incapable of exercising the unwrap branch. It is a vacuous mutation kill — the test passes for the wrong reason.

## Guidance

**For every wrapper-node unwrap arm added to a custom ESLint rule's resolver, add a COMPOUND-form invalid case that wraps the wrapper inside a node whose visitor IS registered** (most commonly `BinaryExpression`). The registered visitor fires on the compound node, calls the resolver on its operands, the resolver walks into the wrapper, and the unwrap arm finally executes.

Example, for a rule with `BinaryExpression` in the visitor list:

```ts
// Bare form — fires via Literal visitor, doesn't exercise the unwrap arm.
// Keep it for bare-form coverage documentation, but it pins nothing about the unwrap.
{
  filename: abs('src/routes/papers.ts'),
  code: "const x = 'bridge_paper'!;",
  errors: [{ messageId: 'forbidden' }],
},
// Compound form — fires via BinaryExpression visitor, resolver walks into
// TSNonNullExpression on the left operand, unwrap arm executes. Deleting the
// TSNonNullExpression branch in resolveStringValue fails this case red.
{
  filename: abs('src/routes/papers.ts'),
  code: "const x = 'bridge_'! + 'paper';",
  errors: [{ messageId: 'forbidden' }],
},
```

Verify the mutation kill is real by reverting the unwrap arm and confirming the compound-form case fails. If only the bare-form case fails (or neither fails), the test does not cover the new code path.

## Why This Matters

This trap defeats the standard mental model of test coverage. The author adds an unwrap arm because they want to handle a new wrapper-node class. They add invalid cases that use the wrapper. The cases pass. The unwrap arm is now "tested." But the test exercises a different code path than the one the author intended, and removing the unwrap arm has no observable effect on the test suite.

In PEvO this surfaced at `BACKEND-DISCIPLINE-GUARD-PIPELINE-INTEGRATION` round-4 (commit `04a5a6b`):

- The implementer added unwrap branches for `TSAsExpression`, `TSNonNullExpression`, `TSTypeAssertion` in `backend/eslint.config.mjs:resolveStringValue`.
- 5 TS-wrapper invalid cases were added: 4 bare-form (`'bridge_paper' as const`, `as string`, `!`, `<string>'bridge_paper'`) + 1 compound (`('bridge_' as const) + 'paper'`).
- 28 of 28 tests passed. Coverage looked complete.
- `/ce-code-review` round-4 (testing T1 + kieran-typescript KT-1 independently) caught that ONLY the compound case exercised an unwrap arm (TSAsExpression via BinaryExpression). The TSNonNullExpression and TSTypeAssertion arms were effectively dead code — removing either left all 28 tests green.

The fix: add compound-form invalid cases for the missing wrapper types (`'bridge_'! + 'paper'`, `(<string>'bridge_') + 'paper'`). Now each unwrap arm has a real mutation kill.

The deeper trap: the bare-form cases LOOK like load-bearing coverage. A reviewer auditing the test file by reading case-by-case would conclude each wrapper type is pinned. Only by mutation-verify (revert the unwrap arm, observe the test stays green) does the gap surface.

## When to Apply

- **When adding an unwrap branch to a custom ESLint rule's resolver** for any wrapper-node type (`TSAsExpression`, `TSNonNullExpression`, `TSTypeAssertion`, `ChainExpression`, `ParenthesizedExpression`, etc.). Each new wrapper type needs a compound-form invalid case.
- **At code-review time** when a diff adds a new unwrap branch AND adds invalid cases that use the wrapper in bare form. Ask: does any test case wrap the new wrapper-node type inside a node with a registered visitor? If not, the coverage is vacuous.
- **At test-file audit time** when reviewing an existing rule with established unwrap branches. Run the mutation-verify (revert each unwrap arm, observe which tests fail) to identify silent dead code.

## Examples

### Anti-pattern (vacuous coverage)

```ts
// resolveStringValue handles TSNonNullExpression by unwrapping to `.expression`.
function resolveStringValue(node) {
  if (node?.type === 'TSNonNullExpression') {
    return resolveStringValue(node.expression);
  }
  // ... other branches
}

// Visitor registration: Literal, BinaryExpression, CallExpression, TemplateLiteral.
// (No TSNonNullExpression visitor — the rule relies on resolveStringValue
// being called via the registered visitors.)

// Test:
{
  filename: abs('src/routes/papers.ts'),
  code: "const x = 'bridge_paper'!;",   // bare-form TSNonNullExpression
  errors: [{ messageId: 'forbidden' }],
},
```

Removing the `TSNonNullExpression` branch from `resolveStringValue` leaves the test green. ESLint's `Literal` visitor descends into the wrapper and fires on `'bridge_paper'` directly; the resolver is never called on the wrapper.

### Correct pattern (compound-form canary)

Keep the bare-form case for bare-form documentation, AND add a compound-form case:

```ts
// Bare form: pins that the bare wrapper fires the rule (via Literal visitor).
{
  filename: abs('src/routes/papers.ts'),
  code: "const x = 'bridge_paper'!;",
  errors: [{ messageId: 'forbidden' }],
},
// Compound form: pins that the unwrap arm executes (via BinaryExpression visitor → resolver → TSNonNullExpression unwrap → Literal).
{
  filename: abs('src/routes/papers.ts'),
  code: "const x = 'bridge_'! + 'paper';",
  errors: [{ messageId: 'forbidden' }],
},
```

Removing the `TSNonNullExpression` branch from `resolveStringValue` now fails the compound-form case red. The unwrap arm has a real mutation kill.

### Verification protocol

Before declaring a new unwrap arm covered:

1. Delete the unwrap arm locally.
2. Run the test suite.
3. Confirm at least one test case fails. If all pass, the arm is dead code or the canary is vacuous.
4. Restore the unwrap arm.

If step 3 fails, add a compound-form invalid case wrapping the new wrapper-node inside a `BinaryExpression` (or any other registered-visitor node), then re-verify.

## Related

- `agents/docs/solutions/conventions/tests-must-fail-on-mutation-of-code-under-test-2026-04-22.md` — parent principle. This convention is a named ESLint/AST-specific instance of the foundational rule that a test must fail on mutation of the code it covers.
- `agents/docs/solutions/conventions/mutation-kill-claims-must-match-assertion-and-corpus-2026-05-15.md` — closest sibling. That doc covers corpus-conditional vacuous kills (transform-idempotent corpus) and branch-reachability gaps. This doc adds the AST-visitor-descent subtype where the test fires via the wrong arm of the resolver.
- `agents/docs/solutions/conventions/test-marker-stub-vacuous-or-fallback-2026-05-15.md` — same meta-shape (test structurally incapable of failing; passes via the wrong mechanism). Mechanism here is visitor descent; mechanism there is truthy stub short-circuit. Both are "the test passes for the wrong reason" patterns.
- `backend/eslint.config.mjs` — the in-repo home of the `pevo/no-bridge-paper-literal` custom rule + `resolveStringValue` resolver. The reference implementation of the unwrap-arm + compound-form-canary pattern.
- `backend/tests/eslint/no-bridge-paper-literal.test.ts` — the RuleTester suite, including the `tsRuleTester` arm wired to `@typescript-eslint/parser` for TS-wrapper AST coverage.
