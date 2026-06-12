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

---

## Backend completion note (2026-06-09, commit `e2e562ac`)

All three items landed.

- **Item 1:** the no-second-read pin now drives a BELOW-threshold WoT status so `revokeVoucheeIfBelowThreshold` takes the revoke branch (admin broadcast wired to succeed), asserts `outcome: 'revoked'` plus one broadcast, and asserts no recount/discovery query fires on that branch. The pin is now non-trivial (fails red if a second read is reintroduced).
- **Item 2:** the inline `getVouchStatus` SELECT was extracted to an exported `vouchStatusSelect(usernameParam)` builder (production SQL byte-identical, single source). New real-pool FROM-redirect test (`wot-vouch-status-select-real-postgres.test.ts`) runs it against a live planner: a zero-accredited-vouchers vouchee returns exactly one row with `self_method` populated and `vouches = []`; the scalar-subquery + bare-aggregate + no-`GROUP BY` shape does not raise; no-op redirect guard. Carve-out clauses documented in the header.
- **Item 3:** `accreditation_method` narrowed to `AccreditationMethod = 'wot' | 'email' | 'orcid' | 'manual'` (cast once at the SQL read site), making the `=== 'wot'` discriminant compiler-visible; optional sweep done (trimmed the duplicated race-rationale comment, added `'manual'` to the docblock's non-WoT list).

**Verification (main checkout, real Postgres):** typecheck (src+tests) + lint clean; `wot-retract-cascaderevocation.test.ts` plus `wot-vouch-status-select-real-postgres.test.ts` 26/26 green.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>

---

## Architect re-review (2026-06-12) — HELD PENDING FIXES (1 item)

`/ce-code-review` fan-out on commit `e2e562ac` (correctness + adversarial on the session model; testing/maintainability/project-standards + learnings on Sonnet; ce-agent-native skipped per PEvO). **All three task items are VERIFIED LANDED and SOUND**: the extracted `vouchStatusSelect` output is byte-identical to the pre-extraction inline SELECT (programmatically reconstructed and compared, whitespace included); the no-second-read pin genuinely reaches the revoke branch (2 vouchers below threshold 3, traced through `revokeVoucheeIfBelowThreshold`) and `expect(hafQueryMock).not.toHaveBeenCalled()` fails red on any reintroduced pool.query read; the FROM-redirect test imports the production builder single-source, rewrites only the two schema-qualified FROM targets, and fires the no-op guard before the behavioral assertions per the convention entry; the literal-union cast degrades safely (an off-union method string falls through `=== 'wot'` to non-revocable, identical to pre-commit) and the members match ARCHITECTURE.md's enumeration exactly; carve-out headers and comment anchors clean. One item before archive (user-triaged):

1. (P2; correctness + maintainability corroborated, conf 100) **`AccreditationMethod` is now declared twice.** `wot.ts` declares its own union while `types/domain.ts` already exports the canonical, member-identical one (consumed by `types/hive.ts`). Two sources of truth: a future fifth method added to one declaration silently diverges from the other, and the wot.ts copy is what the `=== 'wot'` revocation discriminant and the test import see. Single-source it: delete the wot.ts declaration and re-export the domain type (`export type { AccreditationMethod } from './types/domain.js';` keeps the test's existing import path valid). Invariant: one declaration owns the method enumeration.

Dismissed at triage (recorded, no action): the `'manual'` union member having no dedicated non-revoke spec (structurally covered by the `=== 'wot'` predicate); the `usernameParam` bare-string signature hardening (template-literal type); the route-level total-query-count pin and the off-union degradation spec — all below the action bar per the preemptive-hardening posture.

When the item lands, `git mv` this file back to `tasks/review/`; the move is the re-review signal, scoped to the fix commit. Do not edit this hold block — the commit diff is the evidence; the architect updates it at re-review.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
