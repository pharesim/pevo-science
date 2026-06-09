---
title: "A vote-semantic gate must cover PEvO's vote-resolution 2x2 (listing/detail and native/revote); the revote channel has no SQL gate"
date: 2026-06-09
category: conventions
module: backend/vote-resolution
problem_type: convention
component: database
severity: high
root_cause: incomplete_enumeration
resolution_type: workflow_improvement
applies_when:
  - "Adding or auditing a vote-filtering / vote-exclusion rule (self-vote, accepted-claimer, named co-author, accreditation, weight=0 retraction) on any PEvO net_votes / vote_strength / voters[] surface"
  - "Reviewing a change to batchResolveVotes or fetchEnrichmentFromHaf in backend/src/routes/papers.ts"
  - "A vote gate is expressed as a SQL predicate (a hafsql.ts helper composed into the native-vote query) and you need to confirm the revote custom_json channel is also covered"
tags: [vote-resolution, revote, cross-surface-parity, self-dealing, haf-query, code-review]
---

# A vote-semantic gate must cover PEvO's vote-resolution 2x2 (the revote channel has no SQL gate)

## Context

PEvO computes the displayed vote values (`net_votes`, `vote_strength`, the `voters[]` list) through TWO independent code paths, and EACH path merges TWO vote channels. Vote resolution is therefore a 2x2 cross-product:

- **Surface axis** (`backend/src/routes/papers.ts`): `batchResolveVotes` resolves the listing / multi-paper `net_votes`; `fetchEnrichmentFromHaf` resolves the paper-detail `net_votes` plus the `voters[]` list.
- **Channel axis**: native Hive vote ops (resolved by a SQL query) and `revote` `custom_json` ops (a vote cast after the 7-day payout window, resolved and merged in JavaScript, with **no** SQL gate of any kind).

The trap is the asymmetry between the channels. A vote-semantic rule (drop self-votes, drop an accepted authorship claimer's self-vote, drop named co-author votes, require accreditation, treat `weight=0` as retraction) is naturally written as a SQL predicate on the native-vote query, e.g. `excludeClaimedSelfWhere` from `hafsql.ts` composed into the native query, or a bare `v.voter != v.author`. That predicate covers only the two native-vote cells. The revote channel never touches it: revotes are merged in a separate JavaScript loop. A gate that looks complete in the SQL diff covers at most 1 of the 4 cells unless it is ALSO applied as an explicit JS check on both surfaces.

This surfaced when a credited authorship claimer (matched by ORCID or connected to a name-only slot, and therefore absent from the paper's `authors[].hive` list) could inflate the paper-detail `net_votes` by self-voting via a `revote`: the SQL gate dropped their native self-vote, but the revote-only merge loop in `fetchEnrichmentFromHaf` carried no claimer check, so the detail surface disagreed with the listing surface (which already skipped the claimer across both channels via its `claimedSet`).

## Guidance

When you add or audit ANY vote-semantic rule, enumerate the full 2x2 and confirm the rule fires in all four cells:

| surface \ channel | native vote op | revote custom_json |
|---|---|---|
| **listing** (`batchResolveVotes`) | SQL `WHERE` on the native query | JS skip in the merge loop |
| **detail** (`fetchEnrichmentFromHaf`) | SQL `WHERE` on the native query | JS skip in the merge loop |

Concretely:

- The SQL predicate (a `hafsql.ts` helper such as `excludeClaimedSelfWhere`) only ever covers the native-vote cells. It does nothing for revotes.
- The revote channel needs an explicit JavaScript membership check, built from the same authority data the SQL keyed on. In `fetchEnrichmentFromHaf` that is a Set built from the already-fetched claims rows, applied in BOTH the native-vote merge loop (defense-in-depth, so a revote override cannot reintroduce an excluded voter) AND the revote-only merge loop:

```ts
// The SQL gate covered only the native-vote query. Build the exclusion set
// from the same authority rows and skip in BOTH JS merge loops.
const acceptedClaimers = new Set(
  claimsResult.rows.filter((r) => r.status === 'accepted').map((r) => r.claimer),
);
// ...native-vote merge loop:
if (acceptedClaimers.has(voter)) continue; // defense-in-depth
// ...revote-only merge loop (NO SQL gate covers this cell):
if (acceptedClaimers.has(voter)) continue; // load-bearing
```

- `batchResolveVotes` merges native + revote into one voter set and applies a single `claimedSet.has(...)` skip that covers both channels at once. When you touch either surface, confirm the two surfaces reach the same exclusion, since they are expected to agree.

When REVIEWING a vote-filter change, do not stop at the SQL diff. Open the revote merge loops (`revoteMap` / the revote-only loop) on BOTH surfaces and confirm the same rule is applied there. A green test is not sufficient evidence: a mocked-pool route test that dispatches rows by SQL substring does not execute the SQL predicate, so it cannot catch a gate that lives in SQL but is missing from the JS merge. Only a case that drives a voter through the revote channel proves the JS skip exists.

## Why This Matters

Each missing cell is a silent cross-surface divergence: the listing and the paper-detail views report different `net_votes` for the same paper, and a self-dealing vote (a claimer upvoting their own credited paper, a co-author inflating a rating) slips onto whichever surface lacks the JS skip. Because the revote channel has no SQL gate at all, it is the cell most often forgotten: the SQL predicate looks complete in isolation, and the bug only appears when a voter happens to use a post-window revote rather than a native vote. The reputation SCORE path (`reputation.ts`) inlines its own gate, so a display-only miss does not move scores; it does corrupt the displayed counts and the `voters[]` list, which is a self-dealing-adjacent integrity defect.

## When to Apply

- Any change to vote exclusion/inclusion semantics on a `net_votes` / `vote_strength` / `voters[]` surface.
- Any review of `batchResolveVotes` or `fetchEnrichmentFromHaf`.
- The moment a SQL-expressed vote gate is added or changed, ask immediately: "what covers the revote channel, on both the listing and the detail surface?"

## Examples

**Before (the gap):** `fetchEnrichmentFromHaf` gated only the native-vote SQL query; the revote-only loop merged every accredited revoter, so a credited claimer self-voting via a revote inflated the paper-detail `net_votes` while the listing surface excluded them.

**After (all four cells covered):** the native-vote SQL keeps its `excludeClaimedSelfWhere` gate; an `acceptedClaimers` Set skip is applied in both the native and the revote-only JS merge loops; `batchResolveVotes` already covered both channels with `claimedSet`. The two surfaces now agree, and a behavioral test drives a claimer through BOTH a native vote and a revote and asserts exclusion on BOTH surfaces.

## Related

- `conventions/convention-sweep-syntactic-form-misses-semantic-siblings-2026-05-21.md` names `batchResolveVotes` and `fetchEnrichmentFromHaf` as the two sibling vote-resolution sites a syntactic sweep misses; this entry adds the native/revote channel axis WITHIN each site.
- `conventions/cross-surface-parity-audit-at-sibling-composition-sites-2026-05-14.md` is the general "audit every sibling surface when a shared semantic changes" discipline; the vote 2x2 is its concrete specialization for vote resolution.
- `conventions/sql-semantic-shift-cross-surface-audit-2026-05-12.md` is the SQL-semantic cross-surface audit checklist; extend it with the JS revote channel whenever the changed predicate is a vote gate.
