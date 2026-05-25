# Regression-test the retracted-paper required_posting_auths gate + CTE param arithmetic

**Owner:** backend
**Created:** 2026-05-25 (architect, from `/ce-code-review` triage of the retracted-papers cluster — gate-test gap corroborated by security, adversarial, correctness, testing; param-arithmetic gap by testing + kieran-typescript)
**Priority:** P2

## Problem

The retracted-paper forgery gate (`cj.required_posting_auths ? config.hiveAdminAccount`, added across `retractedPapersCteBody`, `loadRetractedPapers`, and `isRetracted`) shipped with **no automated regression test**. It was validated only by a manual live-HAF sanity check, which passed trivially because the pevotest namespace has zero `retract_paper` ops on-chain. A future regression that drops the gate from one site (a JSONB operator typo `?`→`->>`, a dropped second param, or a revert to the single-param CTE form) would silently re-open the forgery vector — anyone could suppress a victim's paper from listings/search — with the full suite still green.

Separately, `retractedPapersCteBody` widened from 1 param / `nextIdx = p+1` to 2 params / `nextIdx = p+2`, but has **no param-arithmetic unit test**. The sibling `authorshipClaimsCteBody` already has a dedicated `describe('authorshipClaimsCteBody param arithmetic')` block (`backend/tests/hafsql.test.ts`) pinning exactly this invariant. A `nextIdx`/`params.length` desync misbinds every downstream `$N` in `buildWith`-composed queries (papers list, search) with no type error and no pg driver throw — and would silently undo the security gate.

## Goal

1. **Behavioral gate coverage.** Add a real-Postgres synthetic-row test (follow the `validReviewWhere behavioral matrix` / `excludeSelfReviewWhere behavioral matrix` pattern in `backend/tests/hafsql.test.ts`) that seeds two `retract_paper` rows for the same paper — one with `required_posting_auths` containing `config.hiveAdminAccount`, one with a non-admin broadcaster — and asserts the admin-authored row IS treated as a retraction while the forged row is NOT. Cover the shared `retractedPapersCteBody` predicate; the inline `loadRetractedPapers` / `isRetracted` copies share the identical predicate, so one CTE-level behavioral test plus the param-arithmetic pin below adequately locks the risk class (a per-site behavioral test for each of the three is acceptable but not required).

2. **Param-arithmetic unit test.** Add a `describe('retractedPapersCteBody param arithmetic')` block mirroring the `authorshipClaimsCteBody` one: assert `startIdx=1` yields `params.length === 2`, `params[0] === config.appTag`, `params[1] === config.hiveAdminAccount`, `nextIdx === 3`; and `startIdx=5` yields `nextIdx === 7`. Pure unit, no pool.

## Acceptance criteria

- A test fails if the `required_posting_auths` gate is removed/weakened at the CTE site (verified by temporarily reverting the predicate locally and seeing red).
- A test fails if `retractedPapersCteBody`'s param count / `nextIdx` desyncs.
- Tests run against real Postgres per the project's no-mock-DB stance (synthetic rows seeded into the real HAF-shaped table, same as the existing behavioral-matrix suites). No new `MOCK_VERIFY_SIGNATURE` usage.
- Comments anchor on stable symbols (no task slugs, round numbers, line numbers, or SHAs).

## Out of scope / dismissed at triage (recorded so they are not re-litigated)

- **Global `buildWith` runtime param-count assertion** (kieran-typescript KT-01): a `frag.params.length === frag.nextIdx - prevIdx` guard inside `buildWith` would catch desync across all CTE builders, but that is a cross-cutting refactor touching every builder, not this cluster. The per-function param-arithmetic test above covers `retractedPapersCteBody` specifically. File separately if the broader guard is wanted.
- The real-path `/retract` test nits (cross-account-spoof spec exercising account-not-found rather than key-mismatch; header overstating replay-cache coverage; `fakeChainAccount` inferred type; dead `OTHER_PRIVATE_KEY` decl) were dismissed as preemptive/cosmetic.

## Related residual risks (no task — context for the implementer)

- **JSONB `?` index path (performance):** `required_posting_auths ? $admin` runs as a post-filter on the `custom_id`-narrowed row set. Negligible today (~15-row namespace) and it does NOT re-introduce the BitmapAnd trap (`?` is not a B-tree predicate). Latent linear cost as retractions accumulate if HAF has no GIN index on `required_posting_auths`. HAF indexes are fixed external infra (cannot be added PEvO-side), so the action — if any — is to confirm the index with the HAF operator or document the threshold, not to add an index.
- **Gate-predicate duplication (maintainability):** the three-conjunct gate predicate is hand-written at three sites. A future widening (singular `?` → plural `?|` if `config.hiveAdminAccount` ever becomes plural) must touch all three and could miss one — the exact bug class the gate itself fixed. A shared SQL-fragment helper or cross-reference comments would reduce that risk; not required for this task.
