---
title: "Vitest TDZ disambiguation: factory-closure TDZ (Class A) vs import-graph eager-evaluation TDZ (Class B)"
date: 2026-05-16
category: conventions
module: vitest-tdz-classes
problem_type: convention
component: testing_framework
severity: medium
applies_when:
  - "A test file throws ReferenceError: Cannot access '<NAME>' before initialization at module evaluation time"
  - "The module under test (or a support module) is mocked with vi.mock(path, factory)"
  - "The support module's exported value is captured by a const at the top of the test file"
  - "Determining whether the TDZ violation originates inside a vi.mock factory closure body (Class A) or in the import graph's eager evaluation order (Class B)"
related_components:
  - backend
tags:
  - vitest
  - tdz
  - vi-mock
  - vi-hoisted
  - module-evaluation
  - import-graph
  - factory-closure
  - test-isolation
---

# Vitest TDZ disambiguation: factory-closure TDZ (Class A) vs import-graph eager-evaluation TDZ (Class B)

## Context

The existing convention doc `agents/docs/solutions/conventions/route-level-error-class-coverage-after-helper-extraction-2026-04-29.md` documents the `vi.hoisted(async () => await import(...))` pattern (Class A) for test files where a support module's output is consumed **inside** a `vi.mock` factory closure. A future agent searching the solutions store for "TDZ" or "Cannot access before initialization" would find that doc and might reflexively apply `vi.hoisted` to every TDZ hit — including cases where the constraint is structurally different and the fix is simpler.

During architect re-review of `backend-log-pii-email-hash` round 3 (archived 2026-05-15, commit `224b32e`), worker commit `8841a12` surfaced a second TDZ shape. Three test files — `bridge.test.ts`, `claims.test.ts`, `bridge-haf-lag-locks.test.ts` — needed to import `../support/sign-request.js` but couldn't use a static top-level import because each file also has `vi.mock('../../src/config.js', factory)` whose factory closes over `const TEST_BRIDGE_KEY` (and in `claims.test.ts`, `const TEST_ADMIN_KEY`). The support module's import transitively pulls in `config.js`, which fires the factory before the `const` initializers run. The fix in all three cases was a module-scope `await import(...)` placed after the captured `const` declarations — not `vi.hoisted`. The commit message explains the diagnosis inline; this doc makes the disambiguation reusable.

## Guidance

**Disambiguation rule — ask one question first:**

> Is the support module's output called **inside a `vi.mock` factory closure body**?

- **Yes** → **Class A.** The factory directly needs the module's exported value at factory-evaluation time. Use `vi.hoisted(async () => await import(...))` so the module loads during the hoist phase, before any factory runs.
- **No** (only called from `it()` / `beforeEach()` / `afterEach()` blocks) → **Class B.** The factory doesn't consume the support module at all; the problem is that a static import of the support module pulls the mocked module (`config.js`) into the eager graph and fires the factory before the closed-over `const`s initialize. Use a module-scope `await import(...)` placed **after** the `const` declarations the factory captures.

### Class A fix — support module consumed inside a `vi.mock` factory

```ts
// Class A: the vi.mock factory body USES a value from the support module.
// Wrong: static import runs after vi.mock hoisting → TDZ on `kit` inside factory.
import { buildArgon2RouteMockKit } from '../support/argon2-error-mocks.js'; // ❌

vi.mock('../../src/lib/argon2-semaphore.js', () => kit.argon2SemaphoreMockFactory());

// Correct: vi.hoisted loads the module during the hoist phase, before the factory fires.
const { mockRunWithArgon2Slot, argon2SemaphoreMockFactory, assertArgon2AbortIsSilent } = await vi.hoisted(
  async () => (await import('../support/argon2-error-mocks.js')).buildArgon2RouteMockKit(),
);

vi.mock('../../src/lib/argon2-semaphore.js', () => argon2SemaphoreMockFactory()); // ✅
```

(Pattern drawn from the examples section of `route-level-error-class-coverage-after-helper-extraction-2026-04-29.md`.)

### Class B fix — support module only called from `it()` blocks, but its import graph pulls in the mocked module

The broken state — a static import at the top of the file:

```ts
// ❌ BEFORE (would TDZ):
import { PrivateKey } from '@hiveio/dhive';
import { signRequestBound as signRequestBoundShared } from '../support/sign-request.js'; // static

const TEST_PRIVATE_KEY = PrivateKey.fromSeed('pevo-bridge-test-seed-deterministic');
const TEST_BRIDGE_KEY = PrivateKey.fromSeed('pevo-test-bridge-key-seed').toString();

vi.mock('../../src/config.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/config.js')>('../../src/config.js');
  return {
    ...actual,
    config: { ...actual.config, pevoBridgePostingKey: TEST_BRIDGE_KEY }, // factory captures TEST_BRIDGE_KEY
  };
});
// At module evaluation:
//   1. vi.mock factory is hoisted
//   2. sign-request.js static import fires → transitively imports config.js → factory fires
//   3. factory reads TEST_BRIDGE_KEY — but const hasn't initialized yet → TDZ ReferenceError
```

The fix — replace the static import with a module-scope `await import(...)` placed **after** the `const` declarations:

```ts
// ✅ AFTER (bridge.test.ts ~lines 153-160):
const { createApp } = await import('../../src/app.js');
const { config } = await import('../../src/config.js');
// Dynamic import (not top-level static) so the eager import chain doesn't
// pull `../../src/config.js` in before this file's vi.mock factory's closed-
// over `TEST_BRIDGE_KEY` initializes. Static import would trigger a TDZ
// ReferenceError on test-runner module evaluation.
const { signRequestBound: signRequestBoundShared } = await import('../support/sign-request.js');
```

Evaluation order with the fix:

1. Vitest hoists `vi.mock` factory registrations (factories are deferred, not yet called).
2. Module-level `const TEST_BRIDGE_KEY = PrivateKey.fromSeed(...).toString()` initializes.
3. `await import('../../src/app.js')` → triggers `config.js` factory → factory reads `TEST_BRIDGE_KEY` (now initialized). ✅
4. `await import('../support/sign-request.js')` loads safely. ✅

### Counter-example — Class B file without a factory mock — static import works fine

`backend/tests/routes/signup-verify-postbroadcast-severity.test.ts` (line 44) imports the same support helper statically:

```ts
// Static import is safe: no vi.mock('../../src/config.js', factory) in this file.
import { signRequestBound as signRequestBoundShared } from '../support/sign-request.js';
```

This file mocks `hive.js`, `account-creation.js`, and `reputation.js` — **but not `config.js`**. Its `vi.mock` factories don't close over any module-level `const` declarations. The eager import of `sign-request.js` pulling in `config.js` is harmless: no factory is waiting on a closed-over `const`. Static import works correctly.

## Why This Matters

The error message is identical in both cases:

```
ReferenceError: Cannot access 'TEST_BRIDGE_KEY' before initialization
```

Nothing in the message tells you whether the factory is consuming the support module (Class A) or whether it's the import graph that's pulling the mocked module in prematurely (Class B).

**Wrong remedy on Class A** (using module-scope `await import` instead of `vi.hoisted`): the factory still fires before the support module loads, because module-scope `await import` runs after hoist evaluation but the factory body executes *during* hoist evaluation. The TDZ persists.

**Wrong remedy on Class B** (using `vi.hoisted` when only `it()` blocks call the helper): the support module gets loaded at hoist time even though it isn't needed until test execution. This works but wraps a straightforward import-ordering problem in a more opaque construct, obscures the actual constraint (the eager import graph), and sets a misleading precedent for future readers of the test.

A future agent or reviewer finding only the existing Class A doc would likely conclude: "TDZ in a vitest file → use `vi.hoisted`." That conclusion is correct for Class A, wrong for Class B. Without this disambiguation, the wrong fix ships and survives review because it produces a passing test suite — `vi.hoisted` on Class B happens to work even though it's solving the wrong problem.

## When to Apply

- Hitting `ReferenceError: Cannot access '<NAME>' before initialization` at module evaluation time in a vitest test file.
- Reviewing a test file that has both `vi.mock(..., factory)` and a support-helper import where the factory closes over module-level `const`s.
- Adding a new `vi.mock('...', factory)` to a file that currently has only static support-helper imports — check whether the factory closes over any `const` that the static import's transitive graph could precede.
- Extracting a test helper into a shared support file that will be used from multiple test files, some of which have config-mocking factories — the importer files may need dynamic imports instead of static ones.

## Examples

### Class B — `backend/tests/routes/bridge.test.ts` (the fixed state)

The relevant section spans roughly lines 27-160 of the current file. Key landmarks:

- **Lines 31-32**: `const TEST_BRIDGE_KEY` initialized at module scope.
- **Lines 36-46**: `vi.mock('../../src/config.js', factory)` — factory closes over `TEST_BRIDGE_KEY` at line 43.
- **Line 160**: `await import('../support/sign-request.js')` — dynamic, placed after all `const` declarations and after the `vi.mock` calls. Comment on lines 156-159 explains the TDZ rationale inline.

```ts
// bridge.test.ts lines 31-32
const TEST_BRIDGE_KEY = PrivateKey.fromSeed('pevo-test-bridge-key-seed').toString();

// bridge.test.ts lines 36-46
vi.mock('../../src/config.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/config.js')>('../../src/config.js');
  return {
    ...actual,
    config: {
      ...actual.config,
      hiveBridgeAccount: 'pevotest.bridge',
      pevoBridgePostingKey: TEST_BRIDGE_KEY,  // <-- closes over the const
    },
  };
});

// ... [other vi.mock calls] ...

// bridge.test.ts lines 154-160
const { createApp } = await import('../../src/app.js');
const { config } = await import('../../src/config.js');
// Dynamic import (not top-level static) so the eager import chain doesn't
// pull `../../src/config.js` in before this file's vi.mock factory's closed-
// over `TEST_BRIDGE_KEY` initializes. Static import would trigger a TDZ
// ReferenceError on test-runner module evaluation.
const { signRequestBound: signRequestBoundShared } = await import('../support/sign-request.js');
```

The same pattern (same comment rationale, same dynamic import placement) appears in:

- `backend/tests/routes/claims.test.ts` — factory closes over both `TEST_BRIDGE_KEY` and `TEST_ADMIN_KEY`.
- `backend/tests/routes/bridge-haf-lag-locks.test.ts` — same shape with `TEST_BRIDGE_KEY`.

### Counter-example — Class B without the factory mock

`backend/tests/routes/signup-verify-postbroadcast-severity.test.ts` line 44:

```ts
// Static import is safe: no vi.mock('../../src/config.js', factory) in this file.
import { signRequestBound as signRequestBoundShared } from '../support/sign-request.js';
```

The `vi.mock` calls in this file mock `hive.js`, `account-creation.js`, and `reputation.js`. None of their factories close over module-level `const` declarations that `sign-request.js`'s transitive imports could race against. Static import works fine.

### Class A — `vi.hoisted` pattern (from existing convention doc)

For contrast, the Class A pattern from `route-level-error-class-coverage-after-helper-extraction-2026-04-29.md`:

```ts
// The support module's OUTPUT is consumed directly inside the vi.mock factory body.
// Static import would TDZ the factory; module-scope await import would also TDZ
// (factories run before module-scope statements). vi.hoisted is required.

const { mockRunWithArgon2Slot, argon2SemaphoreMockFactory, assertArgon2AbortIsSilent } = await vi.hoisted(
  async () => (await import('../support/argon2-error-mocks.js')).buildArgon2RouteMockKit(),
);

vi.mock('../../src/lib/argon2-semaphore.js', () => argon2SemaphoreMockFactory()); // factory CALLS the kit
```

The critical difference from Class B: `argon2SemaphoreMockFactory()` is called **inside** the `vi.mock` factory closure body. The support module's exported function must be available at the moment that factory executes — which is during the hoist phase. Only `vi.hoisted` achieves this.

## Related

- `agents/docs/solutions/conventions/route-level-error-class-coverage-after-helper-extraction-2026-04-29.md` — Class A precedent (factory-closure TDZ inside `vi.hoisted`); fix is `vi.hoisted + await import`. The canonical example this disambiguation doc was written to complement.
- `agents/docs/solutions/conventions/vitest-fake-timers-module-private-state-isolation-2026-04-29.md` — A third pattern where `await import` appears in vitest (module-private state isolation via `vi.resetModules` + per-test dynamic import). Different problem class; included so readers have the full map of when dynamic import is the answer in vitest and why.
- `agents/docs/solutions/conventions/test-config-mock-distinct-role-accounts-2026-04-21.md` — The `vi.mock('../../src/config.js')` convention that introduces the import-graph topology where Class B TDZ arises (`TEST_BRIDGE_KEY` / `TEST_ADMIN_KEY` consts declared before the `vi.mock` factory that tries to read them at import-graph-evaluation time).
- `agents/docs/solutions/conventions/test-helper-closure-capture-over-arg-threading-2026-05-04.md` — Contains additional `vi.hoisted + await import` examples; subsumed by the Class A discussion in this disambiguation doc.
