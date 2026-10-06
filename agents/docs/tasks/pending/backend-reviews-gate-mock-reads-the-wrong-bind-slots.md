# The reviews accreditation-gate mock reads the wrong bind slots, so two specs fail and the 404 spec tests nothing

**Owner:** backend
**Created:** 2026-10-06
**Priority:** normal

Filed at the user's request after a root-cause pass on 2026-10-06. Each of the seven backend files
that fail when run alone on clean main was diagnosed by one agent and re-checked by a second. The
failing spec sets were identical at 342f2820 and 74488ad5. Priority is normal, not low, because
this block is the only test of the unaccredited-404 branch of `GET /api/reviews/:author/:permlink`
(`reviews-real-haf.test.ts` leaves that branch to it), and it has pinned nothing since 328d563d.

## Why

`installGateResponder` in `backend/tests/routes/reviews.test.ts` (the "SQL accreditation gate"
describe) stands in for the review-fetch query. It admits a row when the bound author is in its
seed set, or when the bound author equals the bound anon account. It finds those binds at
`params[buildWith(1, activeAccreditationsCteBody).params.length]` and two slots later, which is
`params[2]` and `params[4]`.

`fetchReviewFromHaf` (`backend/src/routes/reviews.ts`) no longer builds its prefix that way. It
calls `buildRecursiveWith(1, activeAccreditationsCteBody, authorshipClaimsCteBody(idx, { claimer: author }), consentStackCteBody(idx, { signer: author }))`
and takes `authorIdx`, `permlinkIdx` and `anonIdx` from a counter that starts at
`accredCte.nextIdx`. Measured with a capturing pool: the prefix binds 16 params, the SQL reads
`WHERE c.author = $17 AND c.permlink = $18` and `OR c.author = $19)`, and those slots hold the
requested author, `r1` and `pevotest.anon`. The responder instead reads `params[2]`, which is
`pevotest` (an app-tag bind of the claims CTE), and `params[4]`, the claimer-scope bind, which
equals the requested author.

Per spec (measured, 2 failed and 6 passed, exit 1):

- **"returns 200 with the review body for an accredited reviewer"** fails with 404. The responder's
  author is `pevotest`, which is not in the seed set and differs from the requested author it reads
  as the anon account.
- **"returns 200 with is_accredited:false for a hiveAnonAccount-authored review (anon-proxy
  distinguished from direct-accredited)"** fails with 404 the same way.
- **"returns 404 for a review authored by an unaccredited Hive account"** is green but vacuous: the
  responder returns no rows for every author. Measured: with the route's anon arm rebound to
  `OR c.author = $${authorIdx}` (which admits every author), this spec stays green under the HEAD
  test. So does it with author and permlink swapped in the params array, or with the anon bind
  forced to `''`.

The comment above the offset ("Deriving the offset from the same helper the route calls keeps this
mock honest") has been false since the route stopped composing that helper alone.

Introduced by 328d563d "backend(reputation): exclude credited-claimer self-review/self-vote from
display surfaces" (2026-06-09), which added `authorshipClaimsCteBody` to the route's prefix.
c7df948b "backend(claims-cte): bound display-path claims cost per real-planner evidence" added the
claimer scope, and 2a9cb25f "backend(consent-display): extend display self-dealing exclusion to the
consented set" added the consent CTEs (acad92d9 later folded them into `consentStackCteBody`). The
test was last edited at 31b29a42 (2026-06-01). The same offset coupling drifted once before
(17c959ce). None of these commits meant to change the gate, so the specs' assertions stay.

**The production gate holds (measured).** A real-planner probe ran the real GET handler
(`fetchReviewFromHaf`, then `enrichReviewDetail` and `getAccreditedSet`) through supertest on a
read-only `pevo_app` session, with the four HAF views the SQL reads replaced by inline
`jsonb_to_recordset` rows. On unmodified code, an authority-accredited author answers 200 with
`is_accredited: true` and the anon proxy answers 200 with `is_accredited: false`. An unaccredited
author, a self-attested accredit, a sanctioned account and a WoT accredit below the vouch threshold
each answer 404. Rewriting the gate to `(TRUE OR c.author = $19)` turned every 404 into a 200, so
the 404s come from the gate. The probe does not cover HAF column-shape drift.

## Scope

1. In `installGateResponder`, read the author and anon-account binds from the slots the review SQL
   names, not from a CTE builder's bind count. The diagnosis measured this form (8/8 green). The
   implementer confirms it:

   ```ts
   const authorSlot = /WHERE c\.author = \$(\d+)/.exec(sql);
   const anonSlot = /OR c\.author = \$(\d+)\)/.exec(sql);
   if (!authorSlot || !anonSlot) {
     throw new Error('Review fetch SQL is missing the author bind or the anon-account bind');
   }
   const author = params[Number(authorSlot[1]) - 1] as string;
   const anonAccount = params[Number(anonSlot[1]) - 1] as string;
   ```

   Each regex matches exactly once in the composed SQL at HEAD (measured).
2. Drop the now-unused `buildWith` / `activeAccreditationsCteBody` import. Replace the false offset
   comment with one that states only what the responder does. Keep the existing SQL-string checks
   (the IN-arm, `OR c.author =` and the rating regex).
3. No change to `backend/src/routes/reviews.ts`, to the spec names or assertions, or to the
   carve-out headers.

## Acceptance criteria

1. `tests/routes/reviews.test.ts` passes 8/8 run alone, judged by exit code and the Errors line.
2. The responder throws when either slot is missing from the review SQL.
3. The signal block carries mutation evidence, from a scratch copy of
   `backend/src/routes/reviews.ts` run against the fixed test:
   - anon arm rebound to `OR c.author = $${authorIdx}`: "returns 404 for a review authored by an
     unaccredited Hive account" fails;
   - `author` and `permlink` swapped in the params array: both 200 specs fail;
   - anon bind forced to `''`: the anon-proxy spec fails;
   - unmodified route: 8/8.

   The first mutation is the one that matters. The HEAD test stays green under it, and a fix that
   only turns the two 200 specs green can leave the 404 spec vacuous. The verifier measured all
   four outcomes with the form in Scope item 1.
4. `npm run typecheck:tests` exits 0. `npx eslint tests/routes/reviews.test.ts` reports 0 errors
   (its two `no-explicit-any` warnings on the `hafQueryMock` declaration are pre-existing). The
   added lines pass the pre-commit anchor gate.

## Notes

- Overlap: no open task covers this file.
  - `backend-state-g-unverified-row-lifecycle` names "the reviews gate" only in its known-red
    Verification list.
  - `architect-audit-anonymous-review-comments-notifications` audits `routes/reviews.ts`, not this
    test.
  - `backend-accreditation-release-op` changes `activeAccreditationsCteBody`, which the gate
    composes. The slot-reading responder does not depend on the prefix's bind count, so landing
    order does not matter.
  - `blocked/backend-display-reads-frozen-hafsql-body` names `routes/reviews.ts` for its body
    column. If it rewrites the review SELECT, the responder's
    `SELECT c.author, c.permlink, c.body, c.json_metadata` matcher has to follow.
- Follow-ups once this lands, not in scope: the "reviews gate" entries in task signal blocks'
  known-red lists go stale. `reviews-real-haf.test.ts` says the unaccredited-404 branch
  "remains pinned in mocked-pool coverage" in this block. The fix makes that true again, so it
  needs no edit.
- Residuals in the same file, different defect class, not in scope: comment-anchor violations that
  the pre-commit gate does not see, because it checks added lines only.
  - The describe title "(backend-papers-filter-accreditation lane 4)" is part of the spec names.
  - "Lane-4 canary block".
  - "Round-2 hold item 3b for backend-pevo-string-helper-adoption-sweep".
  - "round-4 carry-forward of backend-review-validity-gate-and-display-reputation-parity".
  - `papers.ts ~2195` in the gate block's carve-out clause (c). From the code, that line no longer
    holds the cited `c.author = ANY(...)` filter, which now sits in `fetchEnrichmentFromHaf`.

  Any rewrite of clause (c) must keep (a)/(b)/(c) true. A separate low-priority sweep can take
  these.
- From the code, not measured: `config.hiveAnonAccount` falls back to `'pevo.anon'`, so the
  anon-proxy spec's `if (!anonAuthor)` branch never runs. No change proposed.
- Probe-only, not proposed as new specs (no preemptive hardening): the sanctioned, self-attested
  and below-threshold WoT cases above.
