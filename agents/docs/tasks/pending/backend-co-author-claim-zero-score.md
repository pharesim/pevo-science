# BACKEND-CO-AUTHOR-CLAIM-ZERO-SCORE — claimed papers contribute 0 score because `user_papers` keys on the claimer while downstream CTEs key on the chain author

**Owner:** backend
**Created:** 2026-05-30 (surfaced by HAF-query multi-lens review, rank #2 high severity, correctness)
**Priority:** P0 (documented co-author credit feature delivers exactly zero reputation; compounds with the just-landed approve-authorship signer gate so the entire claim machinery accrues no reputation today)

## Problem

The reputation cycle's `user_papers` CTE in [reputation.ts:572-746](backend/src/reputation.ts#L572-L746) UNIONs a claim-row keyed `(claimer, original_permlink)`, but every downstream CTE — `paper_vote_signals`, `paper_vote_agg`, `paper_reviews`, `paper_scores` — joins back on `up.author = vo.author` / `c.parent_author = up.author`, i.e. the **claimer** name, not the **chain author** of the original post.

Votes and reviews on the underlying paper are signed against the chain author, so they never match the claimer's `user_papers` row. `paper_vote_agg` and `paper_reviews` yield NULL → `paper_scores` collapses to 0 for every claim row.

The documented co-author credit feature (`reputation-algorithm.md` line 31; multiple comments and tests promise this) delivers exactly zero. Coupled with the just-landed approve-authorship signer gate, the entire claim machinery accrues no reputation today.

## Goal

Make `user_papers` carry both the credit-recipient identity (the claimer) AND the on-chain post identity (the original post author + permlink) so downstream joins can use the on-chain identity for matching while credit accumulates against the claimer.

### Suggested approach

1. Expose `chain_author` and `chain_permlink` in `user_papers`:
   - Native arm: `chain_author = c.author`, `chain_permlink = c.permlink`.
   - Claim arm: `chain_author = ac.paper_author`, `chain_permlink = ac.paper_permlink`.
2. Switch `paper_vote_signals` EXISTS, `paper_reviews` JOIN, and `paper_scores` LEFT JOIN to key on `(up.chain_author, up.chain_permlink)`.
3. Keep GROUP BY / final SUM on `up.author` (the claimer) so credit flows to the claimer.
4. Relax `paper_vote_signals`' `vo.author IN target_users` to an EXISTS against `user_papers` — claimer-only target sets need to pick up votes signed by the chain author.

## Acceptance

- Regression test seeding `(bob = post author, alice = approved claimer)` + a third-party upvote asserts alice's `papers` breakdown > 0.
- Native (non-claim) author rows still receive the same score they do today (no regression on the native arm).
- The on-chain author of a claimed paper does NOT also get credit for the same vote — credit flows to the claimer only when an approved `accepted_claim` exists. Pin this with a test.
- Comment anchors clean.
- `npm run typecheck` + `npm run lint` clean.

## Notes

- Ordering: independent of #1 (cycle off-by-one) but compounds with it. Land #1 first if both are in flight so this fix's score deltas show up immediately.
- The duplicated claim-resolution logic in `reputation.ts` vs `hafsql.ts` (task #28 — `backend-reputation-claims-cte-dedup`) is a separate cleanup; do NOT fold it into this fix, but the merge target there will be cleaner if this lands first.

## Cross-references

- [backend/src/reputation.ts](backend/src/reputation.ts) lines 572-746 (`user_papers` and downstream paper scoring CTEs).
- [agents/docs/reputation-algorithm.md](agents/docs/reputation-algorithm.md) line 31 (co-author credit promise).
- HAF-query review run `w274tijk0` rank #2.
