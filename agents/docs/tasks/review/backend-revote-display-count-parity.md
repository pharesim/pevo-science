# Display vote counts omit revote custom_json (reputation/display parity gap)

**Owner:** backend
**Created:** 2026-06-15

## What

Several display-side accredited-vote-count surfaces count **native votes only**
(`operation_vote_view` via the `accreditedVoteCount` helper and one inline twin),
and silently ignore `revote` `custom_json` operations. The reputation cycle and
the main paper vote resolver already treat the two sources as one signal stream,
so these display surfaces diverge from the score whenever an accredited voter
changed or retracted their vote via a post-payout revote.

## Why

After the 7-day Hive payout window a voter cannot recast a native vote, so PEvO
uses a `revote` `custom_json` (`action: "revote"`, declared `weight`) to change or
retract the vote. The reputation calc folds native + revote into one
latest-signal-per-voter stream:

- `paper_vote_signals` / `review_vote_signals` in `computeReputationBatch`
  (`backend/src/reputation.ts`) `UNION ALL` the revote arm, resolve latest per
  `(voter, author, permlink)` by `block_num DESC, op_id DESC` across both arms
  (native `vo.id` and revote `cj.id` share one monotonic HAF op-id sequence), and
  drop `weight = 0` as a retraction.
- `batchResolveVotes` (`backend/src/routes/papers.ts`) does the same for the paper
  list/detail `net_votes` + `vote_strength`, so those surfaces are already at
  parity.

The remaining count surfaces do not, so a paper/review/comment whose accredited
voter flipped or retracted via revote shows a stale count that contradicts the
reputation the same data produced.

## Affected surfaces (native-only today)

- `accreditedVoteCount(authorExpr, permlinkExpr)` in `backend/src/hafsql.ts` — the
  shared native-only scalar subquery. Callsites:
  - `backend/src/routes/reviews.ts` — review list `net_votes`.
  - `backend/src/routes/comments.ts` — `accredited_votes` per comment.
- The inline native-only `net_votes` subquery in `backend/src/routes/profile.ts`
  (the `sort === 'votes'` reviews ordering) — a hand-rolled twin of the helper.

Note: the papers list default `accreditedVoteCount(...) AS net_votes` in
`backend/src/routes/papers.ts` is overwritten by the revote-aware
`batchResolveVotes` result before the response is built, so the papers list/detail
are already covered. Confirm this still holds and avoid double-counting; the fix
is for the genuinely-uncovered review/comment surfaces.

## Desired behavior

Bring the listed surfaces to the same native+revote resolution the reputation cycle
uses:

1. Union the accredited `revote` `custom_json` arm (`custom_id = APP_TAG`,
   `action = 'revote'`, `required_posting_auths[0] = ANY(accredited)`, the
   `{1,9}`-digit-guarded `weight` cast) with the native arm.
2. Resolve the latest signal per `(voter, author/permlink)` across both arms by
   `block_num DESC` then the shared HAF op-id DESC (do not namespace op-id per arm
   — that breaks cross-arm latest-wins).
3. Exclude self-votes (`voter != author`) and `weight = 0` retractions, matching
   the existing helper.
4. Keep declared-weight semantics (the count is sign-of-weight; `operation_vote_view.weight`
   is already the declared op weight, verified against HAF).

Prefer extending the shared helper so all callsites inherit the fix rather than
patching each subquery; the `profile.ts` inline twin should collapse onto the
shared helper if practical.

## Acceptance criteria

- A review/comment whose only accredited signal is a post-payout `revote` upvote
  shows `net_votes`/`accredited_votes` ≥ 1 (not 0), matching what the reputation
  cycle credits.
- A native upvote later retracted via a `weight: 0` revote shows count 0 on these
  surfaces.
- A native upvote later flipped to a downvote via revote flips the count sign.
- Papers list/detail counts are unchanged (already revote-aware via
  `batchResolveVotes`) — no double counting.
- Tests exercise the native-then-revote and revote-retraction cases for at least
  the review surface; reuse the project's real-HAF test posture or the documented
  mock carve-out where a deterministic multi-state vote history is impractical to
  stage live.

## Context

Surfaced while reproducing reputation for `pevo.science`: the reputation calc and
`batchResolveVotes` correctly fold revotes, but the per-row display-count helpers
were never extended, leaving the review/comment count surfaces native-only. Low
severity (display-count drift, not a reputation or auth defect); the score itself
is computed from the correct native+revote stream.

## Implementation note (backend)

`accreditedVoteCount` (`backend/src/hafsql.ts`) gained an optional `appTagParam`.
When supplied, it emits a native + `revote` UNION-ALL form resolving the latest
signal per voter across both arms by `block_num DESC, op_id DESC` (parity with the
`*_vote_signals` CTEs in `reputation.ts`). The native-only form (no `appTagParam`)
is byte-identical to before, for the papers-list path that `batchResolveVotes`
overwrites. Threaded through FOUR display surfaces:

- `routes/reviews.ts` (single-review `net_votes`)
- `routes/comments.ts` (comment-tree `accredited_votes`)
- `routes/profile.ts` (votes-sort `net_votes`, collapsing the inline twin)
- `routes/papers.ts` `fetchPaperDetailFromHaf` reviews-list `net_votes` — a FOURTH
  surface NOT in the original "Affected surfaces" list above. It is the
  paper-detail/enrichment embedded `reviews[].net_votes`, an inline native-only
  twin of the same bug class; the paper's own count there is already revote-aware
  via the JS `revoteMap`, but the embedded reviews' counts were native-only.
  Approved for in-scope inclusion (same review showed divergent counts on the
  paper page vs its single-review page).

Performance: the revote arm is a per-row correlated scan whose only index-backed
predicate is `custom_id` (HAF cannot index the JSON-extracted author/permlink), so
it is O(namespace x rows). Cheap at current scale (single-digit namespace, ~zero
revotes), documented inline with a collapse-to-batched threshold. Follow-up task
`backend-revote-count-batched-scan-on-namespace-growth` filed for the batched
single-scan refactor if/when the custom_json namespace grows.

## [TODO Architect] — contract-doc updates (backend cannot edit api-contracts)

The displayed `net_votes` / `accredited_votes` count semantics are now revote-aware
on the review, comment, profile-votes-sort, and paper-detail-embedded-review
surfaces. The integrator-facing contracts still frame these counts as native-Hive
only and need the parallel update the paper-level `voters[]` already has:

1. `api-contracts/reviews.md` — the `net_votes` field note: state the count folds
   the latest accredited signal across native votes and post-payout `revote`
   `custom_json` (parity with reputation and the paper-detail `voters[]` note).
2. `api-contracts/common.md` — the Accredited-Only Data Policy `net_votes` sentence
   likewise.
3. `api-contracts/papers.md` — optionally a per-field note on the paper-detail
   embedded `reviews[].net_votes` making its revote-awareness explicit alongside
   the existing paper-level `voters[]` revote note.

(No emdashes in the contract prose, per the project rule for integrator-facing docs.)
