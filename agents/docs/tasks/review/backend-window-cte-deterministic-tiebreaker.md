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

## Implementation note (backend, 2026-06-06)

Landed all 10 enumerated sites in one commit. The cross-reference line numbers
had drifted; sites were located by grepping `ROW_NUMBER` / `DISTINCT ON` /
`ORDER BY ... block_num DESC`.

- **Tie-breaker column:** `operation_vote_view` and `operation_custom_json_view`
  do NOT project `trx_in_block` (verified against the live HAF view: columns are
  `id, timestamp, voter, author, weight, permlink, block_num`). Per the convention
  doc's fallback rule, the monotonic HAF op `id` is the tie-breaker everywhere
  (`v.id DESC` / `cj.id DESC`; reputation's union CTEs project `op_id` from each
  arm — native `vo.id`, revote `cj.id` — then `op_id DESC`).
- **The 10 sites:** window CTEs `accred_ranked` + `vouch_ranked` (`hafsql.ts`);
  DISTINCT-ON vote sites `accreditedVoteCount` (`hafsql.ts`), batch native votes +
  per-paper accredited voters + review net_votes (`papers.ts` ×3), review net_votes
  (`profile.ts`), and `paper_latest_votes` + `review_latest_votes` +
  `citing_latest_votes` (`reputation.ts` ×3).
- **Self-caused test fix (in-scope):** `vouch_ranked` now requires `id` in its
  synthetic VALUES; `active-vouches-signer-gate.test.ts` was updated to project it.

### [Architect triage] related latest-wins sites OUTSIDE this task's enumerated 10
These are latest-*config*/op-wins selections that share the same-block-ambiguity
class but were not in the task's vote/accred scope. Flagging for a triage decision
(file follow-up, or accept as practically-never-tied):
- `reputation.ts` `update_weights` config: `ORDER BY cj.block_num DESC LIMIT 1` (no
  tie-breaker; admin op, same-block tie practically impossible).
- `profile.ts` (early custom_json selection): `ORDER BY cj.block_num DESC`.
- `papers.ts` revote query: `ORDER BY cj.block_num DESC` (dedups via Map insertion
  order downstream, so deterministic-by-Map, but SQL ordering is same-block-ambiguous).
- `tests/bench-reputation.ts`: hand-copied vote-signal SQL (a benchmark, not a test)
  with no tie-breaker.

Verification: typecheck + lint clean; new `window-cte-deterministic-tiebreaker.test.ts`
3/3 (same-block accredit/revoke + toggle votes proven deterministic across reordered
VALUES); reputation-lifecycle (real HAF, validates the merged `op_id` SQL is
executable), reputation-coauthor-claim-credit, active-vouches, hafsql all green on
the integrated main tree.
