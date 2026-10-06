# The cast-hardening canary still pins five weight casts after the revote-aware vote count added a sixth guarded one

**Owner:** backend
**Created:** 2026-10-06
**Priority:** low

Filed at the user's request after a root-cause pass on 2026-10-06. Each of the seven backend files
that fail when run alone on clean main was diagnosed by one agent and re-checked by a second; the
failing spec sets were identical at 342f2820 and 74488ad5.

## Why

`backend/tests/cast-hardening-author-index-weight.test.ts`, spec "every author_index/weight cast
in the broadcaster-cast sites is regex-guarded", fails with `expected 6 to be 5` at
`expect(totalWeight).toBe(5)` (measured). The per-file `guarded === total` assertions pass for
all three scanned files. Only the global inventory pin fails.

Root cause: test drift. 96fa47e1 (backend(votes): revote-aware accreditedVoteCount on
review/comment/profile/paper-detail counts, 2026-06-15) gave `accreditedVoteCount` in
`backend/src/hafsql.ts` a native + revote UNION ALL form, used when `appTagParam` is supplied.
Its revote arm projects the weight under the guard:

```
CASE WHEN (cj.json::jsonb ->> 'weight') ~ '^-?[0-9]{1,9}$' THEN (cj.json::jsonb ->> 'weight')::int END AS weight,
```

That commit did not touch this test. The test was last edited at 973a9567 (backend(reputation),
the claim-resolution dedup where the cycle composes the shared `authorshipClaimsCteBody`), which
moved the author_index pin from 2 to 1 and left weight at 5. `git log -S` on the guarded
weight-cast text returns only fa572740 (backend(hafsql): regex-guard broadcaster-controlled
author_index/weight casts, the original five sites) and 96fa47e1. 96fa47e1 is an ancestor of
both diagnosed commits.

Inventory at HEAD, measured by running the canary's own `castCounts` regex over the three files:
author_index 1 of 1 guarded, weight 6 of 6 guarded.

- author_index: the `claim_events` CTE in `hafsql.ts`.
- weight: the `accreditedVoteCount` revote arm in `hafsql.ts`; `paper_vote_signals`,
  `review_vote_signals` and `citing_vote_signals` in `reputation.ts`; `batchResolveVotes` and
  `fetchEnrichmentFromHaf` in `routes/papers.ts`.

A grep of all of `backend/src` for `'weight'` and `'author_index'` under any JSON accessor finds
no other custom_json cast. The `v.weight::int` casts in `notification-queries.ts` read the typed
native vote-op table, not broadcaster-controlled JSON, so they are outside the canary's scope.

**The protected behavior holds (measured).** A probe ran the real
`accreditedVoteCount("'pa'", "'pp'", '$1')` output through the real `getPool()`, with its FROMs
redirected to synthetic VALUES. Each case was a native upvote followed by a later revote with a
forged weight.

- Forged weights ('99999999999999', 1e15, '2147483648', 'abc', 5000.5, '1e3', a JSON object,
  null) complete with net 0: no abort, and the voter is dropped.
- Legitimate weights resolve: -10000 gives -1, 5000 and '999999999' give +1.
- With four voters and one forged 11-digit revote, the query completes at net +1 and only the
  forger is dropped.
- With the guard text stripped from the helper output, the same rows abort with 22003 (out of
  range) and 22P02 (invalid input syntax), so the probe exercises the cast.

`window-cte-deterministic-tiebreaker.test.ts`, spec "a malformed-weight latest revote drops the
voter (NULL weight, not a crash)", already pins the non-numeric case on this arm through the real
helper.

The file's other spec, "guarded casts drop malformed and overflow values to NULL and preserve
legit integers (no query abort)", passes and is not vacuous. It runs the file's own guard
constants over synthetic rows, as its carve-out header says, and the canary requires those same
constants in front of each production cast.

## Scope

1. In the canary spec, change `expect(totalWeight).toBe(5)` to `expect(totalWeight).toBe(6)`.
2. In the inventory comment above the two pins, make the weight clause read "6 weight (the
   accreditedVoteCount revote arm in hafsql, 3 reputation revote arms, 2 papers revote queries)".
   The verifier checked this wording against the code. The implementer confirms it at HEAD.
3. Change nothing else: no production code, guard constants, `castCounts`, scanned file list or
   carve-out header. The header's (a), (b) and (c) items stay true.

## Acceptance criteria

1. The file passes when run alone: 2 passed, exit 0, no Errors line. Both agents measured this in
   probe copies with only the pin changed.
2. Mutation evidence from a scratch copy, in the signal block. With the pin at 6:
   - deleting the guarded weight cast from the `accreditedVoteCount` revote arm fails the spec
     (5 vs 6);
   - stripping that cast's guard fails the `hafsql.ts` per-file weight assertion.
3. The diff touches only `backend/tests/cast-hardening-author-index-weight.test.ts`. The
   pre-commit anchor gate finds no hits on the added lines.

## Notes

- Priority is low because this is pin upkeep. The per-file assertions still pass for all six
  weight sites, and the guarded behavior on the new site was measured to hold, so no protection
  was lost.
- Optional while that comment is being rewrapped: the author_index clause narrates history ("the
  reputation cycle now composes that shared builder via authorshipClaimsCteBody instead of an
  inline claim_events copy, so its former cast is gone"). It is accurate. Narrowing it to
  "1 author_index (hafsql claim_events)" is allowed but not required.
- Residuals, not proposed (no preemptive hardening):
  - The canary is a source-text regex over `hafsql.ts`, `reputation.ts` and `routes/papers.ts`,
    with the literal `cj.json::jsonb ->> '<field>'` spelling. A cast in another file, or under
    another alias or spacing, would escape it. The whole-src grep found no such site.
  - The overflow case on the `accreditedVoteCount` revote arm was measured by the probe, but no
    committed test runs it against the real helper. The tiebreaker spec pins only the non-numeric
    case there. This file's behavioral spec pins the guard's overflow semantics, and the canary
    pins the guard text at the site.
- Overlap:
  - No open task is dedicated to this file or its spec names.
  - `backend-state-g-unverified-row-lifecycle` (pending) names cast-hardening in its verification
    note as part of the known clean-main red bar. That note is a record, not something to edit.
  - `backend-paper-body-from-replay-and-head-endpoint` (pending) changes the enrichment route's
    revote version compare in `routes/papers.ts`. If it adds or removes a guarded revote weight
    cast there, it moves this pin too.
- No doc follow-up.
