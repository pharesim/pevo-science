# BE-MOCK-GUARD-SEC-AUTH-BYPASS-SITES-PROMOTE — Promote the final 2 SEC-AUTH-BYPASS mock-guard sites in `orcid.test.ts`

**Owner:** backend
**Created:** 2026-04-22 (surfaced by BE-MOCK-GUARD-ASSERTION-SWEEP code-review 2026-04-22)
**Priority:** P3

## Context

`agents/docs/solutions/conventions/mock-guard-assertion-must-verify-call-shape-2026-04-21.md` documents the promotion convention: predicate-gated mocks with permissive fallbacks must assert call-shape via `toHaveBeenCalledWith(expect.stringContaining(<fragment>), ...)` or flag-and-assert, not bare `toHaveBeenCalled()`.

The sweep (`16b977e`) consolidated 9 sites across 3 files but explicitly left 2 SEC-AUTH-BYPASS sites in `orcid.test.ts` out of scope — they were attributed to SEC-AUTH-BYPASS ownership at the time of the original promotion pass. The convention doc at line 111 still flags them as the remaining gap.

Known sites to promote:

- `backend/tests/routes/orcid.test.ts:322` — load-bearing `expect(sql).toContain(...)` + `expect(params[3]).toEqual(authorities)` inside mock guard; bare `expect(hafQueryMock).toHaveBeenCalled()` outside.
- `backend/tests/routes/orcid.test.ts:382` — same pattern.

Both retain the dangerous hybrid: if a SQL refactor changes the `action IN` predicate shape so the guard's `if` stops matching, the in-guard authority-filter asserts silently stop running while the outer bare check still passes. This is the exact failure mode the convention targets.

## Goal

Promote both sites using the solutions doc's prescribed shape:

```ts
expect(hafQueryMock).toHaveBeenCalledWith(
  expect.stringContaining("'action' IN ('accredit', 'revoke')"),
  expect.arrayContaining([victim, config.accreditationAuthorities]),
);
// Plus a positional check that authorities lives at the expected $N bind
// position, since arrayContaining alone allows positional swap mutants:
expect(hafQueryMock.mock.calls[0][1][3]).toEqual(config.accreditationAuthorities);
```

Or the flag-and-assert variant if the guard predicate is too complex for a single matcher — see solutions doc for examples.

## Non-goals

Changing the SEC-AUTH-BYPASS guard's assertion semantics. Refactoring the describe-block structure. This is a 2-site promotion, nothing else.

## Acceptance

- Both sites pass `toHaveBeenCalledWith(expect.stringContaining(...), expect.arrayContaining([...]))` + a positional pinning assertion on `params[3]` (or equivalent flag-and-assert).
- Solutions doc `mock-guard-assertion-must-verify-call-shape-2026-04-21.md` is updated to reflect the gap-closure (remove/update the "remaining gap" entry at line 111).
- Full backend vitest suite passes.

## [TODO Architect]

None — self-contained test-assertion promotion.
