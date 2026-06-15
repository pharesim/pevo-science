# DEFERRED: batch the revote-count scan when the custom_json namespace grows

**Owner:** backend
**Created:** 2026-06-15
**Status:** DEFERRED — not actionable until the trigger condition below is met. Do
NOT implement on a routine startup pass; verify the trigger first.

## Trigger

The `revote` arm of `accreditedVoteCount` (`backend/src/hafsql.ts`, the form with
`appTagParam`) is a per-row correlated scan whose only index-backed predicate is
`custom_id`. While the APP_TAG `custom_json` namespace (accreditations + vouches +
revotes + param-updates, platform-wide) stays small, the residual filter on the
JSON-extracted `author`/`permlink`/`action` is cheap (live EXPLAIN: sub-ms,
~handful of rows removed by filter). This task fires when that namespace grows
large enough that the O(namespace x rows) cost becomes visible on the per-row
callsites — most exposed: the comment-tree walk in `fetchCommentsTreeFromHaf`
(`routes/comments.ts`, no LIMIT, depth <= 20) and the paper-detail enrichment
reviews-list in `fetchPaperDetailFromHaf` (`routes/papers.ts`, inside the walker
time budget). Concretely: when an EXPLAIN of those endpoints shows the revote
custom_json scan dominating, or the enrichment endpoint starts brushing its time
budget.

## What

Collapse ONLY the revote arm to a single batched `custom_id = APP_TAG AND
action = 'revote'` scan per request + a JS latest-signal-per-(voter, author,
permlink) merge, instead of one correlated scan per output row. Keep the native
arm as the per-row, index-backed correlated subquery (collapsing THAT was the
~3300x regression documented in
`agents/docs/solutions/conventions/correlated-subquery-to-cte-collapse-is-index-dependent-2026-06-14.md`).

The proven shape already exists in the same codebase:
- `batchResolveVotes` (`routes/papers.ts`) — one native scan + one revote scan per
  request, merged in JS.
- the `revoteResult` / `revoteMap` block in `fetchPaperDetailFromHaf` — one revote
  scan for the paper, merged in JS.

## Watch-outs

- **profile.ts votes-sort.** The shared helper currently lets Postgres `ORDER BY
  net_votes` reflect revotes inside SQL with correct LIMIT/OFFSET pagination. A JS
  merge breaks SQL-side ordering: a revote-aware sort would need fetch-all → merge
  → sort → slice in JS, OR a precomputed revote-adjusted count CTE the ORDER BY can
  key on. Resolve this before touching the votes-sort path, or leave that one
  callsite on the helper if it stays cheap.
- The four callsites (`reviews.ts` single-doc, `comments.ts` tree, `profile.ts`
  votes-sort, `papers.ts` enrichment reviews-list) each have different row-set
  shapes; the batched scan must be keyed to each callsite's (author, permlink) set.

## Acceptance criteria

- The revote custom_json namespace is scanned at most once per request on each of
  the affected endpoints (verify via EXPLAIN: one scan, not R/N scans).
- net_votes / accredited_votes values are unchanged vs the per-row helper for the
  same data (parity preserved across the refactor).
- The native arm stays per-row index-backed (no correctness or perf regression).
- profile.ts votes-sort ordering + pagination stays correct.

## Context

Filed from the architect-side review of `backend-revote-display-count-parity`
(2026-06-15). That task shipped the per-row helper deliberately (it is correct and
sub-ms at current scale, and it handles votes-sort ordering natively); this task is
the batched optimization to apply once scale demands it. The inline `PERF / scaling
note` in `accreditedVoteCount` is the in-code pointer to this work.

## [DEFERRED — parked in blocked/] (backend, 2026-06-15)

Moved from `pending/` to `blocked/` so backend's `pending/` queue reflects only
actionable work, matching the precedent set by
`backend-bridge-paper-author-claim-flow`.

Not blocked on any agent: the work is fully scoped (the batched-scan shape already
exists verbatim in `batchResolveVotes` and the `fetchPaperDetailFromHaf` revoteMap
block), and backend can implement it at any time. It is parked because it is not
worth doing until the scale trigger above fires: the revote `custom_json` scan
dominating an EXPLAIN of the affected endpoints, or the paper-detail enrichment
endpoint brushing its walker time budget. At current scale (single-digit APP_TAG
namespace, ~zero revotes) the per-row helper is sub-ms, confirmed during the parent
task's review (2026-06-15).

Do NOT re-raise on routine startup scans. Backend re-elevates this to `pending/`
when a perf pass or EXPLAIN shows the trigger met.
