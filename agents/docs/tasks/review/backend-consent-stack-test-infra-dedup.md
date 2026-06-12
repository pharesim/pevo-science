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

---

## Implementation note (backend, 2026-06-12)

Both goals landed in a single commit.

**Composer (`consentStackCteBody(startIdx, scope?)`, hafsql.ts):** composes `consentSeedCteBody` → `consentChainCteBody({rootsFromCte: 'consent_seed'})` → `consentedAuthorsCteBody` as one builder, byte-equivalent to the sequential 3-tuple: the internal `', '` joiner matches `buildWith`'s CTE separator, and param order plus `nextIdx` are unchanged, so no SQL emission changes anywhere. One scope value fans out to the members that consume it: `{signer}` (seed signer + `{signers:[signer]}` narrowing), `{papers}` (seed only; resolution unscoped; empty list keeps the seed's FALSE backstop), omitted (fully unscoped). All seven 3-tuple sites migrated: papers listing + `batchResolveVotes`, reviews single-fetch, profile (stats + reviews data), search, stats. Custom-seed compositions (reputation cycle's batch-activity seed, me.ts `pending_seed`, the per-paper badge/detail chain scopes) keep direct `consentChainCteBody` + `consentedAuthorsCteBody` composition by design; the composer docblock says so. Equivalence is pinned per scope shape in `hafsql.test.ts` by deep-equality of the full fragment through the real `buildRecursiveWith` pipeline (composer vs explicit 3-tuple).

**Redirect helper (`redirectHafViews(stmt, mapping)`, tests/support/haf-query.ts):** promotes the `me-pending-authorships-real-postgres` local `redirect()`; mapping keys are `T` member names (imported as `HAF_VIEWS` since the file's generics use `T` as a type parameter), per-mapped-literal drift guard inside the helper. All four named files migrated. Guard semantics preserved per file: the behavioral cycle file keeps its per-literal-only rationale (a bare `hafsql.` scan would trip on SQL comments naming files) as a site comment; `reputation-coauthor-claim-credit` and the two `consented-authors-cte` sites that carried the stricter whole-schema `not.toContain('hafsql.')` guard keep it at the call site on top of the helper's per-literal guards. The consented-authors seeded-equivalence test now composes via `consentStackCteBody`, exercising the production composer on real Postgres.

**Simplify pass fold-in:** `profile-reviews-accred-gate.test.ts`'s live param-slot derivation migrated to the composer too — its own docblock mandates mirroring the route's composition list, which changed in this commit. Out-of-scope inline redirect sites with structurally different shapes (the two signer-gate fragment splicers, the wot aliased-literal redirects, the names-loader single-literal site) were reviewed and intentionally left.

**Verification:** `npm run typecheck` (src+tests) clean; `npm run lint` clean except the known pre-existing `author-supersession.ts` warning. Battery green (11 files, 102 passed / 4 known data-dependent skips): both cycle-shape pins, both display-exclusion canaries, `display-consented-self-dealing-exclusion`, `consented-authors-cte-real-postgres`, `me-pending-authorships-real-postgres`, behavioral cycle canary, `reputation-coauthor-claim-credit`, `profile-reviews-accred-gate`, `hafsql`. Live-HAF: `papers`/`profile`/`search` route suites 60 passed / 1 skipped; `reviews.test.ts`'s 2 SQL-accreditation-gate failures re-confirmed pre-existing this session by stash-reverting the working tree and re-running (same 2 fail unmodified).

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
