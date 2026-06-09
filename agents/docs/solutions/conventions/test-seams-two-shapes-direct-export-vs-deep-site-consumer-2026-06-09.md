---
title: "Two shapes of `__test_seams`: direct helper re-export vs production-side deep-site consumer, and when to use each"
date: 2026-06-09
category: conventions
module: backend/src/routes
problem_type: convention
component: testing_framework
severity: low
applies_when:
  - Adding a new test-only `__test_seams` export to a backend route or module
  - Choosing between exposing a gated helper for tests vs injecting a failure/behavior at a deep call site
  - Reviewing a PR that introduces or extends a `__test_seams` export
tags:
  - test-seams
  - test-injection
  - node-env-gating
  - no-restricted-imports
  - fail-closed
  - testing-framework
related_components:
  - testing_framework
  - tooling
  - authentication
---

# Two shapes of `__test_seams`: direct helper re-export vs production-side deep-site consumer

## Context

PEvO backend modules expose a `__test_seams` named export to give tests access to behavior that is otherwise unreachable from the test boundary. Two structurally distinct shapes have accumulated, and which one to use is **not reconstructable from the code**: a future author adding a seam sees two patterns at the same `export const __test_seams = { ... } as const` surface with no in-code explanation of when each applies. The distinction surfaced during architect `/ce-code-review` of the `signup-verify.ts` finalize-fail injection seam (it was a dismissed P3 advisory; the durable lesson stands regardless). Three registered seams exist today: `routes/anonymousReview.ts` and `reputation.ts` (Shape A) and `routes/signup-verify.ts` (Shape B).

## Guidance

### The decision rule

- **Expose a gated helper or shared state that a test must call directly** (pre-seed a mapping store, repoint an index key) → **Shape A: direct re-export.** The helper already exists for production purposes; the seam just makes it importable by tests.
- **Inject a failure or behavior at a deep call site that no import-boundary export can reach** (simulate a crash *between* two sequential production operations) → **Shape B: production-side consumer at the site + a thin arming export.** You **cannot** inject a deep-site failure via a direct export — importing an internal function lets a test *call* it, but it cannot place the throw at the right point in the handler's sequential execution. The production handler must call the injected consumer itself.

### Shape A: direct helper re-export

The module defines an internal helper or mutable state for production use; `__test_seams` re-exports it so a test can drive it at the import boundary. No runtime gate sits on the seam itself — the eslint rule below is its guard. Examples: `anonymousReview.ts` re-exports `storeAnonMapping` / `encryptMapping`; `reputation.ts` re-exports `setBatchMembersKey`.

### Shape B: production-side consumer/mediator

A module-level `Set` (or equivalent) holds armed tokens. A private consumer (e.g. `maybeThrowInjectedFinalizeFailure`) is called **inside the production handler at the exact deep site** where the behavior must occur — in `signup-verify.ts`, in the `/confirm` handler between `createClaimedAccount` and the finalize `UPDATE`. `__test_seams` exports only a thin arming method (`failNextFinalizeUpdate`) that adds a token to the Set; it never exports the consumer or the Set directly.

### Shared invariants (both shapes)

1. **Typed `as const`** on the export object (locks the seam shape at the type level — see [[test-seams-export-shape-as-const-2026-05-04]] for the why).
2. **Inert in production.** Shape B's consumer opens with `if (!process.env.VITEST && process.env.NODE_ENV !== 'test') return;` — the De Morgan inverse of `drainArgon2Queue`'s `process.env.VITEST || process.env.NODE_ENV === 'test'` gate — so outside a test process it returns immediately and never consults the armed Set. Shape A helpers carry no destructive production side-effect and rely on the eslint rule as their guard.
3. **Forbidden from `src/` import** by a `no-restricted-imports` rule block in `backend/eslint.config.mjs` (scoped `files: ['src/**/*.ts']`), with one `patterns` entry per registered seam. Every new seam **must** add a matching entry. This is the primary guard for both shapes — and for Shape B it means the armed Set can never be populated by a production module even before the runtime gate fires (two independent guards).
4. **Shape B is fail-closed.** The injected throw propagates out of the handler to its catch and yields a 500; the affected row is left in a strictly less-privileged, recoverable state (for the finalize seam: `verify_token` still set, `posting_key_enc` NULL, Hive account materialized — the `resumeChainExists`-recoverable state). A failure injection never grants more access than the prior state.

## Why This Matters

The two shapes look identical at the export site (`export const __test_seams = { ... } as const`) but differ in *where the test-only logic lives*: Shape A's logic is entirely in the test; Shape B requires a production-side consumer wired into the handler. Neither the export declaration nor the `as const` annotation reveals which shape applies. The eslint catalog comment lists every registered seam and what it does, but it does not say *why* `signup-verify.ts` uses a consumer/mediator while `anonymousReview.ts` and `reputation.ts` re-export directly — so a developer adding a seam sees two patterns and guesses.

The failure mode of guessing wrong is concrete: trying to drive a deep-site failure with Shape A (exporting the would-be consumer for the test to call) produces a seam that looks wired but never exercises the intended transition — the test cannot insert a throw between two sequential awaits in the handler after the fact. The crash-transition test silently validates nothing.

## When to Apply

- Adding any new `__test_seams` export to a backend route or module.
- Choosing between exposing a gated helper (Shape A) and injecting a behavior at a specific point in a handler's execution sequence (Shape B).
- Reviewing a PR that adds or extends a `__test_seams` export — verify the shape matches the decision rule and that a matching `no-restricted-imports` entry was added.

## Examples

### Shape A — direct re-export (`anonymousReview.ts`)

```typescript
// Internal helpers, defined for production use:
async function storeAnonMapping(permlink, /* ... */, expiresAt): Promise<void> { /* ... */ }
function encryptMapping(reviewerAccount): { encrypted, iv, authTag, keyVersion } { /* ... */ }

// Shape A: thin re-export. The handler never touches __test_seams; only tests import it.
export const __test_seams = {
  storeAnonMapping,
  encryptMapping,
} as const;
```

`reputation.ts` follows the same shape, re-exporting `setBatchMembersKey` (a setter for its module-level override).

### Shape B — production-side consumer + thin arming export (`signup-verify.ts`)

```typescript
// Module-level armed-token Set. Never exported directly.
const injectedFinalizeFailures = new Set<string>();

// Production-side consumer, called inside the handler. Strict no-op outside a test process.
function maybeThrowInjectedFinalizeFailure(authToken: string): void {
  if (!process.env.VITEST && process.env.NODE_ENV !== 'test') return;
  if (injectedFinalizeFailures.delete(authToken)) {
    throw new Error('injected finalize UPDATE failure (test seam)');
  }
}

// Inside the /confirm handler, between createClaimedAccount and the finalize UPDATE:
//   const createResult = await createClaimedAccount(...);
//   maybeThrowInjectedFinalizeFailure(auth_token);   // <-- deep call site
//   await pool.query(`UPDATE accounts SET ... WHERE verify_token = $1`, ...);

// Shape B: thin arming export only. The consumer lives in the handler.
export const __test_seams = {
  failNextFinalizeUpdate(authToken: string): void {
    injectedFinalizeFailures.add(authToken);
  },
} as const;
```

### The guard both shapes share (`backend/eslint.config.mjs`)

```javascript
{
  files: ['src/**/*.ts'],
  rules: {
    'no-restricted-imports': ['error', {
      patterns: [
        { group: ['**/routes/anonymousReview', '**/routes/anonymousReview.js'],
          importNames: ['__test_seams'], message: 'Do not import __test_seams from routes/anonymousReview in production code. ...' },
        { group: ['**/routes/signup-verify', '**/routes/signup-verify.js'],
          importNames: ['__test_seams'], message: 'Do not import __test_seams from routes/signup-verify in production code. ...' },
        { group: ['**/reputation', '**/reputation.js'],
          importNames: ['__test_seams'], message: 'Do not import __test_seams from reputation in production code. ...' },
      ],
    }],
  },
}
```

Every new `__test_seams` export adds a matching `patterns` entry. The rule is scoped to `src/**/*.ts`, so test files under `tests/` are never linted by it.

## Related

- [[test-seams-export-shape-as-const-2026-05-04]] — the `as const` invariant both shapes obey (canonical source for why).
- [[test-mock-carve-out-clause-c-2026-05-04]] — governs whether the surrounding test file's mocking is permissible; relevant when Shape B is reached for because the deep site is unreachable through the public API. The two rules are orthogonal: this one governs seam topology, that one governs mock eligibility.
