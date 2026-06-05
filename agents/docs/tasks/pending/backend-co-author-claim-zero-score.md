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
co-authors are added only through a continuation revision (ARCHITECTURE.md § 2
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

## Architect note (2026-06-05) — relationship to the consented-authorship model

The 2026-06-05 brainstorm (captured in `architect-reconcile-authorship-claim-vs-vouched-tracks`)
decided a unified two-route consent model that will eventually **replace the
ORCID/hive auto-accept arms** with explicit consent: anchored slots (hive or ORCID)
→ `author_accept`; name-only slots → `claim` + `approve`. That migration is a
separate, larger task (`backend-implement-consented-authorship-model`).

**Do NOT block this P0 on that migration.** Land Items 1+2 as scoped against the
CURRENT auto-accept query:
- Item 1 (named-slot resolution on the approval arm) stays as written; under the
  future model it maps to the name-only route's `claim` + `approve`.
- Item 2 (reject any credited claimer's self-vote/self-review) is required under
  BOTH the current and the future model and carries forward unchanged.
- The hold block's "keep the ORCID/hive auto-accept arms as-is" instruction holds
  for THIS task; the consented-model migration removes those arms later.

## Backend re-review signal (2026-06-05) — Items 1+2 landed, canary rewritten

Implemented against the current auto-accept query per the architect note above
(auto-accept arms left as-is).

**Item 1 — list-final gate on the explicit-approval arm (both surfaces).**
- `reputation.ts` `accepted_claims`: the explicit-approval arm now requires
  `ce.author_index IS NOT NULL` AND an EXISTS proving `authors[author_index]` is an
  object on the chain post (`jsonb_typeof(... -> ce.author_index) = 'object'`).
  Unlisted / out-of-range approvals grant no credit.
- `hafsql.ts` `authorshipClaimsCteBody` approvals arm: mirrored the same gate
  (`cb.author_index IS NOT NULL AND EXISTS(approve) AND EXISTS(slot)`).
- The ORCID and hive auto-accept arms were already slot-gated (they require
  `author_index IS NOT NULL` and resolve `authors[author_index].orcid/.hive`); only
  the explicit-approval arm lacked the gate, so only it changed.

**Item 2 — claimer self-vote / self-review exclusion (cycle).**
- `paper_resolved_votes`: added `AND NOT EXISTS (accepted_claims ac WHERE
  ac.paper_author = plv.author AND ac.paper_permlink = plv.permlink AND
  ac.claimer = plv.voter)`. Replaced the misleading "correct even for claimed
  papers" comment on `plv.voter != cp.author` (it covers only the poster).
- `paper_reviews`: added the mirror exclusion keyed on `c.author` (the reviewer).
- Both close the ORCID-/name-only-slot claimer self-dealing the chain-identity
  rekey opened (such a claimer is absent from `authors[].hive`).

**Item 2 read-surface scope — please confirm.** The self-dealing **score** inflation
is cycle-only: the read surface (papers.ts enrichment, profile, reviews, search,
stats) lists raw reviews + vote counts and does NOT compute a claimer-attributed
aggregate score, so a claimer self-vote/self-review cannot inflate any displayed
reputation there. The claims read surface (`authorshipClaimsCteBody`) gets Item 1's
gate. NOT done: extending `excludeSelfReviewWhere` at the display callsites so a
claimer's self-review is also dropped from the displayed third-party-review LISTS —
that is the pre-existing deferred gap the helper docstring already tracks ("when the
vote path picks up claims, this helper should too"), a display-consistency concern
distinct from the security exploit. Flagged for a follow-up-task decision rather than
silently widening scope into every display callsite (each would need the
authorship_claims CTE in scope).

**Sibling read-surface test maintenance (consequence of Item 1).**
- `authorship-approve-signer-gate.test.ts` + `authorship-revoke-signer-gate.test.ts`:
  the synthetic harness omitted `author_index` (to isolate the approval/revoke arms)
  and redirected only `T.customJson`. The new slot gate requires a resolvable named
  slot, so the harness now also redirects `T.comments` to a synthetic post carrying
  a name-only slot at index 0 and sets `author_index: 0` on the claim (name-only
  keeps the ORCID/hive arms silent, preserving the test's intent). Also removed a
  stale `base[3] = 0` line that forced a no-longer-existent "genesis floor" and was
  clobbering the appTag metadata-key param ($4) that the new gate now reads.

**Canary (`reputation-coauthor-claim-credit.test.ts`).** Replaced the tautological
`not.toBeCloseTo(2.0)` with a seeded **claimer** self-vote that must NOT credit the
claimer; added a claimer self-review quality-path exclusion case; added an
`accepted_claims` named-slot-gate behavioral test covering the approval and ORCID
arms (incl. `author_index = null` and out-of-range → zero credit); added source pins
for both new gates on both surfaces.

**Verification (real HAF + local Postgres).**
- canary 13/13; reputation-lifecycle (full production cycle, real HAF) 17/17;
  sibling reputation shape/canary 16/16; read-surface (claims, approve/revoke signer
  gate, hafsql) 62/62 (2 skipped); reputation-batch (cycle-boundary, internals,
  prefix) green. `npm run typecheck` (src+tests) + `npm run lint` clean.
- Pre-existing HAF-load flakiness (stats-profile-parity reader-parity; profile
  `pevo.admin` papers-list 30s statement timeout) reproduces on clean HEAD with my
  changes stashed — not introduced here.

## Architect re-review (2026-06-06) — round-2 items FIXED; round-3 HELD PENDING FIXES (hygiene)

Round-2 Items 1+2 (list-final approval slot gate + claimer self-vote/self-review exclusion) are **VERIFIED CORRECT** and mirrored identically across `reputation.ts` `accepted_claims` and `hafsql.ts` `authorshipClaimsCteBody`. `/ce-code-review` multi-lens fan-out (correctness + security + adversarial on Opus; testing/maintainability/project-standards/performance/kieran-typescript on Sonnet; ce-learnings; ce-agent-native skipped per PEvO). The score-path holes are closed: out-of-range/null `author_index` rejected via the `^[0-9]{1,9}$` regex + `jsonb_typeof(...)='object'`; ORCID/name-only claimers (absent from `authors[].hive`) now caught by the self-vote/self-review `NOT EXISTS`. No bypass found; cycle and read surface in lockstep. The `base[3]=0` removal correctly restored the appTag metadata-key param the new gate reads.

HELD on hygiene **introduced by this commit** (none is score-correctness). Land these, then `git mv` back to `tasks/review/`:

### H1 — comment-anchor violations in test source (CLAUDE.md "Comment anchors")
`reputation-coauthor-claim-credit.test.ts` embeds hold-item coordination-state the convention forbids in test source: the `(Item 2)` inline comment and the `(... list-final, Item 1)` describe-block label. Reword to behavioral labels (anchor on the SQL/behavior — e.g. "claimer self-dealing close (accepted_claims NOT EXISTS gate)"; "co-author claim credit — accepted_claims named-slot gate (list-final)"), not the round-N hold item.

### H2 — stale docblock on `excludeSelfReviewWhere` (hafsql.ts)
The helper's "What this does NOT exclude" paragraph still says the claimer self-vote gap exists in `paper_resolved_votes` ("when the vote path picks up claims, this helper should too"). This commit CLOSED that gap in the cycle. Update it: the cycle now closes the gap via `accepted_claims NOT EXISTS` in both `paper_resolved_votes` and `paper_reviews`; the residual gap is the DISPLAY callsites (paper-detail/profile/search/stats review lists) that compose this helper but don't carry the claims CTE (tracked by `backend-claimer-self-review-display-callsite-exclusion`).

### H3 — incorrect mutation-kill comment (`...credit.test.ts`, the null-index case)
The comment claims dropping the `jsonb_typeof` slot gate makes the null-`author_index` case (`frank`) accepted; `frank` is actually rejected by the separate `ce.author_index IS NOT NULL` guard regardless of the slot gate. Fix the narrative: dropping the slot gate flips the out-of-range approval (`grace`) and out-of-range ORCID (`ivan`) cases to accepted; the null-index case stays rejected by the IS NOT NULL guard. The assertion is correct; only the comment is wrong.

### H4 — stale "genesis floor" docstring in the signer-gate harnesses
`authorship-approve-signer-gate.test.ts` + `authorship-revoke-signer-gate.test.ts` retain a `resolveClaimStatus` docstring referencing a forced "claim_events block_num floor … 0" after `base[3]=0` was removed this commit (that param is the appTag metadata key, not a block floor). Update the docstring to match.

### H5 (optional fold-in) — non-discriminating source pin
The self-vote source pin is satisfied by either of two occurrences; the behavioral canary already mutation-kills the regression, so it's low-value. If touching the file anyway, tighten to the full correlated predicate or an occurrence count.

**Optional, NOT a hold item (awareness):** the self-dealing exclusions are pinned by the synthetic-VALUES canary + source substrings, not by executing the real `computeReputationBatch` / `authorshipClaimsCteBody`. A real-HAF lifecycle fixture (claimer self-vote + self-review → score unchanged) would harden against a real-query refactor that mis-keys the `NOT EXISTS`. Recorded for a future test-hardening pass, not required for archive.

`npm run typecheck` + `npm run lint` clean; comment anchors on stable symbols. When done, `git mv` back to `tasks/review/`.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
