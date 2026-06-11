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
