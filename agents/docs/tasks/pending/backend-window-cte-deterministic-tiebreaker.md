# BACKEND-WINDOW-CTE-DETERMINISTIC-TIEBREAKER — `ROW_NUMBER` and `DISTINCT ON` lack deterministic same-block tie-breakers

**Owner:** backend
**Created:** 2026-05-30 (surfaced by HAF-query multi-lens review, rank #33 low severity, correctness)
**Priority:** P3 (same-block toggle votes or rapid operator accredit/revoke can flip non-deterministically)

## Problem

`ROW_NUMBER OVER PARTITION ORDER BY block_num DESC` (`accred_ranked`, `vouch_ranked` in [hafsql.ts:148, 264](backend/src/hafsql.ts), [883-891](backend/src/hafsql.ts#L883-L891)) and `DISTINCT ON (v.voter) ORDER BY v.voter, v.block_num DESC` (vote queries in [routes/papers.ts:104, 3249-3253, 3277-3281](backend/src/routes/papers.ts#L3249-L3253), [routes/profile.ts:614](backend/src/routes/profile.ts#L614), [reputation.ts:623, 812, 912](backend/src/reputation.ts)) lack deterministic tie-breakers for same-block ops.

Same-block toggle votes or rapid operator accredit/revoke can flip non-deterministically.

Documented convention exists ([hive-primitive-aware-design-rules-for-pevo-custom-json-ops-2026-05-05.md Rule 2](agents/docs/solutions/conventions/hive-primitive-aware-design-rules-for-pevo-custom-json-ops-2026-05-05.md)) — `cj.id` / `id` is the monotonic tie-breaker. The 8 vote sites and 2 ROW_NUMBER sites need landing together to avoid the very partial-fix drift the finding flags.

## Goal

Add deterministic same-block tie-breakers at every affected site in one atomic landing.

### Suggested approach

Single atomic backend task. Two patterns:

- **Window CTEs (`accred_ranked`, `vouch_ranked`):** append `, cj.id DESC` to ORDER BY (id already projected as `event_id`).
- **Vote queries:** extend each `ORDER BY ... block_num DESC` to `... block_num DESC, trx_in_block DESC`. Verify `operation_vote_view` projects `trx_in_block`; fall back to `id DESC` per convention if not.

Cite the convention doc in a brief comment at each site (one-line anchor, not a docblock — the convention path itself is the durable anchor).

## Acceptance

- All 10 sites (2 window CTEs + 8 vote sites) carry the tie-breaker, landed as one commit so no drift is introduced mid-rollout.
- Regression test for same-block toggle votes: assert deterministic resolution to the latest op.
- Regression test for same-block accredit/revoke: assert deterministic resolution.
- Cycle output for the existing seed unchanged in the common case (no same-block ties).
- Comment anchors clean (convention-path citation is fine; no task slug, round number, line number, SHA).
- `npm run typecheck` + `npm run lint` clean.

## Notes

- This is the partial-fix drift trap from the existing convention doc — bundle every site in one task.

## Cross-references

- [backend/src/hafsql.ts](backend/src/hafsql.ts) lines 148, 264, 883-891.
- [backend/src/routes/papers.ts](backend/src/routes/papers.ts) lines 104, 3249-3253, 3277-3281.
- [backend/src/routes/profile.ts](backend/src/routes/profile.ts) line 614.
- [backend/src/reputation.ts](backend/src/reputation.ts) lines 623, 812, 912.
- [agents/docs/solutions/conventions/hive-primitive-aware-design-rules-for-pevo-custom-json-ops-2026-05-05.md](agents/docs/solutions/conventions/hive-primitive-aware-design-rules-for-pevo-custom-json-ops-2026-05-05.md) Rule 2.
- HAF-query review run `w274tijk0` rank #33.
