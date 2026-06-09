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

## Architect re-review (2026-06-09) — HELD PENDING FIXES

`/ce-code-review` fan-out (correctness, security, adversarial on Opus; testing, maintainability, project-standards, performance, kieran-typescript, learnings on Sonnet) on the dedup commit. **Functionally clean** — correctness, security, and adversarial independently confirmed the cycle's accepted-claims set is byte-identical to the prior inline resolution: the scoping population `{claimers: usernames}` equals the old `target_users` filter (`unnest($1::text[])`); `$1–$20` are untouched and the builder appends `$21–$25`; the revoke/approve signer gates, list-final slot gate, and ORCID/hive auto-accept arms now live solely in the builder; no CTE-name collision with the cycle's WITH chain; and the structural dedup is confirmed complete (no other file inlines the resolution). Performance is a net win (the claimer filter is pushed into the `claim_events` scan instead of applied late). Three items block archive:

1. **Forged-revoke gap in the equivalence proof (test).** The equivalence test's only revoke scenario is signed by the post author (a *valid* revoker), so the revoke **signer gate** — the primary defense against a stranger forging a `revoke_authorship` to strip a victim's co-author credit — is never differentially exercised by the "byte-identical" net. Add a seed row where a non-(paper_author/bridge/admin/claimer) account broadcasts `revoke_authorship` against an in-scope accepted claim, and assert the claim STAYS accepted (both the frozen OLD copy and the new builder agree the forged revoke is rejected). This is the one gate the proof exists to protect that it currently doesn't cover.

2. **Stale "Mirrors reputation.ts accepted_claims" comments (src).** The three comment blocks inside `authorshipClaimsCteBody` (revoke gate, approve gate, list-final gate) still say they *mirror* an inline copy in `reputation.ts`. This commit DELETED that copy — the builder is now the single source of truth shared by the cycle and the read surfaces. Reword the three comments so they no longer imply a sync-copy exists in `reputation.ts` (a future editor reading "Mirrors reputation.ts accepted_claims" will go hunting for the very duplication this task removed). Anchor on the single-source-of-truth relationship, not on a sibling copy.

3. **Task-slug in the test header (test).** Drop the `(backend-reputation-claims-cte-dedup)` parenthetical from the equivalence test's header docblock — a task-slug anchor that rots on archive (root `CLAUDE.md` "Comment anchors"). Re-anchor on the behavioral description (the cycle composes `authorshipClaimsCteBody` instead of an inline copy).

**Considered and DISMISSED (do not action):**
- `AuthorshipClaimsScope` structural `in`-discriminator + bare `else` (a `{claimer, claimers}` overlap silently picks the first branch; a future 4th variant falls through to the paper-key branch with undefined fields). Real but low-urgency, and consistent with the pre-existing two-member `in` style — not worth a tagged-union refactor now.
- The three newly-added `hive-schemas.md §N.M` refs in the changed comments. Carry-forward of an existing document-qualified pattern (the op-`action` string anchor is already present alongside), and reviewers split on whether qualified `§` refs are forbidden. Not holding for it. (If you touch these comments for item 2 anyway, dropping the bare `§N.M` in favor of the action-string anchor is a free win — optional.)
- Preemptive equivalence-seed hardening (whitespace-padded ORCID, uppercase-hive, self-approve in the *equivalence* seed; an SQL-text pin of `= ANY($N::text[])`). Each is already covered by the dedicated signer-gate / builder / param-arithmetic tests; not worth widening the equivalence seed beyond item 1's security-relevant gate.

## Backend re-review signal (2026-06-09)

Round-1 hold items 1-3 landed:

1. **Forged-revoke gap.** Added scenario S6 to `reputation-claims-dedup-equivalence.test.ts`: grace claims a hive-match slot on `bob/p-forge`, then a stranger (`mallory` — not the post author, bridge, admin, or claimer) broadcasts a `revoke_authorship` naming grace's claim. The revoke signer gate rejects the forged op, so grace STAYS accepted; she is added to the `expected` accepted set. Both the frozen OLD inline copy and the new shared builder agree (their signer gates are identical), so the byte-identical assertion holds AND the signer gate is now differentially exercised — stripping it from either copy would let mallory's revoke void grace and turn the test red.
2. **Stale "Mirrors reputation.ts" comments.** Reworded the three comment blocks in `authorshipClaimsCteBody` (revoke gate, approve gate, list-final gate) to anchor on the single-source-of-truth relationship: this builder is the one place that resolves `accepted_claims`, consumed by both the reputation cycle and the read surfaces. They no longer imply a sync-copy exists in `reputation.ts` (the copy this task deleted).
3. **Task-slug in test header.** Dropped the `(backend-reputation-claims-cte-dedup)` parenthetical; the header now anchors on the behavioral description (the cycle composes `authorshipClaimsCteBody` instead of an inline copy).

Verification: `npm run typecheck` + `npm run lint` clean (lone pre-existing `author-supersession.ts` unused-directive warning untouched); `reputation-claims-dedup-equivalence.test.ts` green against real Postgres (1 passed, not skipped).
