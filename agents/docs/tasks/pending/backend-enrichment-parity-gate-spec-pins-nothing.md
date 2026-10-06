# The enrichment parent-paper gate spec matches no query since a CTE shifted its placeholders, and its substring check no longer pins the gate

**Owner:** backend
**Created:** 2026-10-06
**Priority:** normal

Filed at the user's request after a root-cause pass on 2026-10-06. Each of the seven backend files
that fail when run alone on clean main was diagnosed by one agent and re-checked by a second; the
failing spec sets were identical at 342f2820 and 74488ad5. Priority is normal, not low: this spec
is the only pin the re-check found on the `/enrichment` reviews parent-paper gate, a route-level
security gate, and it has pinned nothing since 328d563d.

## Why

In `backend/tests/routes/papers-enrichment-parity-gate.test.ts`, the spec "reviews query composes
validPevoPaperWhere on parent paper (mutation-kill)" fails alone with
`expected 0 to be greater than or equal to 1` (measured). The single-flight spec in the same file
passes.

**Root cause: the filter matches no query (measured).** The spec picks the reviews SQL out of the
captured queries with
`s.includes('AS net_votes') && s.includes('c.parent_author = $1') && s.includes('c.parent_permlink = $2')`.
328d563d "backend(reputation): exclude credited-claimer self-review/self-vote from display
surfaces" (2026-06-09) put a CTE (`detailCte`) in front of the reviews query in
`fetchEnrichmentFromHaf` (`backend/src/routes/papers.ts`). The paper key now binds through
`$${drAuthorIdx}` / `$${drPermlinkIdx}`, which follow the CTE params: `$17` / `$18` at HEAD.
`'c.parent_permlink = $2'` matches neither. The unchanged test file passes 2/2 on an archive of
328d563d^ and fails with the same assertion on 328d563d. The file was last touched by 623bee26
"backend(cache): add single-flight coalescing to QueryCache.getOrSet" (2026-05-17).

**Fixing only the filter would leave the spec pinning nothing (measured).** The content check is
`toContain("= 'paper'")` and `toContain("= 'bridge_paper'")` over the whole SQL string. Since
319f0c3c "backend(consent): U2+U3 remove metadata auto-accept; chain-aware Route 3; wire Route-2
consented credit into the cycle" (2026-06-10), `authorshipClaimsCteBody` embeds a
`claims_`-prefixed `consentChainCteBody`, which composes `validPevoPaperWhere` on alias `c`.
2a9cb25f "backend(consent-display): extend display self-dealing exclusion to the consented set"
(2026-06-11) added the unprefixed chain and the `consentedAuthorsCteBody` bridge arms on `bp` and
`rc`. At HEAD the reviews SQL holds 5 `= 'paper'` and 11 `= 'bridge_paper'` substrings, and one of
each is the gate on `p`. With the filter made index-agnostic and the content check unchanged, the
spec stays green when the gate on `p` is deleted, narrowed to `source: 'native'` or
`source: 'bridge'`, or moved to alias `c`.

**The gate itself holds (measured).** Under the spec's mocked pool the route answers 200, and the
reviews query reads
`JOIN hafsql.comments p ON p.author = $17 AND p.permlink = $18 WHERE c.parent_author = $17 AND c.parent_permlink = $18 ... AND ((p.json_metadata -> $19 ->> 'type') = 'paper' OR (p.author = $21 AND (p.json_metadata -> $19 ->> 'type') = 'bridge_paper'))`,
with `$19` the APP_TAG and `$21` the bridge account. 328d563d changed only the placeholder numbers
on this line. The re-check ran the emitted gate over synthetic VALUES rows in a read-only
transaction. Only a native `'paper'` parent and a `'bridge_paper'` parent posted by the bridge
account let a reply through. A blog post, a non-paper PEvO post, a `'bridge_paper'` posted by
another account and a missing parent returned no rows. This is test drift. No production change is
needed.

## Scope

All in `backend/tests/routes/papers-enrichment-parity-gate.test.ts`. The matchers below were
measured in a probe copy; the implementer confirms them.

1. Filter: `s.includes('AS net_votes') && /WHERE c\.parent_author = \$\d+ AND c\.parent_permlink = \$\d+/.test(s)`.
   It ignores placeholder numbers and does not match the CTEs' `c.parent_author = ''` lines. At
   HEAD it matches exactly one captured SQL.
2. Content check: assert on `const outer = sql.slice(sql.lastIndexOf('AS net_votes'))`, which
   holds the outer FROM / JOIN / WHERE of the reviews query and none of the prepended CTEs:
   - native arm: `/\(p\.json_metadata -> \$\d+ ->> 'type'\) = 'paper'/`
   - bridge arm: `/p\.author = \$\d+ AND \(p\.json_metadata -> \$\d+ ->> 'type'\) = 'bridge_paper'/`

   These replace `nativePaperSubstring` and `bridgePaperSubstring`. Keep the two failure messages.
3. Narrow or delete the comments in the file that the new matchers make false, or that are false
   now:
   - The header's canary 1 entry ("pinned via the `'paper'` and `'bridge_paper'` substrings
     emitted by the helper") and its "Mutation kill (canary 1)" sentence. Both should describe the
     helper's two arms on alias `p` in the outer WHERE.
   - The comment over the filter. It describes a payload-shape match
     (`c.author, c.permlink, c.body, ...`) that the filter does not make.
   - The header's closing Note ("`fetchEnrichmentFromHaf` may return null in the mocked
     environment because adjacent sub-queries ... return empty rows") and the in-spec "Status may
     be 200 or 404" comment. From the code, the function returns null only with no pool or an
     aborted walker signal, and the route answered 200 under the spec's mock (measured). Delete the
     null-path reasoning. The point that the spec asserts on the emitted SQL, not the status, can
     stay.
4. Leave the carve-out items (a)/(b)/(c) and the single-flight spec as they are (see Notes).
   Change nothing under `backend/src`.

## Acceptance criteria

1. The file passes alone, judged by exit code and the Errors line, with `backend/src` unchanged.
2. The signal block carries mutation evidence from a scratch copy. Apply each mutant alone to the
   reviews query in `fetchEnrichmentFromHaf`. The spec must go red on each and green again once
   restored:
   - M1: the `validPevoPaperWhere({ commentAlias: 'p', ... })` line deleted;
   - M2: its `source: 'all'` changed to `'native'`;
   - M3: its `source: 'all'` changed to `'bridge'`;
   - M4: its `commentAlias: 'p'` changed to `'c'`.

   A filter-only variant (index-agnostic filter, whole-SQL `toContain` kept) stayed green on all
   four at filing, so a green run at HEAD alone does not show the spec pins anything.
3. No comment in the file says the gate is pinned through the `'paper'` / `'bridge_paper'`
   substrings, or that empty mocked rows make `fetchEnrichmentFromHaf` return null.
4. The diff touches only this test file. The single-flight spec is unchanged and green.
   `npm run typecheck` exits 0. The pre-commit anchor gate passes on the added lines.

## Notes

- Overlap: no open task covers this file. It appears only in the Verification red-bar list of
  `backend-state-g-unverified-row-lifecycle`. Two tasks touch the same code:
  - `backend-paper-body-from-replay-and-head-endpoint` changes the enrichment route's review
    `outdated` compare and its cache eviction (from that task's text). The matchers in Scope do not
    depend on the reviews query's placeholder numbers, so landing order does not matter.
  - `architect-audit-paper-routes-and-consent` audits `routes/papers.ts`.
- Carve-out clause (c), for the architect. The header says the risk class "is caught by"
  `review-parity-invariant.test.ts` and `reputation-lifecycle.test.ts`. From the code, neither would
  fail if the enrichment gate were dropped:
  - the first keeps its own copy of the enrichment display SQL, with no `validPevoPaperWhere` on
    `p`;
  - the second asserts that `computeReputationBatch` is deterministic.

  The header's "Literal-route real-HAF coverage for `/enrichment` parent JOIN remains a follow-up"
  names no filed task. Root CLAUDE.md "Running Tests" (c) needs a real-path companion or a filed
  follow-up. This task leaves (a)/(b)/(c) alone and changes only the test's matchers. Narrowing (c),
  and filing or dropping the follow-up, is a separate decision.
- Residual, same defect class, another file: `tests/routes/profile-stats-parity-gate.test.ts`
  checks `getProfileStats`'s SQL with whole-SQL `"= 'paper'"` / `"= 'bridge_paper'"` substrings,
  and that query also composes `authorshipClaimsCteBody`. With the `AND ${paperGate}` line deleted
  from `getProfileStats` in a probe copy, its spec "user_reviews CTE composes validPevoPaperWhere
  on parent paper (mutation-kill)" stayed green. That was one mutant, not investigated further. The
  file is not on the red bar. Triage separately. The other `*-parity-gate` files were not checked. From the code, not measured: the spec "review fetch SQL composes validPevoPaperWhere on parent paper (mutation-kill)" in `tests/routes/reviews.test.ts` makes the same whole-SQL `"= 'paper'"` / `"= 'bridge_paper'"` check. `fetchReviewFromHaf` composes `authorshipClaimsCteBody` and `consentStackCteBody`, whose consent chains carry both substrings on alias `c`.
- Observation from the code, not assessed as a defect: the voters and claims queries in
  `fetchEnrichmentFromHaf` carry no paper-class gate. For a directly addressed non-paper
  `(author, permlink)`, the route answers 200 with empty reviews but can list accredited voters.
  It is display-only and outside this spec. The paper-routes audit is the place to triage it.
- The single-flight spec passes alone (measured). This pass did not mutation-check it.
- The regex matchers follow `validPevoPaperWhere`'s emitted text. If the helper's spacing, alias
  handling or operators change, this spec goes red instead of passing silently.
