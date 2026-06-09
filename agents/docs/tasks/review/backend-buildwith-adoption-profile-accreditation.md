# BACKEND-BUILDWITH-ADOPTION-PROFILE-ACCREDITATION — convert remaining manual `WITH ${body.sql}` spellings to buildWith

**Owner:** backend
**Created:** 2026-06-05 (spun off from the activeaccreditations-wrapper-dedup review; pre-existing finding, P3)
**Priority:** P3

## Problem

The wrapper-dedup task removed the third spelling of the single-CTE WITH builder, but two files still hand-roll the template: `backend/src/routes/profile.ts` (three sites) and `backend/src/accreditation.ts` (one site) interpolate `WITH ${body.sql}` manually instead of calling `buildWith(1, body)`. Hand-rolled spellings resist grep-based convention sweeps and can drift from buildWith's params/nextIdx contract.

## Goal

Convert the four manual sites to `buildWith`. Do NOT touch the `WITH RECURSIVE` query in the comments path — `buildWith` does not emit the `RECURSIVE` keyword.

## Acceptance

- The four sites use `buildWith`; emitted SQL, params, and nextIdx are identical to pre-change (same equivalence class as the archived wrapper-dedup conversion: single-builder `buildWith` emits `WITH ${body.sql}` verbatim).
- A grep for manual `WITH ${` template spellings over `backend/src` finds no remaining non-RECURSIVE single-CTE uses.
- Comment anchors clean.
- `npm run typecheck` + `npm run lint` clean.

## Cross-references

- `backend/src/hafsql.ts` (`buildWith`), `backend/src/routes/profile.ts`, `backend/src/accreditation.ts`.
- Same dedup class as the archived `BACKEND-ACTIVEACCREDITATIONS-WRAPPER-DEDUP` (see `agents/docs/tasks-archive.md`).

## Architect re-review (2026-06-09) — HELD PENDING FIXES

`/ce-code-review` fan-out (correctness on Opus; maintainability, project-standards, testing, kieran-typescript on Sonnet) on the buildWith-adoption commit. The conversions that landed are **byte-equivalent and correct** — correctness traced the single-builder emission (`WITH ` prefix moved into `buildWith`), the `, ` multi-builder join separator, nextIdx threading, and the param order for the two-builder `getAllEverAccreditedOrcidsWithStatus` site; kieran-ts clean; the `getProfileStats` exclusion is sound. One item blocks archive:

1. **Acceptance #2 (global grep clean) is not met.** `grep -rnE 'WITH \$\{' backend/src --include=*.ts` after the commit still returns single-CTE non-RECURSIVE sites that are neither converted nor documented as excluded. The completion note documents ONLY `getProfileStats`. Enumerate every remaining `WITH ${` site in the out-of-scope note with its reason, and convert the ones that convert byte-identically:
   - `routes/papers.ts` (paper-detail query, `WITH ${detailCte.sql}`): single-CTE, but the CTE params are bound AFTER the outer query's author/permlink/bridge params — a byte-identical `buildWith` adoption requires restructuring the bind array (CTE params first) and updating the param-layout comment + any canary. Either convert with that restructure, or document the param-ordering reason for excluding it.
   - `lib/ipfs-shared.ts` (`accred ? `WITH ${accred.sql}` : ''`): conditional collapse-to-empty. `buildWith` always emits `WITH …`, so it cannot express the empty branch — document as a structural exclusion.
   - `notification-queries.ts` (`WITH ${accredCte.sql}, …`): multi-CTE mixed-inline, same class as `getProfileStats` — document as excluded.
   Minimum bar: the scope note enumerates every remaining `WITH ${` site with a reason, so the next convention sweep neither re-flags them nor converts them incorrectly. Converting `papers.ts` is encouraged if the bind-array restructure + canary update is clean; the other two are documentation-only.

**Considered and DISMISSED (do not action):**
- No dedicated `buildWith` unit test pinning single-builder emission / `, ` multi-builder join / nextIdx threading, and no SQL-shape pin on the two-builder accreditation site. Partially mitigated by the `authorshipClaimsCteBody` param-arithmetic pins added in the reputation-claims dedup commit; not worth a standalone test task now.
- The `// $1, $2, $3` inline positional comment in `profile.ts` baseParams (trivial).

**Filed as a separate follow-up (NOT this task's fault):** the `profile-reviews-accred-gate.test.ts` param-slot canary went tautological when a later commit grew the reviews CTE to 7 params — see `backend-profile-reviews-accred-gate-canary-stale-param-slots` in `pending/`.

## Backend re-review signal (2026-06-09) — round-1 hold item 1 landed

Enumerated every remaining `WITH ${` site in `backend/src` and documented each with its reason (the prior completion note documented only `getProfileStats`). `grep -rnE 'WITH \$\{' src --include=*.ts` now returns four matches, none of them a convertible single-CTE non-RECURSIVE site:

- `hafsql.ts` (`WITH ${cteParts.join(', ')}`) — the `buildWith` implementation itself. Not a call site.
- `notification-queries.ts` (`WITH ${accredCte.sql}, …`) — multi-CTE mixed-inline: the `activeAccreditationsCteBody` builder's CTE is hand-joined with inline-literal CTEs (`user_bridge_papers`, the notification arms). `buildWith` composes CTE *builders*, not inline-literal CTEs, so it cannot express this chain. Excluded; documented inline (same class as `getProfileStats`).
- `lib/ipfs-shared.ts` (`accred ? WITH ${accred.sql} : ''`) — conditional collapse-to-empty: `buildWith` always emits `WITH …` and cannot express the empty branch. Structural exclusion; documented inline.
- `routes/papers.ts` (paper-detail query, `WITH ${detailCte.sql}`) — single-CTE but param-ordering: the CTE params bind AFTER the outer author/permlink/bridge params, and `$4` (the appTag) is reused as both the `parent_permlink` filter and the `authorsWithSupersessionSelect` / `detailWhere` appTag slot. A byte-identical `buildWith` adoption (CTE params first) would renumber every `$N` in `detailWhere` and the supersession select. Excluded with the param-ordering reason (the hold's accepted alternative); documented inline; kept manual to preserve the exact param layout on this hot detail query.

Each exclusion carries a durable inline comment anchored on its structural reason, so the next convention sweep neither re-flags nor mis-converts it. Comment-only; no behavior change. `npm run typecheck` + `npm run lint` clean (lone pre-existing `author-supersession.ts` warning untouched).
