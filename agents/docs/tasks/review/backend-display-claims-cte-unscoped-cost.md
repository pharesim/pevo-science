# BACKEND-DISPLAY-CLAIMS-CTE-UNSCOPED-COST — unscoped authorshipClaimsCteBody on hot listing/search/stats display paths; per-row LATERAL re-eval + no-catch cascade

**Owner:** backend
**Created:** 2026-06-09 (architect `/ce-code-review` follow-up from `backend-claimer-self-review-display-callsite-exclusion`; performance + adversarial lenses)
**Priority:** P2 (latent perf/reliability risk on the live beta. "Claims are low-cardinality" holds today, so this is not a correctness break — but the hot listing path now depends on claim-set cost, and a planner-stats shift or a claim-spam flood could surface it.)

## Problem

`backend-claimer-self-review-display-callsite-exclusion` threaded `authorshipClaimsCteBody` into the display review/vote surfaces to exclude credited-claimer self-reviews/self-votes. On the multi-paper surfaces it is materialized UNSCOPED (full claim set), and on the listing path it is referenced inside a per-row LATERAL via `excludeClaimedSelfWhere`'s `NOT EXISTS`. Two concerns surfaced in review (performance, confidence 75; adversarial cascade, confidence 50):

1. **Per-row LATERAL re-evaluation.** PG12+ inlines single-reference CTEs by default. If the planner inlines `authorship_claims` into the listing's `reviewAggLateral`, the full `claim_events -> claims_base -> approvals -> revocations -> authorship_claims` chain (including correlated EXISTS against `hafsql.comments`) re-runs once per paper row on the page. Each scan is `custom_id`-selective and fast today, but the inlining behavior is unverified.
2. **No-catch cascade coupling.** The new accepted-claims query sits in a `Promise.all` with no per-query catch, so a claim-cardinality-induced statement_timeout (a flood of cheap pending `claim_authorship` ops bloats the pre-status-filter CTE materialization) would reject the whole listing, not just the exclusion. An accredited attacker can spam pending claims cheaply.

## Goal

Bound the claims-CTE cost on the hot display paths and decouple listing availability from claim cardinality, without weakening the exclusion semantics that the parent task established.

### Suggested approach

- Confirm with EXPLAIN ANALYZE whether PG fences `authorship_claims` above the listing LATERAL or inlines it per-row. If per-row: `AS MATERIALIZED` on the CTE, or restructure `excludeClaimedSelfWhere` as a LEFT JOIN anti-join evaluated once outside the LATERAL.
- Scope the listing/search/stats claims materialization by the page's paper-key set (bounded by page size) instead of unscoped, OR confirm a single per-page scan is acceptable and pin it.
- Decouple the accepted-claims query from listing availability: catch/degrade (serve un-excluded but available) rather than reject the whole `Promise.all`, OR document why a claims-query failure should fail the listing.
- Single-review fetch (`reviews.ts`) should scope `authorshipClaimsCteBody` by `{ claimer: author }` (currently unscoped, and not cached per-review-URL at the hafCache layer).

## Acceptance

- EXPLAIN ANALYZE evidence recorded (inlined-per-row vs fenced-once) for the listing path.
- The hot listing/search/stats display query cost is bounded by page size, not total claim history (or a documented rationale + pin if a single per-page scan is kept).
- A claims-query timeout no longer fails the entire listing (degrade, or documented rationale for fail-closed).
- `reviews.ts` single-review fetch scopes the claims CTE by claimer.
- Exclusion semantics unchanged (the behavioral canary from the parent task stays green).
- `npm run typecheck` + `npm run lint` clean; comment anchors on stable symbols.

## Cross-references

- `backend/src/routes/papers.ts` (`fetchPapersFromHaf` listing `reviewAggLateral`; `batchResolveVotes` claims query; `fetchEnrichmentFromHaf`), `search.ts`, `stats.ts`, `reviews.ts`.
- `backend/src/hafsql.ts` (`authorshipClaimsCteBody`, `excludeClaimedSelfWhere`, `buildWith`).
- Parent: `backend-claimer-self-review-display-callsite-exclusion`.
- Related: the BitmapAnd-toxic-floor + statement_timeout-budget learnings under `agents/docs/solutions/`.

## Implementation note (backend, 2026-06-10)

### EXPLAIN ANALYZE evidence (acceptance item 1)

Gathered against the live HAF node (PostgreSQL 17.5) with the production listing SQL reconstructed verbatim from the same exported builders + literal fragments (default page: limit 20, no filters, sort created desc). **Verdict: HYBRID.** The expensive chain underneath `authorship_claims` stays FENCED once per query regardless (the recursive `claims_chain_tree` / `claims_canonical_chain` members cannot be inlined, and `claim_events` / `claims_base` / `approvals` are multi-referenced, so PG12+'s single-reference inlining rule never applies to them) — the per-row LATERAL can never re-run the chain WALK. But the outer single-referenced `authorship_claims` CTE body WAS inlined into the rev_agg LATERAL as a Nested Loop Anti Join whose inner re-scans the materialized `claims_base` tuplestore with the full status-CASE (correlated subplans over claim_events/approvals) per LATERAL rescan, and the planner costs that inlined scan at ~8.37M per rescan (47M total estimate). On the current corpus the claims nodes showed `loops=0` (`never executed`: no qualifying accredited review rows yet; execution 3.4 ms total), so today's measured claims share is 0 — the exposure is structural, materializing as soon as reviews land. An `AS MATERIALIZED` variant produced a fenced `CTE authorship_claims` node with the LATERAL inner reduced to a trivial CTE Scan (estimated 27 vs 8.37M) and no measurable downside (4.0 vs 3.4 ms, noise). Full plans were captured during the session at `/tmp/listing-plan.txt` / `/tmp/listing-plan-materialized.txt` (ephemeral; the verdict above is the durable record).

### Changes landed

1. **`authorship_claims AS MATERIALIZED` in `authorshipClaimsCteBody`** (`hafsql.ts`) — resolves claim status exactly once per query for every consumer; the per-row LATERAL `NOT EXISTS` now reads the fenced result instead of re-evaluating the status CASE per rescan. No-op for the reputation cycle (multi-referenced there, so it was already materialized). Docblock records the rationale; a `hafsql.test.ts` canary pins the keyword (dropping it silently re-opens the per-rescan class); the two reputation cycle-shape pins (`reputation-approve/revoke-signer-gate-cycle-sql-shape.test.ts`) updated to the new opener.
2. **New `{ papers: Array<{author, permlink}> }` scope variant** on `AuthorshipClaimsScope` (composite IN over bound pairs filtering `claim_events`, so `claims_base` and the embedded chain walk are bounded by the page's paper-key set; empty list emits a well-formed `FALSE` backstop). `batchResolveVotes` (`papers.ts`) now scopes its accepted-claims query by the page's papers instead of unscoped — a flood of cheap pending claims on unrelated papers can no longer inflate the vote batch's materialization. Param-arithmetic + empty-backstop unit tests added; a real-HAF scope-equivalence test (papers variant matches unscoped + JS post-filter, with a decoy pair) mirrors the existing claimer/claimers/paper equivalence pins.
3. **Decoupled the vote batch from claims availability** (`papers.ts` `batchResolveVotes`): the accepted-claims query now catches, warns, and degrades to an empty claimed-set (votes served un-excluded) instead of rejecting the whole `Promise.all`. Rationale documented at the site: votes are the surface's core data; the claimed-self-vote exclusion is a display-parity refinement whose authoritative enforcement is the reputation cycle, so a claims statement_timeout degrades display parity for one volatile-cache window instead of 503ing the listing. Native-vote / revote failures still fail the batch (without them there is no vote data at all).
4. **`reviews.ts` single-review fetch scopes the claims CTE by `{ claimer: author }`** — the only claimer `excludeClaimedSelfWhere` ever correlates on that surface — bounding the embedded walk by one account's claim activity per fetch.
5. **In-statement listing/search/stats claims stay unscoped by design, with the rationale pinned at each site**: the page/result membership is computed inside the same statement (WHERE + ORDER BY + LIMIT), so no paper-key scope can be bound up front; the accepted cost is ONE claims resolution per query (bounded by claim cardinality via the claims_base-seeded walk), now guaranteed by the MATERIALIZED fence. This is the task's "confirm a single per-page scan is acceptable and pin it" arm, chosen on the EXPLAIN evidence above.

### Exclusion semantics unchanged

The parent task's behavioral canaries stay green: `display-claimer-self-review-exclusion` + `display-claimer-self-vote-revote-exclusion` (5/5).

### Verification

`npm run typecheck` (src + tests) clean; `npm run lint` clean except the known pre-existing `author-supersession.ts` warning. Suites green: `hafsql.test.ts` (40 + 4 data-dependent skips), both reputation cycle-shape pins, both display-exclusion canaries, `me-pending-authorships-real-postgres`, `consented-authors-cte-real-postgres`, `claims`, `listing-count-window-function-shape` (98 passed across 9 files), plus real-HAF `papers.test.ts` / `stats.test.ts` / `profile.test.ts` / all three search suites (94 passed) — the fenced builder executes on live HAF. `reviews.test.ts`: 6 passed + the 2 documented pre-existing SQL-accreditation-gate failures, re-confirmed pre-existing this session by stashing the reviews.ts edit and re-running (same 2 fail on the unmodified file).

---

## Architect re-review (2026-06-11) — HELD PENDING FIXES (2 items)

`/ce-code-review` fan-out on commit `c7df948b` (correctness + adversarial on the session model; performance/reliability/testing/maintainability/project-standards + learnings on Sonnet; ce-agent-native skipped per PEvO). **The cost work is verified sound**: AS MATERIALIZED is semantics-preserving and pessimizes no consumer (the {papers}/{claimer} scopes filter inside the CTE body, so the fence blocks no pushdown; the cycle was already multi-reference-materialized); the {papers} composite-IN cannot starve the chain walk (it seeds from claims_base and follows continues pointers regardless of page membership — the real-HAF equivalence test with the decoy pair pins it); the FALSE backstop is well-formed and the empty-page guard short-circuits before it; the degrade catch is attached to exactly the claims query (native/revote failures still reject); a transiently degraded result lives one volatile window; the warn is per-batch; the degrade-vs-fail-closed asymmetry is documented at every touched site and does not conflict with the cycle's fail-closed rule (no cursor advances; display-parity refinement whose authoritative enforcement is the cycle). Comment anchors, carve-out compliance, commit hygiene, and zone discipline clean. Two items before archive (user-triaged):

1. (P2, testing — corroborated by adversarial, reliability, and the behavior-change-coverage-gap convention) **Pin the degrade path.** The claims-failure catch in `batchResolveVotes` is this commit's central behavior change and has zero coverage: deleting the catch makes any claims failure reject the whole vote batch again (the exact availability hazard this task fixed) with a fully green suite — the behavioral canaries exercise only the happy path. Add a mocked-pool test injecting a rejection on the claims leg, asserting (a) the batch resolves rather than rejects, (b) votes are served with the claimed self-vote present (exclusion degraded), and (c) a native-vote rejection still rejects the batch (the asymmetry pin).
2. (P3, correctness, conf 100, comment-only — four edits in one pass)
   - `excludeClaimedSelfWhere` docblock: update the "Scope requirement" paragraph to the landed design (in-statement multi-result surfaces stay unscoped because page membership is computed in the same statement and the MATERIALIZED fence pins one resolution per query; batch key-set surfaces pass {papers}; single-claimer {claimer}; single-paper {paperAuthor, paperPermlink}) and drop the retired "claim ops are low-cardinality, so the full materialization is cheap" rationale. Leave the "exactly as the score path does" parity sentence alone — the `backend-consented-set-display-self-dealing-exclusion` task owns making that sentence true again.
   - `reputation-revoke-signer-gate-cycle-sql-shape.test.ts` header pin #1: it quotes the opener `authorship_claims AS (` while its own assertion requires `authorship_claims AS MATERIALIZED (`. Quote the current opener or drop the opener quote (the approve-gate sibling's phrasing is fine).
   - The degrade catch comment in `batchResolveVotes`: state the actual tail (statement_timeout, ~30s per the HAF pool's onConnect setting in db.ts) so the bound is computable at the site.
   - The {papers} scope docblock: soften "Callers MUST NOT pass an empty array" — the FALSE backstop makes empty safe by construction; the batchResolveVotes early-return is an optimization, not the safety mechanism.

Recorded residuals (no action this task): a corpus-wide pending-claim flood can still push the unscoped listing/search/stats resolution past statement_timeout, where fetchPapersFromHaf swallows to null and serves 200 with an empty listing (pre-existing class; the accepted one-resolution-per-query bound is cardinality-relative; an approved-only claims_base prefilter for accepted-only consumers is noted as a future mitigation if claim spam materializes). Under a SUSTAINED on-chain flood the vote-batch degrade re-fires every refresh — the "one volatile-cache window" framing describes transient failures. The pre-existing stats.ts slug anchor belongs to the blocked comment-anchor sweep task. A /ce-compound entry on the degrade-vs-fail-closed boundary is queued for archive time.

When both items land, `git mv` this file back to `tasks/review/`; the move is the re-review signal, scoped to the fix commits. Do not edit this hold block — the commit diff is the evidence; the architect updates it at re-review.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>

---

## Backend re-review signal (2026-06-11, single fix commit on main)

Both hold items landed:

1. **Degrade-path pin** — new describe in `tests/routes/display-claimer-self-vote-revote-exclusion.test.ts` ("claims-leg failure degrades instead of rejecting"), two tests: (a)+(b) a claims-leg rejection resolves the batch with the claimed self-vote PRESENT (net_votes 2 — exclusion degraded, not rejected); (c) a native-vote rejection still rejects the batch (the asymmetry pin). File header extended to name the availability boundary and to cover the per-leg rejection injection under carve-out clause (a).
2. **Four comment edits** — `excludeClaimedSelfWhere` Scope paragraph rewritten to the landed design (in-statement surfaces unscoped + MATERIALIZED-fence rationale; `{papers}` / `{claimer}` / `{paperAuthor, paperPermlink}` by surface shape; the retired low-cardinality rationale dropped; the "exactly as the score path does" parity sentence untouched); the revoke-gate cycle-shape header now quotes the current `authorship_claims AS MATERIALIZED (` opener; the `batchResolveVotes` degrade catch comment states the worst-case tail (connection-level `SET statement_timeout = 30000` in db.ts, ~30s); the `{papers}` docblock states empty-array safety by construction (FALSE backstop), early return as optimization.

Beyond the named items, same stale-quote class one line below the flagged opener: the revoke-gate header's pin-#2 quote read `$23, $25` while the test's own green assertion requires `$22, $24`; aligned the header quote with the assertion.

Verification: both display-exclusion canaries + both cycle-shape pins 9/9; `npm run typecheck` (src+tests) clean; `npm run lint` clean except the known pre-existing `author-supersession.ts` warning.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>

---

## Architect re-review (2026-06-12) — HELD PENDING FIXES (round 2, 1 item)

`/ce-code-review` fan-out on fix commit `18f7fcb8` (correctness on the session model; testing/maintainability/project-standards + learnings on Sonnet; ce-agent-native skipped per PEvO). Both round-1 items verified landed: mutant analysis confirms the degrade pin kills both the catch-deletion and catch-widening mutants (the claims/native/revote SQL discriminators in the mock dispatch cannot collide, so the injection reaches the right leg); all four comment edits are factually accurate against the code (the ~30s statement_timeout bound, the FALSE backstop, the scope enumeration matching every call site, the MATERIALIZED rationale); the self-reported pin-#2 quote alignment is correct. One item before archive (user-triaged):

1. (P2, correctness + maintainability corroborated, conf 100) **Two stale `$23/$25` quotes survive in the very file the fix edited.** `tests/routes/reputation-revoke-signer-gate-cycle-sql-shape.test.ts` line 22 (header cross-reference paragraph: "The builder's internal param POSITIONS (that $23/$25 bind bridge/admin)") and line 74 (the `it()` title: "with the revoke gate at $23/$25 (builder allocation)") now contradict the corrected `$22/$24` quotes at lines 16-17 and 94-99 and the test's own green assertion; the `it()` title prints the wrong slots in failure output. Fix: line 22 — drop the absolute indices (the cross-referenced `hafsql.test.ts` suite pins *relative* param arithmetic, so absolute slots are the wrong anchor there) or correct to $22/$24; line 74 — retitle to $22/$24 or drop the indices from the title.

Recorded at triage (no action): the ~30s-tail comment stays accurate only while `batchResolveVotes` receives the raw `getPool()` pool (a future retry wrapper would silently invalidate the stated bound); the degrade test's claims-leg SQL-substring dispatch would rot silently if the claims SQL is reworded (preemptive-hardening class, dismissed).

When the item lands, `git mv` this file back to `tasks/review/`; the move is the re-review signal, scoped to the fix commit. Do not edit this hold block — the commit diff is the evidence; the architect updates it at re-review.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>

---

## Backend re-review signal (2026-06-12, fix commits on main) — round-2 item landed

1. **Both stale `$23/$25` quotes fixed** in `reputation-revoke-signer-gate-cycle-sql-shape.test.ts`: the header cross-reference paragraph now describes `hafsql.test.ts`'s suite as pinning startIdx-RELATIVE offsets (absolute indices dropped per the prescription — absolute slots are the wrong anchor for that suite); the it() title is retitled to `$22/$24`, matching the test's own green assertion and the indices-in-title form of the approve-gate sibling.

Beyond the named item, same stale-quote class found in the approve-gate sibling (`reputation-approve-signer-gate-cycle-sql-shape.test.ts`) while aligning title forms: its header quoted `ap.approver IN (ap.paper_author, $23)` / "binds `config.hiveBridgeAccount` at $23" and its it() title said $23, contradicting its own green `$22` assertion and its in-file allocation comment. Aligned with the same treatment in a separate commit: assertion-quoting sites corrected to `$22`, the `hafsql.test.ts` cross-reference reworded to relative-offset phrasing, title retitled to `$22`.

Verification: both cycle-shape suites green; `npm run typecheck` (src+tests) clean; `npm run lint` clean except the known pre-existing `author-supersession.ts` warning.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
