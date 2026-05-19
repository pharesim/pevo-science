---
title: Test fixture mocking a middleware that writes augmented Request fields — narrow `req` to `Pick<Request, ...>`, not `Record<string, unknown>`
date: 2026-05-19
category: conventions
module: backend
problem_type: convention
component: testing_framework
severity: medium
applies_when:
  - Writing a test fixture that mocks an Express middleware which assigns fields declared in a global `Express.Request` augmentation
  - Adding a new field to an `Express.Request` augmentation and updating the corresponding fixture to set the new field
  - Reviewing a middleware-mock fixture whose `req` parameter is currently typed `Record<string, unknown>`, `object`, `any`, or has no annotation
  - The fixture is invoked via `vi.mock(...)` module replacement (Express passes a real `Request` at runtime; no test constructs a synthetic `req` for this fixture)
tags:
  - typescript
  - test-fixtures
  - express-augmentation
  - middleware-mocking
  - type-narrowing
  - convention
related_components:
  - testing_framework
  - authentication
---

## Context

PEvO has multiple test fixtures that mock Express middleware via `vi.mock(...)` module replacement. The canonical example is `backend/tests/fixtures/mock-auth.ts`, which mocks `verifyHiveSignature` and writes augmented `Request` fields (`req.hiveUsername`, `req.hiveCustody`, `req.hiveAuthMethod`) to mirror production semantics. The reflex type for the fixture's `req` parameter is `Record<string, unknown>` because tests sometimes construct synthetic request objects. For middleware-mock fixtures specifically, that reflex is wrong: the fixture is invoked by Express at runtime with a real `Request`, so no test constructs a synthetic `req`. The practical consequence of `Record<string, unknown>` is that the fixture silently diverges from the global `Express.Request` augmentation. A new field added to the augmentation (e.g., `hiveAuthMethod: 'jwt' | 'signature'`) compiles cleanly in the fixture whether the value is `'jwt'`, `'jw'`, or `'admin'`. Every test consuming the fixture then pins behavior against a value that production code can never produce.

Concrete incident: `backend/tests/fixtures/mock-auth.ts` originally typed its `req` parameter as `Record<string, unknown>`. When `req.hiveAuthMethod: 'jwt' | 'signature'` was added to the global `Express.Request` augmentation in `backend/src/middleware/verifyHiveSignature.ts`, the fixture's new assignment `req.hiveAuthMethod = '...'` passed typecheck regardless of the assigned value. The kieran-typescript reviewer surfaced this during round-2 architect re-review of `backend-verifyhive-authmethod-discriminator`. Round-3 fix at commit `5fc0cae` narrowed the parameter to `Pick<Request, 'hiveUsername' | 'hiveCustody' | 'hiveAuthMethod' | 'headers'>`, restoring union enforcement at the write sites.

## Guidance

Type the fixture's `req` parameter as `Pick<Request, 'fieldA' | 'fieldB' | ...>` where the named fields are exactly:

- Every augmented field the fixture writes (e.g., `hiveUsername`, `hiveCustody`, `hiveAuthMethod`).
- Every standard `Request` field the fixture reads (typically `headers`).

Add `import type { Request } from 'express'` at the top of the fixture file. The `type`-only modifier means no runtime cost.

**Before (unsafe):**

```typescript
export const MOCK_VERIFY_SIGNATURE = {
  verifyHiveSignature: (req: Record<string, unknown>, _res: unknown, next: () => void) => {
    const headers = req.headers as Record<string, string> | undefined;
    const username = headers?.['x-hive-username'];
    if (!username) {
      const res = _res as { status: (n: number) => { json: (b: unknown) => void } };
      return res.status(401).json({
        status: 'error',
        error: { code: 'UNAUTHORIZED', message: '...' },
      });
    }
    req.hiveUsername = username;                   // compiles with any string — no union enforcement
    req.hiveCustody = decodeJwtCustodyClaim(...);  // 'lite' typo would also compile
    req.hiveAuthMethod = 'jwt';                    // 'admin' or 42 would also compile
    next();
  },
};
```

**After (safe):**

```typescript
import type { Request } from 'express';

export const MOCK_VERIFY_SIGNATURE = {
  verifyHiveSignature: (
    req: Pick<Request, 'hiveUsername' | 'hiveCustody' | 'hiveAuthMethod' | 'headers'>,
    _res: unknown,
    next: () => void,
  ) => {
    const headers = req.headers as Record<string, string> | undefined;
    const username = headers?.['x-hive-username'];
    if (!username) {
      const res = _res as { status: (n: number) => { json: (b: unknown) => void } };
      return res.status(401).json({
        status: 'error',
        error: { code: 'UNAUTHORIZED', message: '...' },
      });
    }
    req.hiveUsername = username;
    req.hiveCustody = decodeJwtCustodyClaim(headers?.authorization);
    req.hiveAuthMethod = headers?.authorization?.startsWith('Bearer ') ? 'jwt' : 'signature';
    // req.hiveAuthMethod = 'admin'; // TS error — 'admin' not assignable to 'jwt' | 'signature'
    next();
  },
};
```

The test tsconfig at `backend/tests/tsconfig.json` already includes `../src`, so the global `Express.Request` augmentation (declared in `backend/src/middleware/verifyHiveSignature.ts`) is in scope during `typecheck:tests`. No tsconfig change is needed for the narrowing to take effect.

## Why This Matters

`Record<string, unknown>` is not `any`, but for write sites it is functionally equivalent: every `req.x = value` satisfies `unknown` regardless of what the global augmentation actually declares `x` to be. The fixture is supposed to mirror the middleware's production semantics so that tests which depend on the fixture pin production-compatible behavior. When the fixture's type is weaker than the augmentation, the mirror breaks silently at typecheck time — tests pass the compiler but exercise a value set the production middleware can never produce. A future maintainer who adds a third member to the union (or makes a typo at the assignment site) gets no compile-time signal; the regression surfaces only when an integration test or live request reveals the mismatch.

`Pick<Request, ...>` opts the fixture into the same compiler perimeter as production code. A future augmentation change (new field added, union narrowed, field removed) immediately surfaces a fixture compilation error, which is the right failure mode: fix the fixture to match the new production semantics, then update any tests that depended on the old value.

This sits alongside `discipline-interface-tsc-perimeter-omission-2026-05-11.md`, which addresses a different mechanism for the same family of failures — TypeScript discipline silently defeated for test consumers. That convention covers the structural case (test directory outside the tsc include perimeter); this one covers the intra-perimeter case (parameter type widened so the perimeter has nothing to enforce against).

## When to Apply

- Writing or editing any test fixture that mocks Express middleware via `vi.mock(...)` module replacement.
- The middleware being mocked writes one or more fields declared in a global `Express.Request` augmentation (e.g., `req.hiveUsername`, `req.hiveCustody`, `req.hiveAuthMethod`, future `req.correlationId`, `req.user`, etc.).
- Reviewing a fixture whose `req` parameter is currently typed `Record<string, unknown>`, `object`, `any`, or has no annotation, AND the fixture assigns augmented fields.
- During architect re-review of a hold-block item that adds or modifies an augmented `Request` field — verify the corresponding mock fixture's parameter type also covers the field.

Do NOT apply to fixtures whose `req` is genuinely synthetic — test helpers that build request objects from scratch for unit tests without `vi.mock(...)` module replacement may legitimately need a broader type. The narrowing rule applies specifically to fixtures invoked by Express at runtime.

## Examples

**Identifying the unsafe pattern:** the `req` parameter of a middleware-mock function (typically named like `MOCK_*` or `mock*Middleware`) is typed as `Record<string, unknown>`, `object`, `any`, or lacks an explicit annotation. The fixture body contains assignments to augmented fields like `req.hiveAuthMethod = '...'` whose value-shape is not checked against the augmentation's declared union.

**Applying the fix:**

1. Add `import type { Request } from 'express';` at the top of the fixture file.
2. Replace `req: Record<string, unknown>` with `req: Pick<Request, 'fieldA' | 'fieldB' | ...>`, where the named fields are exactly the augmented fields the fixture writes plus any standard `Request` fields it reads.
3. Remove any `as Record<string, string>` casts on `req` itself that were compensating for the weak type (casts on sub-fields like `req.headers as Record<string, string>` remain — `req.headers` is `IncomingHttpHeaders` on `Request`, which is itself a broad type).
4. Run `npm run typecheck:tests` (or an isolated `tsc` probe on the fixture file with a deliberately invalid value) and confirm that assigning an out-of-union value produces a TS error.

**Choosing among alternatives:**

| Type | Verdict |
|---|---|
| `Record<string, unknown>` | Unsafe — bypasses union enforcement on writes |
| `any` | Unsafe — bypasses all type checking |
| `Partial<Request>` | Over-broad — exposes ~50+ optional fields unnecessarily |
| Full `Request` | Acceptable but invites the fixture to read fields it doesn't actually need |
| `Pick<Request, 'fieldA' \| ...>` | Correct — exactly the surface the fixture touches |

## Cross-references

- `agents/docs/solutions/conventions/discipline-interface-tsc-perimeter-omission-2026-05-11.md` — same family of failures (TypeScript discipline silently defeated for test consumers), different mechanism (perimeter exclusion vs. intra-perimeter type widening).
- `agents/docs/solutions/conventions/test-seams-export-shape-as-const-2026-05-04.md` — sibling convention on test-only export typing discipline (`as const` for readonly export shapes); this convention covers the parallel concern for fixture parameter typing.
- `agents/docs/solutions/conventions/test-mock-carve-out-clause-c-2026-05-04.md` — the test-mock carve-out convention that authorizes using `MOCK_VERIFY_SIGNATURE` in the first place; this convention extends its guidance with a concrete typing rule for the mock function's parameter.
- `backend/tests/fixtures/mock-auth.ts` — the canonical fixture using the correct `Pick<Request, ...>` shape.
- `backend/src/middleware/verifyHiveSignature.ts` — the production middleware containing the global `Express.Request` augmentation that the fixture mirrors.
