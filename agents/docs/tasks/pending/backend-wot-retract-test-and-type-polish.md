# BACKEND-WOT-RETRACT-TEST-AND-TYPE-POLISH — strengthen the single-read regression test, add real-pool coverage for the combined getVouchStatus SELECT, and narrow accreditation_method to a literal union

**Owner:** backend
**Created:** 2026-06-09 (architect review of the wot-retract poll-recount + cascade batch; non-blocking quality items split off so the verified-correct fix could archive)
**Priority:** P2 (the shipped fix is correct; these harden the test pin and the type surface)

## Context

The retract verify+recount collapse (`getVouchStatus` now carries `accreditation_method`; `revokeVoucheeIfBelowThreshold(status)` decides from one snapshot; `query_error` removed) was reviewed and archived as correct. Three quality items were surfaced by `/ce-code-review` and deferred here rather than held, because the core behavior is sound and the property they cover is implicitly pinned elsewhere.

## Items

1. **The no-second-read regression test is vacuous (P2, testing).** In `tests/routes/wot-retract-cascaderevocation.test.ts`, the case asserting `revokeVoucheeIfBelowThreshold` issues NO discovery query of its own passes an **at-threshold** `VouchStatus`, so `shouldRevokeOnRetract` short-circuits to `skipped` before the revoke path is ever reached — the "no recount/cascade query fired" assertion is trivially satisfied. The single-read property (the whole point of the task) is only implicitly covered by the revoke case (which leaves the HAF-query mock unimplemented, so any second query would surface). Fix: drive this assertion with a **below-threshold** WoT status so the function takes the revoke branch, wire the admin-broadcast mock to succeed, and assert that no recount/discovery query fires on that branch. Make the pin non-trivial.

2. **No real-pool test of the combined getVouchStatus SELECT (P2/P3, testing + correctness).** The new SELECT — a `self_method` scalar subquery plus `COALESCE(json_agg(... ) FILTER (...), '[]')` with no `GROUP BY` — is exercised only against a hand-built pool mock. Per `agents/docs/solutions/conventions/test-haf-sql-selection-redirect-cte-from-synthetic-values-2026-06-09.md`, add a FROM-redirect synthetic-`VALUES` test that runs the real SELECT against a real planner and pins: (a) a vouchee with zero accredited vouchers still returns exactly one row with `self_method` populated and `vouches = []` (the aggregate-over-empty-set invariant the retract path must revoke on); (b) the scalar-subquery + bare-aggregate + no-`GROUP BY` shape does not raise; (c) the no-op redirect guard (`expect(redirectedCte).not.toContain(T.customJson)`). The `active-vouches-signer-gate` real-pool test exercises the CTE bodies but not this SELECT shape.

3. **Narrow `accreditation_method` to a literal union (P3, types).** `VouchStatus.accreditation_method` is `string | null`, but `shouldRevokeOnRetract` discriminates it with `=== 'wot'`. Declare `type AccreditationMethod = 'wot' | 'email' | 'orcid' | 'manual'` (matching ARCHITECTURE.md's enumeration) and type the field `AccreditationMethod | null`, casting once at the SQL read site in `getVouchStatus`. This makes the `=== 'wot'` discriminant compiler-visible and forces new methods through an explicit type update. Optional same-file sweep: trim the `getVouchStatus` inline comment that duplicates the race rationale already in `shouldRevokeOnRetract`'s docblock, and add `'manual'` to the non-WoT methods that docblock lists.

## Acceptance

- Item 1: the no-second-read assertion runs the revoke branch (below-threshold WoT status) and fails if a recount/discovery query is reintroduced.
- Item 2: a real-pool FROM-redirect test pins the zero-vouchers one-row invariant and the scalar-subquery+bare-aggregate legality, with the no-op guard.
- Item 3: `accreditation_method` is a literal-union-typed field; `npm run typecheck` clean.
- `npm run typecheck` + `npm run lint` clean; wot suites green.

## Cross-references

- `backend/tests/routes/wot-retract-cascaderevocation.test.ts` (item 1).
- `backend/src/wot.ts` (`getVouchStatus` combined SELECT, `VouchStatus`, `shouldRevokeOnRetract`).
- `agents/docs/solutions/conventions/test-haf-sql-selection-redirect-cte-from-synthetic-values-2026-06-09.md` (item 2 technique).
- Archived parents in `tasks-archive.md`: `BACKEND-WOT-RETRACT-POLL-RECOUNT-SINGLE-READ`, `BACKEND-WOT-RETRACT-CASCADEREVOCATION-WRONG-ACCOUNT`.
