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

## Implementation note (backend, 2026-06-02):

Implemented and validated. `user_papers` now projects `chain_author`/`chain_permlink`
on both arms; a deduped `chain_papers` CTE was added; `paper_vote_signals` (both
arms), `paper_resolved_votes`, `paper_reviews`, and `paper_scores` were rekeyed to
the on-chain post identity while credit attribution stays on `up.author` (the
claimer). All four points of the suggested approach landed.

Validation: `backend/tests/routes/reputation-coauthor-claim-credit.test.ts`
(source-shape pins + synthetic-VALUES behavioral canary) and the
reputation-lifecycle idempotency test (real production query against HAF) PASS.
The behavioral canary pins: claim credit flows to the claimer; the chain-author
self-vote is excluded (so a poster cannot inflate the claimer's score); the
native arm is unregressed; a co-credited post does NOT fan out (the dedup gives
each recipient one copy of the score, not a multiplied one); and a non-target
chain author receives no credit. An adversarial multi-lens verification cleared
the shared-credit semantics against `reputation-algorithm.md`.

WHERE THE CODE LANDED (for review): the `reputation.ts` changes are in commit
`1ab97151` (backend(custom-id-block-num-floor-sweep)), NOT a dedicated task-6
commit. A concurrent backend session's floor sweep removed a param from
`computeReputationBatch` and renumbered the refs ($18 -> $17 bridge, $19 -> $18
anon, activeAccreditationsCteBody(20) -> (19)) across the whole query, including
the param refs inside the CTE lines this task added. The two changes became
entangled line-by-line in the shared working tree; the floor-sweep session staged
`reputation.ts` whole-file and carried this task's CTE work into `1ab97151`. The
result is internally consistent and functional (idempotency passes at the
renumbered scheme). The co-author canary test lands in the accompanying
backend(reputation) commit (this task-state move). To review the code:
`git show 1ab97151 -- backend/src/reputation.ts` (the chain_papers / chain_author
/ rekeyed-join hunks) plus the canary test.

## Architect re-review (2026-06-05) — HELD PENDING FIXES (2 items + canary)

`/ce-code-review` multi-lens fan-out (correctness + adversarial + security on Opus;
testing/perf/maintainability/project-standards/kieran-ts/learnings on Sonnet;
ce-agent-native skipped per PEvO). The **P0 zero-score fix itself is verified
correct and stays**: the chain-identity rekey is sound (counts/credit flow to the
claimer via `up.author` while votes/reviews key on `chain_papers`; `chain_papers`
DISTINCT prevents fan-out for multi-recipient posts; native arm unregressed), the
`accepted_claims` approval arm IS signer-gated (`ap.approver IN (ap.paper_author,
bridge)`, no forge-your-own-approval path), and the floor-sweep param-renumber
entanglement was confirmed non-corrupting (every `$N` ref aligns with the bind
array; `git diff` against the reviewed state is empty).

HELD on a **P1 self-dealing regression the rekey introduced**, plus the design
decision that resolves it. Two reviewers (adversarial + security) independently
found it; user ratified the authorship model.

**Design decision (user, 2026-06-05): the authorship list is FINAL at posting.**
Authorship credit binds only to an author slot that was named at posting time.
There is no "unlisted claim → approve → append a never-named co-author" path. New
co-authors are added only through a continuation revision (ARCHITECTURE.md § 6
"Authors mutation"), never through claim/approval. `hive-schemas.md` § 2.9/2.10 and
`reputation-algorithm.md` "Co-author Credit" are being updated by the architect to
this model; implement against the updated docs.

### Item 1 — enforce list-final on the explicit-approval credit arm
The explicit-approval arm of `accepted_claims` (cycle, `reputation.ts`) and of
`authorshipClaimsCteBody` (read surface, `hafsql.ts`) currently accepts a claim
with `author_index = null` (unlisted claimer), so the post author / bridge can
credit an account that was never in the paper's `authors[]`. That is both a
credit-stuffing vector (one author can mint full co-author credit for arbitrarily
many never-named accounts) and the root of Item 2. Require the approval arm to
resolve a non-null `author_index` to an existing `authors[author_index]` slot;
drop the unlisted-claim acceptance. Keep the auto-accept arms (ORCID, hive) as-is —
they already bind to a named slot. Mirror the change across both surfaces so the
cycle and the read surface resolve claims identically.

### Item 2 — close the claimer self-vote / self-review self-dealing
The self-vote exclusion in `paper_resolved_votes` (`plv.voter != cp.author`) and
the self-review exclusion via `excludeSelfReviewWhere({ paperRowAlias: 'cp' })` in
`paper_reviews` exclude only the chain poster and `authors[].hive` members. A
credited claimer matched by ORCID, or connected to a name-only slot (slot `hive`
is null/absent), is NOT in `authors[].hive` — so after the rekey makes claimed
papers score for the first time, such a claimer can upvote and 5/5/5/5-self-review
the very paper they are credited for. Item 1 alone does NOT close this (the
connected hive is not written back into the raw post `authors[]` the exclusion
reads). Extend BOTH exclusions to also reject any `accepted_claims` claimer for the
chain post `(plv.author, plv.permlink)`, in addition to the existing chain-poster
and `authors[].hive` checks. Mirror across `reputation.ts` and the `hafsql.ts` read
surface. Also correct the `paper_resolved_votes` comment that asserts `plv.voter !=
cp.author` is "correct even for claimed papers" — it is not, for the claimer.

### Canary
- Replace the tautological `not.toBeCloseTo(2.0)` assertion (it passes whenever the
  primary `toBeCloseTo(1.0)` does) with a scenario that actually seeds a claimer
  self-vote and asserts it does NOT credit the claimer.
- Add a claimer self-review case (claimer reviews the claimed paper → quality
  multiplier must not flow to the claimer).
- Cover the approval and ORCID accept arms, not only the hive-match arm (the
  hive-match arm is incidentally safe because the claimer is in `authors[].hive`;
  the gap lives in the other two arms).
- Pin Item 1: an `author_index = null` (unlisted) approval grants zero credit.
- Lower priority (fold in while here): a revote (`custom_json`) on a claimed paper,
  and the co-author-voter `authors[].hive` exclusion on a claimed paper — both are
  source-shape-pinned only today.

Land Items 1+2 together (Item 2 is the live exploit; Item 1 is the structural
constraint that also shrinks Item 2's surface). `npm run typecheck` + `npm run
lint` clean; comment anchors on stable symbols. When done, `git mv` back to
`tasks/review/`.
