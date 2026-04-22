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

## Architect re-review (2026-04-22) — HELD PENDING FIXES:

Code-reviewed via `/ce-code-review` on commit `16b977e`. The 9 named sites (3 profile-auth-bypass, 1 accreditations-revoke, 5 orcid.test.ts SEC-002-BE) were consolidated. Solutions doc `mock-guard-assertion-must-verify-call-shape-2026-04-21.md` was updated in sibling commit `42fc1a9`. The following items block archive because the promotion traded one mutation-kill gap for another at 5 sites:

1. **Restore positional pinning on the 3 `profile-auth-bypass.test.ts` sites (lines 77, 113, 163).** The old pattern asserted `expect(params[3]).toEqual(config.accreditationAuthorities)` (positionally exact: authorities at `$4` bind position). The promoted form `expect.arrayContaining([victim, config.accreditationAuthorities])` is order-agnostic — a mutant moving `accreditationAuthorities` from `$4` to `$2` passes the matcher. The SQL-fragment arm still kills dropped-filter mutations, but the `accreditationAuthorities` param is the entire authority-allowlist and must be pinned. Add a positional assertion alongside the existing `arrayContaining` call:

   ```ts
   expect(hafQueryMock).toHaveBeenCalledWith(
     expect.stringContaining(<existing-fragment>),
     expect.arrayContaining([victim, config.accreditationAuthorities]),
   );
   expect(hafQueryMock.mock.calls[0][1][3]).toEqual(config.accreditationAuthorities);
   ```

   Or switch to the flag-and-assert pattern per the solutions doc if cleaner. Do this at all 3 sites. (testing 0.85, correctness 0.73 — 2-reviewer agreement.)

2. **Swap `expect.anything()` → `expect.arrayContaining([<load-bearing-value>])` at 2 `orcid.test.ts` sites.** Internal sweep inconsistency: sibling sites in the same file correctly use `arrayContaining([orcidId])`, but these 2 sites regressed to `expect.anything()`.
   - `orcid.test.ts:~218` (link-success broadcast test): use `expect.arrayContaining([orcidId])` on the `'orcid' = $1` call.
   - `orcid.test.ts:432` (link mode `ORCID_ALREADY_LINKED`): the `'action' IN ('accredit', 'revoke')` query fires twice in this path (once for alice's `getExistingAccreditation`, once for bob's binding-liveness check). 409 detection depends on bob's liveness return, so the load-bearing call is bob's. Use `expect.arrayContaining(['bob'])` on that assertion; optionally add a second `toHaveBeenCalledWith` pinning alice's call if both calls need coverage.

3. **While you're in `profile-auth-bypass.test.ts`, drop the dead `params: unknown[]` parameters** in the 3 `mockImplementation((sql: string, params: unknown[]) => { ... })` callbacks at lines 77, 113, 163 — after the sweep moved assertions out of the mock guards, `params` is referenced nowhere in the body. Matches the sibling `accreditations-revoke.test.ts` shape which uses `(sql: string)` only. Pure dead-code removal; no behavior change.

Deferred / dismissed during triage (no action required on this task):
- Pre-existing 2 SEC-AUTH-BYPASS sites at `orcid.test.ts:322, 382` still on bare `toHaveBeenCalled()` — filed as `agents/docs/tasks/pending/backend-mock-guard-sec-auth-bypass-sites-promote.md`.
- Repeated inline SQL fragments (5x each) extractable to named constants — dismissed to keep hold scope tight; SQL predicates are stable and rename-breakage is grep-fixable.
