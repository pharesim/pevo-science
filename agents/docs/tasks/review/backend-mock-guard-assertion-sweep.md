# BE-MOCK-GUARD-ASSERTION-SWEEP — Promote `toHaveBeenCalled()` to `toHaveBeenCalledWith(matcher, ...)` at predicate-gated mock sites

**Owner:** backend
**Created:** 2026-04-21 (surfaced by SEC-AUTH-BYPASS round-4 re-review 2026-04-21)
**Priority:** P3

## Context

`agents/docs/solutions/conventions/mock-guard-assertion-must-verify-call-shape-2026-04-21.md` documents a testing convention surfaced during SEC-AUTH-BYPASS round-4. Summary: when a Vitest `mockImplementation` wraps load-bearing assertions inside an `if (predicate)` block with a permissive fallback (`return { rows: [] }` or similar), `expect(mockFn).toHaveBeenCalled()` is **not** a mutation-kill safeguard — the mock's fallback path satisfies the assertion even when the guarded branch never fires. The correct form is `toHaveBeenCalledWith(expect.stringContaining(<load-bearing-fragment>), expect.anything())` or a flag-and-assert pattern.

SEC-AUTH-BYPASS's hold-block fix landed the promotion at 5 sites (see that task's round-4 hold). This task sweeps the remaining sibling sites that use the same weaker pattern.

## Known sites to promote

As of commit `9895fe9`, these files use predicate-gated mocks where the load-bearing assertions live inside the guard and the fallback silently passes the outer check:

- `backend/tests/routes/orcid.test.ts` — multiple SEC-002-BE and SEC-AUTH-BYPASS sites; round-4 hold covers the 2 SEC-AUTH-BYPASS sites; the ~5-7 SEC-002-BE sites remain on the weaker pattern.
- `backend/tests/routes/profile-auth-bypass.test.ts` — 3 sites (covered by SEC-AUTH-BYPASS round-4 hold).
- `backend/tests/routes/accreditations-revoke.test.ts` — 1 spec (uses the FROM-signal variant from commit `4dae6a9`; still has the fallback-path gap even though the predicate is stronger).

Grep for `toHaveBeenCalled()` without a paired `toHaveBeenCalledWith` in the same spec as a starting heuristic. Filter out cases where no predicate guard exists (those are legitimate uses of the existence check).

## Goal

Audit every `hafQueryMock` / `broadcastJsonMock` / `redis.set` / `redis.get` / `verifyHiveSignature` mock-assertion site. For each site that:

1. Uses `mockImplementation` with a predicate-gated `if` block,
2. Has a permissive fallback path (`return { rows: [] }`, `return null`, etc.) that satisfies the outer test assertions,
3. Asserts `toHaveBeenCalled()` as its mutation-kill safeguard,

...promote the assertion to one of:

- `toHaveBeenCalledWith(expect.stringContaining('<load-bearing-SQL-fragment>'), expect.anything())` — when the guard's distinguishing signal is a SQL substring.
- `toHaveBeenCalledWith(expect.objectContaining({ <load-bearing-key>: ... }), expect.anything())` — when the guard is an object-shape match.
- A `let guardFired = false; mockImpl(...) { if (...) { guardFired = true; ... } }` + `expect(guardFired).toBe(true)` — when the guard is complex or checks multiple arguments.

## Non-goals

Changing the guard conditions themselves. Refactoring the mock structure. Adding new assertions beyond the promotion.

Running the broader test file audit that surfaces additional classes of weak mocks (e.g. `.mockResolvedValue` without return-value assertions). Keep scope tight to the `toHaveBeenCalled` → `toHaveBeenCalledWith` promotion.

## Acceptance

- Every promoted site has a matcher that would fail if the guard's distinguishing signal were dropped.
- No test timing or stability regressions (matchers run in the same millisecond as existence checks).
- Full backend vitest suite still passes.
- A follow-up line in the learning doc noting "swept in commit `<sha>`" so future readers know the codebase is consistent.

## [TODO Architect]

None — self-contained test-hygiene pass. Architect reviews at archive time.
