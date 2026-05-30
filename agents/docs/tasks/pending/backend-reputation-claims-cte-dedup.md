# BACKEND-REPUTATION-CLAIMS-CTE-DEDUP — `reputation.ts` hand-rolls `authorshipClaimsCteBody`; drift between cycle and read-surface claim semantics

**Owner:** backend
**Created:** 2026-05-30 (surfaced by HAF-query multi-lens review, rank #28 medium severity, simplification)
**Priority:** P3 (any change to claim semantics has to be applied in two places; a divergence is silent reputation-vs-read skew)

## Problem

The reputation cycle in [reputation.ts:468-570](backend/src/reputation.ts#L468-L570) inlines ~100 lines of `claim_events + accepted_claims` resolution that duplicates `authorshipClaimsCteBody` almost verbatim (comments literally say "Mirrors `authorshipClaimsCteBody`").

Any change to claim semantics has to be applied in two places; a divergence is silent reputation-vs-read skew. The existing shape-pin test acknowledges the drift risk.

Compounds with #3 (revoke gate) and #4 (`author_index` cast) which both need to land in both copies.

## Goal

Extract the shared logic so the cycle and read-surface paths consume one CTE builder.

### Suggested approach

1. Extend `AuthorshipClaimsScope` with a `{claimers: string[]}` variant — `scopeFilter` becomes `= ANY($N::text[])`.
2. Compose the cycle path via:
   ```typescript
   buildWith(1, activeAccreditationsCteBody, (idx) =>
     authorshipClaimsCteBody(idx, { claimers: usernames })
   )
   ```
3. Derive `accepted_claims` via a simple `SELECT DISTINCT`.
4. Renumber parameter layout through `buildWith`.
5. Keep the shape-pin tests as the architectural-invariant backstop.

## Acceptance

- The ~100 lines of duplicated claim resolution in `reputation.ts` are gone; one shared builder is used.
- The cycle's claim semantics are byte-identical to before (regression test comparing old vs new accepted-claim set for a representative seed).
- Shape-pin tests remain in place and still red on a divergence.
- All sibling fixes (#3 revoke gate, #4 author_index cast) are present in the shared builder, not in two places.
- Comment anchors clean.
- `npm run typecheck` + `npm run lint` clean.

## Notes

- **Land AFTER #3, #4, and #2** so the shared merge target is already correct. Specifically:
  - #3 must add the revoke signer gate to the existing shared builder + the inlined reputation copy first.
  - #4 must guard the `author_index` cast in both copies first.
  - #2 may reshape `user_papers` — coordinate so the dedup doesn't fight that.
- Pure cleanup task; do NOT mix in semantic changes.

## Cross-references

- [backend/src/reputation.ts](backend/src/reputation.ts) lines 468-570 (inlined claim resolution).
- [backend/src/hafsql.ts](backend/src/hafsql.ts) — `authorshipClaimsCteBody`, `AuthorshipClaimsScope`, `buildWith`.
- Existing shape-pin tests (find via grep for `authorshipClaimsCteBody.*pin`).
- HAF-query review run `w274tijk0` rank #28.
