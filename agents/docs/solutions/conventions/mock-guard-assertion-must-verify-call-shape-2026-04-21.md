---
title: Mock-guard tests must assert call shape, not just that the mock was called
date: 2026-04-21
category: conventions
module: backend
problem_type: convention
component: testing_framework
severity: medium
applies_when:
  - Writing a Vitest test that uses `mockImplementation` with an `if (predicate) { ...load-bearing assertions... } return fallback` shape
  - The load-bearing assertions (column presence, params index, action-set predicate) live INSIDE the guard
  - A prescribed fix suggests adding `expect(mockFn).toHaveBeenCalled()` as a mutation-kill safeguard
  - The mock's default fallback (e.g. `return { rows: [] }`) produces outputs that satisfy the outer response assertions
tags:
  - testing
  - vitest
  - mock
  - mutation-kill
  - toHaveBeenCalled
  - toHaveBeenCalledWith
  - haf-mock
related_components:
  - authentication
---

# Mock-guard tests must assert call shape, not just that the mock was called

## Context

A common Vitest pattern in this codebase wraps a mock in a predicate guard so the "interesting" assertions run only when the guarded branch fires:

```ts
hafQueryMock.mockImplementation(async (sql: string, params: unknown[]) => {
  if (sql.includes("'action' IN ('accredit', 'revoke')") && sql.includes("'account' = $1")) {
    // Load-bearing assertions INSIDE the guard
    expect(sql).toContain('required_posting_auths ?| $4::text[]');
    expect(params[3]).toEqual(config.accreditationAuthorities);
    return { rows: [{ /* authority-filtered row */ }] };
  }
  return { rows: [] }; // fallback
});
```

This pattern is load-bearing for security regression tests: the inner `expect` calls prove that a SQL refactor has not silently dropped the authority filter. If a future refactor changes the column selection or query shape such that the guard condition becomes false, the mock falls through to the `{ rows: [] }` default. The route handler receives an empty result set, returns `is_accredited: false` + `accreditation: null` (semantically correct for "no authority-signed row"), and the outer assertions pass — while the inner assertions silently never run. A regressed query with no authority filter at all would produce the same green test.

During SEC-AUTH-BYPASS round-3, the architect recognized this trap and prescribed a fix: add `expect(hafQueryMock).toHaveBeenCalled()` after each `request(app)` call. The intent was to prove the mock was invoked so the guarded branch had a chance to fire.

The fix landed at commit `9895fe9` exactly as prescribed. Round-4 `/ce-code-review` (testing + correctness reviewers, converging) confirmed the assertion **does not close the gap**. The mock's fallback path still returns `{ rows: [] }` on every call — so `toHaveBeenCalled()` fires whether or not the guarded branch ever matched. The prescribed fix accepted the default-return path as a "called" state indistinguishable from a genuine hit.

## Guidance

When you add an assertion intended to prove a predicate-gated mock branch actually ran, assert the **call shape**, not just that the mock was invoked:

```ts
expect(hafQueryMock).toHaveBeenCalledWith(
  expect.stringContaining('required_posting_auths ?| $4::text[]'),
  expect.anything(),
);
```

`toHaveBeenCalledWith(expect.stringContaining(<load-bearing-fragment>), expect.anything())` fails if no call matched the expected SQL shape. A refactor that drops the authority filter produces a SQL string without `required_posting_auths ?| $4::text[]`, so the matcher fails even though the mock was called.

Apply the same principle to other guarded-mock patterns:

- ORCID/auth mocks where a `if (username === 'X')` guard gates assertions about request body shape: assert `toHaveBeenCalledWith(expect.objectContaining({ username: 'X', ... }))` rather than `toHaveBeenCalled`.
- Redis mocks where the guard distinguishes lock-key from cache-key: assert `toHaveBeenCalledWith(expect.stringMatching(/^pevotest:orcid_binding_lock:/), ...)`.
- Broadcast mocks that gate on `id === config.appTag`: assert the exact match rather than generic invocation.

If the predicate is complex or call-shape asymmetric, set a flag inside the guarded branch and assert on the flag after the request:

```ts
let guardFired = false;
hafQueryMock.mockImplementation(async (sql, params) => {
  if (sql.includes('<load-bearing>')) {
    guardFired = true;
    // ...inner assertions...
    return { rows: [/* ... */] };
  }
  return { rows: [] };
});

await request(app).get(...);

expect(guardFired).toBe(true);
```

This is structurally equivalent to `toHaveBeenCalledWith` for the matcher case and more flexible when the guard checks multiple arguments or internal state.

## Why This Matters

Security regression tests are the last line of defense against silent mutations. A test that reports green when the authority filter has been removed is worse than no test — it actively mis-reports coverage. The `toHaveBeenCalled` assertion looks like defense-in-depth but provides zero additional kill value when the mock's fallback path satisfies the outer assertions on its own.

Architect-prescribed test fixes are NOT exempt. Round-3 held the task pending this specific assertion addition, the implementer added it verbatim, round-4 re-review caught that the assertion was itself insufficient. Every `toHaveBeenCalled` at a mock-guard site should trigger the question: "does the mock's fallback path also pass the outer assertions?" If yes, escalate to `toHaveBeenCalledWith` or a flag-and-assert pattern.

This also ties back to `test-config-mock-distinct-role-accounts-2026-04-21.md` — both learnings orbit the same root cause: a test that passes for the wrong reason is more dangerous than one that fails. Mock infrastructure must reflect production semantics closely enough that false-green mutations are impossible, not merely unlikely.

## When to Apply

- Every time a `mockImplementation` wraps assertions in a predicate `if` block, with a permissive fallback path below.
- Every time a hold-block prescribes `toHaveBeenCalled` as a mutation-kill addition — promote it to `toHaveBeenCalledWith(matcher, ...)` unless the mock has no fallback path.
- When reviewing existing test files for mutation-kill gaps — grep for `toHaveBeenCalled(` without a matching `toHaveBeenCalledWith(` at mock-guard sites as a starting heuristic.

Known current locations of the vulnerable pattern in this codebase (as of commit `9895fe9`, all gated on `'action' IN ('accredit', 'revoke')` + `'account' = $1`):

- `backend/tests/routes/profile-auth-bypass.test.ts` — 3 specs (rounds 3 and 4)
- `backend/tests/routes/orcid.test.ts` — 2 SEC-AUTH-BYPASS specs (round 3)
- `backend/tests/routes/accreditations-revoke.test.ts` — 1 spec (uses the FROM-signal variant from commit `4dae6a9`)

The `accreditations-revoke.test.ts` file upgraded its predicate from `'account' = $1` to `FROM hafsql.operation_custom_json_view`, which shifts the refactor-sensitivity but does not by itself close the fallback-path gap. Apply the `toHaveBeenCalledWith` promotion across all of these sites in one sweep rather than site-by-site.

**Swept in commit `16b977e` (BE-MOCK-GUARD-ASSERTION-SWEEP):** the 3 `profile-auth-bypass.test.ts` specs, the 1 `accreditations-revoke.test.ts` spec (FROM-signal variant), and 5 SEC-002-BE / SEC-002-HARDENING sites in `orcid.test.ts` now use `toHaveBeenCalledWith(expect.stringContaining(<load-bearing-fragment>), expect.arrayContaining([<params>]))`. The 3 BE-ORCID-ID-FORMAT-VALIDATION sites in `orcid.test.ts` use the inverse `not.toHaveBeenCalled()` check (no mock-guard — the mock is never reached on the rejection path) and do not need promotion. The SEC-002-TOCTOU-LOCK `describe.each` block in `orcid.test.ts` reuses a shared helper mock and was out of scope for this sweep.

**Follow-up gap closure (BE-MOCK-GUARD-SEC-AUTH-BYPASS-SITES-PROMOTE):** the final 2 SEC-AUTH-BYPASS sites in `orcid.test.ts` (the link-mode 422 "self-broadcast fake accredit" spec and the link-mode 200 "authority-signed accredit" spec) were promoted in a follow-up commit. Both now use `toHaveBeenCalledWith(expect.stringContaining("'action' IN ('accredit', 'revoke')"), expect.arrayContaining([<account>, config.accreditationAuthorities]))` plus a positional pin on `params[3]` (via a `mock.calls.find(...)` lookup) so an order-swap mutant that moves authorities off of `$4` fails loudly. The in-mock-guard `expect(sql).toContain(...)` / `expect(params[3]).toEqual(...)` assertions moved out of the guard body to the caller, matching the sweep pattern applied in commit `16b977e`.

## Examples

**Before (load-bearing assertion masked by fallback):**

```ts
hafQueryMock.mockImplementation(async (sql, params) => {
  if (sql.includes("'action' IN ('accredit', 'revoke')") && sql.includes("'account' = $1")) {
    expect(sql).toContain('required_posting_auths ?| $4::text[]');
    expect(params[3]).toEqual(config.accreditationAuthorities);
    return { rows: [/* ... */] };
  }
  return { rows: [] };
});

const res = await request(app).get(`/api/profile/${victim}`);
expect(res.body.data.is_accredited).toBe(false);
expect(res.body.data.accreditation).toBeNull();
expect(hafQueryMock).toHaveBeenCalled(); // passes even if guard never fires
```

**After (call shape enforced):**

```ts
hafQueryMock.mockImplementation(async (sql, params) => {
  if (sql.includes("'action' IN ('accredit', 'revoke')") && sql.includes("'account' = $1")) {
    return { rows: [/* ... */] };
  }
  return { rows: [] };
});

const res = await request(app).get(`/api/profile/${victim}`);
expect(res.body.data.is_accredited).toBe(false);
expect(res.body.data.accreditation).toBeNull();
expect(hafQueryMock).toHaveBeenCalledWith(
  expect.stringContaining('required_posting_auths ?| $4::text[]'),
  expect.arrayContaining([config.accreditationAuthorities]),
);
```

The load-bearing SQL-column and params-index checks move OUT of the mock body and onto the caller's assertion — which fires only when a matching call actually happened. The mock becomes a simple response-shape harness; the mutation-kill value lives in the post-call `expect`.
