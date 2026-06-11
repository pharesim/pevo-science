# BACKEND-CONSENT-STACK-TEST-INFRA-DEDUP — shared FROM-redirect helper + consent-stack composer

**Owner:** backend
**Created:** 2026-06-12 (architect `/ce-code-review` of the consent cluster; maintainability findings across two reviews; user-elected at triage)
**Priority:** P3 (behavior-preserving consolidation; no defect — the claimed/consented gate counts are verified in sync at every site today)

## Problem

Two duplication shapes accreted across the consent-stack work:

1. **FROM-redirect boilerplate.** The `sql.split(T.x).join('syn_x')` view-redirect pattern is inlined in four test files (`reputation-consented-credit-cycle-behavioral.test.ts`, `routes/reputation-coauthor-claim-credit.test.ts`, `consented-authors-cte-real-postgres.test.ts` at two sites, and `me-pending-authorships-real-postgres.test.ts`, which already wraps it in a local `redirect()` helper). Each file redirects a different view subset, so a shared helper needs a small mapping parameter.
2. **Consent-stack 3-tuple.** `consentSeedCteBody` + `consentChainCteBody` + `consentedAuthorsCteBody` are composed together at roughly nine production call sites (~21 lines of repeated lambda boilerplate across papers/reviews/profile/search/stats/me), and the compose-both-exclusion-helpers discipline rests on two separate count canaries plus docblock prose.

## Goal

- A parameterized `redirectHafViews(stmt, mapping)` helper in `backend/tests/support/haf-query.ts` (promote the `me-pending-authorships-real-postgres` local helper; preserve each file's redirect no-op guard). Migrate the four files.
- A `consentStackCteBody(startIdx, scope?)` composer in `hafsql.ts` collapsing the 3-tuple at the production sites (behavior-preserving; the existing cycle-shape pins, hafsql param-arithmetic tests, and real-postgres suites are the regression net).

## Acceptance

- No SQL emission change: cycle-shape pins, hafsql param-arithmetic tests, both display-exclusion canaries, and the real-postgres suites stay green, modified only where they import the new helpers.
- Redirect no-op guards preserved per file.
- `npm run typecheck` + `npm run lint` clean; comment anchors on stable symbols.

## Cross-references

- `backend/tests/support/haf-query.ts`, `backend/src/hafsql.ts` (`consentSeedCteBody`, `consentChainCteBody`, `consentedAuthorsCteBody`, `excludeConsentedSelfWhere`, `excludeClaimedSelfWhere`).
- Parents: `backend-implement-consented-authorship-model`, `backend-consented-set-display-self-dealing-exclusion`.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
