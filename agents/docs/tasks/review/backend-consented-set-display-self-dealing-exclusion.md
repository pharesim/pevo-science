# BACKEND-CONSENTED-SET-DISPLAY-SELF-DEALING-EXCLUSION — extend the display self-dealing exclusion from accepted claims to the full consented set

**Owner:** backend
**Created:** 2026-06-11 (architect `/ce-code-review` of `backend-implement-consented-authorship-model`; correctness + adversarial corroborated, validated at HEAD; user-elected at triage)
**Priority:** P2 (latent cycle-vs-display drift; it goes live the moment the first `author_accept` lands on chain. The UI consent surface is still blocked, so there is lead time, but this should land before consent affordances ship.)

## Problem

The reputation cycle now excludes ANY consented author's self-votes/self-reviews (both NOT EXISTS self-dealing gates in `computeReputationBatch` were generalized to the consented set). The display surfaces still exclude only Route-3 accepted-claims self-dealing:

- `excludeClaimedSelfWhere` (hafsql.ts) tests `authorship_claims.status = 'accepted'` only — consumed by the listing rev_agg LATERAL, the paper-detail review list, reviews.ts, profile.ts, search.ts, and stats.ts.
- `batchResolveVotes` (papers.ts) drops self-votes/revotes against the accepted-claims set only.

Since the metadata auto-accept arms were deleted, a Route-2 consented co-author (ORCID- or hive-anchored `author_accept`) has NO accepted-claims row: the cycle excludes their self-votes/reviews, but displayed `avg_rating` / `review_count` / `net_votes` count them. The `excludeClaimedSelfWhere` docblock parity promise ("exactly as the score path does") is broken for the consented set. This is the cycle-vs-display drift class the shared-builder design exists to prevent.

## Goal

Display review/vote aggregates exclude self-dealing by the SAME credited set the cycle uses: accepted claims plus consented authors (Routes 1/2/3 minus demotions).

### Suggested approach

- Add a consented-set sibling of `excludeClaimedSelfWhere` (NOT EXISTS over `consented_authors`), composed from `consentChainCteBody` + `consentedAuthorsCteBody` — or a combined credited-set helper covering both populations.
- Scoping needs the same care the claims CTE got in `backend-display-claims-cte-unscoped-cost`: per-paper scope on detail/reviews; on listing/search/stats either a bounded seed or the accepted one-fenced-resolution-per-query shape with a MATERIALIZED pin and a rationale comment. Gather EXPLAIN evidence on the listing path before choosing.
- Update the `excludeClaimedSelfWhere` docblock parity sentence ("exactly as the score path does") to describe the combined set once it is true again.
- Cycle-vs-display parity tests: a Route-2 consented co-author's self-review/self-vote excluded from listing avg_rating/review_count, the detail review list, and batchResolveVotes net_votes — the inverted sibling of the existing claimer display canaries.

## Acceptance

- A Route-2 consented co-author's self-review/self-vote is excluded from every display aggregate that already excludes Route-3 claimer self-dealing (listing, detail, reviews, profile, search, stats, vote batch).
- Display cost stays bounded per the claims-CTE precedent (EXPLAIN evidence recorded for the listing path; rationale pinned at unscoped sites if that arm is chosen).
- Accepted-claims exclusion semantics unchanged (existing canaries stay green).
- `npm run typecheck` + `npm run lint` clean; comment anchors on stable symbols.

## Cross-references

- `backend/src/hafsql.ts` (`excludeClaimedSelfWhere`, `consentChainCteBody`, `consentedAuthorsCteBody`), `backend/src/routes/papers.ts` (`batchResolveVotes`), `reviews.ts`, `search.ts`, `stats.ts`, `profile.ts`.
- Parents: `backend-implement-consented-authorship-model` (the credited-set change), `backend-display-claims-cte-unscoped-cost` (the cost-bounding precedent).
- `backend-consented-set-read-surfaces` (the badge consumes the same consent stack per-paper).
- `ui-multi-author-consent-affordances` (blocked — should not ship ahead of this fix).

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>

---

## Implementation note (backend, 2026-06-11)

Display review/vote aggregates now exclude self-dealing by the full credited set (accepted claims ∪ consented authors, Routes 1/2/3 minus demotions) — the same two NOT EXISTS gates the cycle composes.

**hafsql.ts infrastructure:**
- `excludeConsentedSelfWhere` — the Route-1/2 sibling of `excludeClaimedSelfWhere` (NOT EXISTS over `consented_authors`), with a scope-requirement docblock mirroring the claims precedent. The claims helper's parity sentence now describes the PAIR ("compose BOTH helpers at every display aggregation site").
- `consentSeedCteBody` — the display-surface walk seed: distinct roots cited by any `author_accept`/`author_resign` op, feeding `consentChainCteBody({rootsFromCte:'consent_seed'})`. Exclusion-completeness rationale in the docblock: a paper with no accept op has no Route-2 member, and its Route-1 root is already dropped by the existing poster gates, so skipping it is cycle-parity, not approximation. Scope variants: unscoped (in-statement multi-result surfaces), `{signer}` (single-account surfaces), `{papers}` (page-bounded batch; empty list emits a FALSE backstop).
- `consented_authors AS MATERIALIZED` — same fence rationale as `authorship_claims` (single-referenced from per-row LATERAL NOT EXISTS on the listing); no-op for the cycle (multi-referenced, already materialized). Pinned by a hafsql.test.ts canary mirroring the claims pin; the consented cycle-shape pin's opener quote updated.

**Surfaces (all seven from the acceptance list):**
- Listing (`fetchPapersFromHaf`): consent stack composed unscoped; `excludeConsentedSelfWhere` ANDed in the rev_agg LATERAL; rationale comment updated.
- Vote batch (`batchResolveVotes`): the claims leg became the credited-set leg — `{papers}`-scoped claims + `{papers}`-seeded consent stack in ONE query (`accepted UNION consented`), feeding the renamed `creditedSet` skip. Same single degrade catch (availability boundary unchanged; the round-1 degrade pins still pass against the union leg).
- Paper detail / enrichment: per-paper chain scope on the detailCte; consented gate ANDed on the vote AND review queries; the JS revote channel skips `consentedAccounts` (resolved via `fetchConsentedAccountsForPaper`, the badge's shared volatile entry) alongside `acceptedClaimers` in both merge loops.
- reviews.ts (single review): `{signer}`-seeded + `{signers}`-narrowed stack; gate ANDed.
- profile.ts (stats + reviews count/data): `{signer}`/`{signers}` scoped; gate ANDed at all three query sites.
- search.ts + stats.ts: unscoped stack + gate, rationale pinned at each site.

**EXPLAIN evidence (acceptance item 2), live HAF (PG 17.5), production listing SQL captured via a pass-through pool from the real route (default page, limit 20):** `CTE consented_authors` materializes as a fenced top-level node (cost ~39), resolved at most once per query; the rev_agg LATERAL's gates read trivial CTE Scans (`authorship_claims ac` cost 27.12, `consented_authors cca` cost 0.05) — no per-rescan re-resolution of either stack. Both chain backbones (`claims_chain_tree`, unprefixed `chain_tree`) coexist; the Route-2 walk seeds from `consent_seed`. Consented nodes show `loops=0` (`never executed`) on the current corpus — the same structural-exposure profile as the original claims evidence. Whole listing: Execution 8.26 ms, Planning 21.6 ms. Plan captured during the session at `/tmp/listing-plan-consented.txt` (ephemeral; this verdict is the durable record).

**Tests:**
- New `tests/routes/display-consented-self-dealing-exclusion.test.ts` — the inverted sibling of the claimer canaries: source-level shape pin (all surfaces compose the gate; net_votes paths carry the consented skip), synthetic-VALUES behavioral parity on real Postgres (consented self-review dropped; third-party AND resigned-no-row author kept), `batchResolveVotes` cross-channel consented self-vote exclusion, and the `/enrichment` consented self-revote exclusion.
- `consented-authors-cte-real-postgres.test.ts` — new equivalence pin: the display `consent_seed` composition resolves IDENTICALLY to all-roots on consent-active papers; the only rows the seed misses are Route-1 roots of consent-op-less papers (asserted exactly: the bridge paper's own poster).
- `hafsql.test.ts` — `consentSeedCteBody` param arithmetic (all three scopes + empty-papers FALSE backstop) and the `consented_authors` MATERIALIZED canary.
- Updated pins: claimer canary source pins (`creditedSet`), the consented cycle-shape opener, and `profile-reviews-accred-gate`'s live param-slot derivation (now mirrors the route's four-body composition — its own docblock records the re-staling).

**Verification:** consent/display battery 13 files green (111 passed / 4 data-dependent skips) including both claimer canaries, the new sibling, the real-postgres suites, both cycle-shape pins, and the behavioral cycle canary (the fence executes through the real composed cycle SQL). Live-HAF: papers (15), profile + search (39), profile gates green; `stats-profile-parity` green in isolation (documented load-flake). `reviews.test.ts` 2 failures and `papers-enrichment-parity-gate` 1 failure both re-confirmed pre-existing this session by reverting the respective file to HEAD and re-running (same specs fail unmodified). `npm run typecheck` (src+tests) clean; `npm run lint` clean except the known pre-existing `author-supersession.ts` warning.

**Residual (recorded, no action):** notification surfaces do not aggregate review/vote scores, so no consented gate applies there (the `notification-queries.ts` comment cross-references the display exclusion for context only).

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>

---

## Architect re-review (2026-06-12) — HELD PENDING FIXES (3 items)

`/ce-code-review` fan-out on commit `2a9cb25f` (correctness + adversarial on the session model; performance/reliability/testing/maintainability/project-standards + learnings on Sonnet; ce-agent-native skipped per PEvO). **The core work is VERIFIED CORRECT and STAYS**: the consent_seed exclusion-completeness rationale holds per surface AND per channel (poster gates verified at every aggregate — `excludeSelfReviewWhere`'s author != p.author conjunct on the review surfaces, v.voter != v.author plus the JS revote skips on both vote channels; the Route-1-demotion edge is covered because the cycle composes poster gates IN ADDITION to the credited-set gates, so the effective exclusion set is poster ∪ claims ∪ consented on both sides; the seed's omission of revoke-only papers is sound); the union leg has identical column shape in both arms with no BTRIM asymmetry; the round-1 degrade pins still dispatch against the union SQL, and a consent-stack failure degrades through the same single catch (the boundary-doc's three conditions re-verified for the widened leg); exclusion-abuse attacks fail (the down-walk re-derives signer/temporal/anchored validity, so a forged-op seed superset widens walk cost, never membership); `consented_authors AS MATERIALIZED` sits on the right CTE, single-definition-site, genuinely a no-op for the multi-referenced cycle; the 2x2 vote audit (listing/detail x native/revote) passes all four cells; param arithmetic verified at all seven sites; EXPLAIN durable-record convention followed; commit hygiene, zone discipline, and carve-out headers clean. Three items before archive (user-triaged):

1. (P3, correctness conf 100; performance/reliability/adversarial corroborated) **The enrichment consent fetch contradicts its own comment and bypasses the badge's cache.** The `fetchEnrichmentFromHaf` Promise.all comment says the consented set comes from "the same per-paper stack the consented badge resolves (shared volatile cache entry)", but the code calls `fetchConsentedAccountsForPaper(author, permlink)` directly — the badge's path wraps that call in the `consented-authors:{a}:{p}` volatile `getOrSet` (see `annotateAuthorsWithConsent`). Every enrichment rebuild fires a redundant HAF query the badge already caches. Fix: route the enrichment's call through the same volatile entry the badge uses, making the comment true and deduping the query. (The 5-minute stable bake of the enrichment payload is the pre-existing tier design — the claims exclusion has the same shape — and stays.)
2. (P3, maintainability, conf 100) **The `notification-queries.ts` new_review docblock enumeration went stale by omission.** It justifies the intentionally-ungated arm by citing "the display review aggregates (excludeClaimedSelfWhere)" and "the cycle's accepted_claims NOT EXISTS gate" — after this commit the display excludes via the excludeClaimedSelfWhere + excludeConsentedSelfWhere PAIR and the cycle gates on the full credited set, and the described self-review scenario now equally arises for Route-2 consented co-authors. The rationale itself (notifications confer no credit or display weight) is unchanged and extends cleanly. Fix: update the enumeration to the credited-set pair and state explicitly that the intentional-ungated rationale covers consented authors too.
3. (P3, testing + adversarial corroborated, conf 75) **The degrade describe documents the pre-union world.** The degrade describe in `display-claimer-self-vote-revote-exclusion.test.ts` (title "claims-leg failure degrades instead of rejecting"; inline comment "With no claims data the claimedSet is empty") predates this commit's credited-set union: a leg failure now suspends BOTH exclusion populations (claims AND consented) for the volatile window, and `claimedSet` was renamed `creditedSet`. The assertions are correct and still dispatch against the union SQL; only the prose misleads. Fix: retitle/reword to the credited-set leg, use the current variable name, and add one sentence noting both populations degrade together.

Dismissed/no-action at triage: the seed-flood cost compounding (a second fee-less op channel into the recorded claims-flood listing-timeout class — pre-existing class, recorded); listing planning-time growth to ~21.6ms from the doubled CTE forest (revisit if a third recursive stack lands on the statement); the enrichment's three per-request consent resolutions (per-paper-scoped, cached); the count-only shape pin (accepted sibling pattern from the claimer canaries); the equivalence corpus lacking a multi-author consent-op-less paper (the docblock's poster-gate argument verified sound); the MVCC straddle between concurrent enrichment legs (pre-existing class shared with the claims/vote split). The consent-stack composer + FROM-redirect helper dedup was split to the new `backend-consent-stack-test-infra-dedup` task. The surface-(f) cycle-vs-display parity question was resolved by an architect convention-entry update (shared-builder single-sourcing + the seed-equivalence pin + per-side behavioral canaries satisfy the guard when membership is single-sourced).

When the three items land, `git mv` this file back to `tasks/review/`; the move is the re-review signal, scoped to the fix commits. Do not edit this hold block — the commit diff is the evidence; the architect updates it at re-review.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>

---

## Backend re-review signal (2026-06-12, single fix commit on main)

All three hold items landed:

1. **Enrichment consent fetch routed through the badge's volatile entry** — new `getConsentedAccountsForPaperCached` wrapper in `routes/papers.ts` owns the `consented-authors:{author}:{permlink}` `getOrSet` (volatile tier, `CONSENTED_SET_TTL_MS` backstop); both `annotateAuthorsWithConsent` and the `fetchEnrichmentFromHaf` Promise.all leg now call it, so an enrichment rebuild reuses the badge's per-block resolution instead of re-firing the HAF query. The Promise.all comment now describes the actual shared-entry path; pool-null impossibility and uncached `HafQueryError` propagation are stated in the wrapper docblock.
2. **`notification-queries.ts` new_review docblock enumeration updated** — the ungated-arm justification now cites the `excludeClaimedSelfWhere` + `excludeConsentedSelfWhere` pair on the display side and the cycle's NOT EXISTS gates over the full credited set (accepted claims plus consented authors), and states explicitly that the intentional-ungated rationale (a notification confers no credit and carries no display weight) covers Route-2 consented co-authors too.
3. **Degrade describe reworded to the credited-set world** — describe title, it() title, and inline comments now name the credited-set leg and the current `creditedSet` variable, with the added sentence that the leg resolves accepted claims UNION consented authors in one query so a failure suspends BOTH populations together. Same stale-name class fixed in the same file: the header's "accepted-claims leg" paragraph, carve-out (c)'s "claimedSet skip", and the two remaining in-file `claimedSet` comment sites.

Verification: `npm run typecheck` (src+tests) clean; `npm run lint` clean except the known pre-existing `author-supersession.ts` warning; `display-claimer-self-vote-revote-exclusion` + `display-consented-self-dealing-exclusion` + `papers-consented-badge` 16/16 green (the degrade pin exercises the renamed leg through the real dispatch).

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>

---

## Architect re-review (2026-06-12, round 2) — HELD PENDING FIXES (1 item)

`/ce-code-review` fan-out on commit `04da9eab` (correctness on the session model; performance/reliability/testing/maintainability/project-standards + learnings on Sonnet; ce-agent-native skipped per PEvO). **All three round-1 hold items are VERIFIED LANDED**: the enrichment leg routes through the shared volatile entry via `getConsentedAccountsForPaperCached` and the fail-closed boundary is preserved end-to-end (getOrSet never caches null, never negative-caches, and propagates `HafQueryError` uncached into the Promise.all 503 path — verified against the cache implementation and consistent with the fail-closed/degrade-accepted convention entry); the `new_review` docblock enumeration matches HEAD (display helper pair plus the cycle's credited-set gates; the arm stays intentionally ungated); the degrade describe accurately names the credited-set leg and its single-query union (the test's throw trigger matches the union SQL, so the both-populations-degrade-together claim is true); the test hunk is prose-only and `creditedSet` matches production; carve-out clauses and anchors clean. One item before archive (user-triaged):

1. (P3; correctness + performance corroborated, architect-verified against both route handlers) **The new shared-entry comments overclaim the dedup's reach.** The wrapper docblock and the enrichment Promise.all comment state unconditionally that both surfaces share the SAME volatile cache entry and reuse each other's resolution. The badge path canonicalizes via `findCanonicalRoot` before annotating, but the enrichment route passes raw `req.params` to `fetchEnrichmentFromHaf` — for a continuation-post URL the two surfaces compute different keys and each fires its own HAF query. Behavior is correct (the key always matches the loader args; no cross-contamination) and STAYS; qualify both comments so the claim matches the wiring: reuse holds when both surfaces resolve the same canonical (author, permlink) pair, i.e. root-URL requests; the enrichment surface keys on its caller-supplied pair. (The enrichment route's lack of canonical-root rewriting is pre-existing design, out of scope here.)

Dismissed at triage (recorded, no action): the `it()` title's "claimed self-vote" phrasing (readable as the claimer actor; rename churn not warranted); the cross-surface dedup invariant being test-unpinned and the unreachable enrichment null-path pin (preemptive-hardening posture); the transient single-flight rejection coupling (clears in finally, no negative caching) recorded as an accepted residual.

When the item lands, `git mv` this file back to `tasks/review/`; the move is the re-review signal, scoped to the fix commit. Do not edit this hold block — the commit diff is the evidence; the architect updates it at re-review.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>

---

## Backend re-review signal (2026-06-14, round 2 item)

The single round-2 held item landed: the shared-entry comments no longer overclaim the dedup's reach. The `getConsentedAccountsForPaperCached` wrapper docblock and the `fetchEnrichmentFromHaf` Promise.all comment now state that cross-surface reuse for the current block holds only when both surfaces resolve the SAME canonical (author, permlink) pair. The badge path canonicalizes via `findCanonicalRoot` before resolving; the enrichment path keys on its caller-supplied pair. On a root-URL request both compute the same key and the second surface reuses the first's resolution; on a continuation-post URL they key differently and each fires its own query. The cache key always matches the loader's args either way, so a miss costs one extra query, never a wrong-paper result. Behavior unchanged (the enrichment route's lack of canonical-root rewriting is pre-existing design, out of scope); comment-only; anchored on stable symbols.

Verification: `npm run typecheck` + `npm run lint` clean (one pre-existing `author-supersession.ts` warning, untouched). The consent/display behavioral suites are covered by the parent's post-merge full-suite run.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
