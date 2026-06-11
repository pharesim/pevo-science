---
title: "SQL gate-drop or semantic shift requires cross-surface audit beyond the filter clause itself"
date: 2026-05-12
last_updated: 2026-06-12
category: conventions
module: backend/src + agents/docs
problem_type: convention
component: database
severity: high
applies_when:
  - "Dropping or narrowing a SQL predicate that previously acted as a gate (e.g. app-tag filter, accreditation check, status flag)"
  - "Introducing a canonical SQL helper that replaces ad-hoc per-site filters and chooses a canonical semantics that may differ from what each per-site variant had"
  - "A code-review surfaces findings at sites outside the SQL diff (docs, frontend, notification arms, listing/detail set parity, cycle/display parity twins)"
  - "Stats counters, API-contract counts, or notification triggers reference the same logical object class affected by the predicate change"
  - "Listing and detail endpoints draw from different queries over the same logical set, and a predicate change to one can create click-through 404s from the other"
related_components:
  - documentation
  - development_workflow
tags:
  - sql-filter
  - semantic-shift
  - cross-surface-audit
  - api-contracts
  - notification-queries
  - stats-drift
  - listing-detail-parity
  - review-queries
---

# SQL semantic-shift requires cross-surface audit beyond the filter clause

> **Companion to** [`pevo-object-identity-is-author-vouching-not-metadata-claim-2026-04-28.md`](pevo-object-identity-is-author-vouching-not-metadata-claim-2026-04-28.md) (identity-gate shape) and [`wrapping-primitive-exhaustive-call-site-audit-2026-04-22.md`](wrapping-primitive-exhaustive-call-site-audit-2026-04-22.md) (call-site audit after introducing a helper). Those two cover the SQL clause's correctness and call-site completeness. This doc covers what *else* to audit when the gate's admit/exclude semantics shift: API-contract docs, frontend defaults, notification arm composition, listing↔detail set parity, downstream counter monotonicity, and cycle↔display parity twins.

## Context

PEvO commit `8be9206` ("backend(reviews): canonical validReviewWhere helper + display↔reputation parity") introduced `validReviewWhere(opts)` in `backend/src/hafsql.ts`, replacing per-site SQL gates of the form `(type = 'review' AND app LIKE '<appTag>/%')` with a single helper that asserts type plus a 4-dimensional rating-shape regex. The refactor was correct in its SQL clause: the `app LIKE` gate was dropping valid reviews authored via non-PEvO Hive clients (peakd, ecency, raw broadcast), and type-only validation had been admitting malformed rating objects that silently corrupted downstream numeric casts in reputation CTEs.

A `/ce-code-review` pass on the commit surfaced 21 findings across 11 reviewers. The SQL clause change itself was sound. The problem was that the **semantic shift** — dropping `app LIKE` while adding the rating-shape gate — had knock-on effects at five surfaces that are not the SQL filter itself and that none of the three existing sibling conventions (`pevo-object-identity-is-author-vouching`, `enumerated-exemption-lists-are-drift-vectors`, `wrapping-primitive-exhaustive-call-site-audit`) cover. Those conventions address the predicate's correctness and call-site completeness; they are silent on what else to audit when a gate's semantics change. The same class of cross-surface fallout had previously appeared when commit `d92e605` dropped the same `app LIKE` gate from discussion comments, but without a named checklist, each SQL semantic-shift commit re-discovers the fallout surfaces independently.

## Guidance

A **SQL semantic-shift change** is any change that alters what the gate admits or excludes beyond a trivial, narrowing filter addition. It includes gate-drop (removing a conjunct), gate-replace (swapping one predicate for another with different semantics), gate-narrow (adding a predicate that tightens the admitted set), and gate-broaden (relaxing a predicate). Typo fixes, parameter-refactors, and alias renames that preserve semantics are not semantic-shift changes and do not trigger this checklist.

When a semantic-shift lands, run the following audit before closing review. The SQL clause is surface (a); the five remaining surfaces are just as load-bearing.

### Cross-surface audit checklist

**(a) API contract docs.** Does any contract doc describe the semantics of the affected gate? Gate-drops and gate-replaces change what field values mean, what triggers events, and what counts are computed. Check:

- `agents/docs/api-contracts/` for every field, filter param, or trigger description that references the affected content type.
- `agents/docs/hive-schemas.md` for canonical SQL fragments that have now drifted.
- `agents/docs/reputation-algorithm.md` for any parameter table or CTE description that depends on the gate.
- **How to detect:** `grep -rn "<type>|<removed-predicate>" agents/docs/api-contracts/ agents/docs/hive-schemas.md agents/docs/reputation-algorithm.md` — each hit is a candidate stale description.

**(b) Frontend dead code / unreachable defaults.** Does any frontend code defensively default values that the new gate now guarantees? A gate that previously admitted rows with missing fields (and the frontend compensated with `|| 0` or `?? ''`) may now guarantee those fields are always present, making the defaults unreachable dead code. Similarly, a gate that previously excluded certain rows may now admit them, making the frontend's "this can't happen" branches reachable.

- **How to detect:** search the frontend for `|| 0`, `?? 0`, `?? ''`, or similar defaults on fields the new gate gates on. Grep for field names near `||` or `??`: `grep -n "<field-name>.*|| 0\|?? 0" frontend/src/ -r --include="*.js" --include="*.ts"`. Flag each as either dead code (gate guarantees the value is present) or newly reachable (gate now admits rows that previously never arrived).

**(c) Notification arm composition.** Do notification query arms use the changed predicate as a universe-narrowing side effect rather than an explicit domain filter? A dropped conjunct that was incidentally restricting the notification universe (e.g., `app LIKE '<appTag>/%'` excluding off-platform comments) may expand the notification trigger set to include cross-platform or cross-zone events.

- **How to detect:** read every `SELECT` arm in `backend/src/notification-queries.ts` that calls the changed helper. For each arm, ask: is the parent-paper scope enforced by an explicit JOIN or predicate, or is it an implicit side effect of the dropped conjunct? Arms that match `co.parent_author = $1 AND <gate>` without a JOIN to verify the parent IS a PEvO paper are candidates.

**(d) Listing/detail set drift (accreditation symmetry).** Do listing endpoints and detail endpoints apply the same author-set filter? A gate change that removes a predicate which was accidentally masking an accreditation gap (because few users outside the `app LIKE` universe had accredited authors) will now surface the gap. Check that every listing endpoint that calls the changed gate also applies the accreditation predicate, and that the corresponding detail endpoint's response matches what the listing would return.

- **How to detect:** for each route that uses the changed gate, confirm it also has `JOIN active_accreditations aa ON aa.account = <author-alias>` or an equivalent `IN (SELECT account FROM active_accreditations)` predicate. The `validReviewWhere` helper docstring explicitly states the helper does NOT bake in the accreditation predicate; callers compose it per-context. A listing endpoint that omits that composition is a gap.

**(e) Stats counters (monotonicity and direction).** Do stats aggregates that depend on the gate shift in a non-obvious direction? A gate-drop plus gate-add simultaneously changes the admitted set in two directions: rows excluded by the old predicate are now included, and rows admitted by the old predicate but excluded by the new one are now out. Stats consumers that treat these counters as monotonically increasing will see step-changes on deploy. Stats contract docs will be stale if they describe the pre-shift semantics.

- **How to detect:** grep `backend/src/routes/stats.ts` for any `COUNT` or `SUM` that uses the changed gate. For each, compute the net expected direction of the shift (malformed rows out, new-app rows in) and check whether the API contract doc for that field notes the semantics change. Flag any field whose description implies monotonicity or a particular universe that no longer holds.

**(f) Cycle↔display parity twins (credited-set membership shifts).** When the semantic shift changes WHO belongs to a credited or excluded *set* — not just which content rows a gate admits — audit every display-side helper whose purpose is to mirror a cycle-side gate. The reputation cycle's self-dealing exclusion gates have display twins (`excludeClaimedSelfWhere`, the claimed-set exclusion inside `batchResolveVotes`) that exist solely for parity with the score path. A membership change applied to the cycle's gates but not to the twins splits cycle credit from displayed aggregates silently: both sides stay individually green because each is internally self-consistent, and nothing red appears until a user compares displayed `avg_rating`/`net_votes` against credited scores.

- **How to detect:** the parity-claiming docblocks are themselves the checklist anchors — grep the display layer for parity language pointing at the cycle (e.g. a docblock claiming the display aggregation excludes "exactly as the score path does"). For each twin found, confirm the set it tests is the SAME set the cycle now uses, not a stale subset; when the cycle's set definition changed in this diff and the twin's docblock claim still reads true, verify rather than trust it.
- **The durable guard depends on how the twin is implemented.** While a display twin is a SEPARATE implementation of the cycle's set, the guard is a literal cycle-vs-display parity test: drive one scenario through both paths and assert agreement, so the next membership shift turns a test red instead of relying on this checklist being run. Once both sides compose a single shared membership builder (the consented-set resolution after the display-exclusion migration: the cycle and every display gate compose `consentedAuthorsCteBody`), membership drift is structurally impossible at the SQL layer and a literal agreement test adds no protection; the satisfied guard form is then (i) the shared-builder single-sourcing itself, (ii) an equivalence pin on any side-specific seed (the display `consent_seed` ≡ all-roots pin), and (iii) per-side behavioral canaries. Re-require the literal parity test only if a side stops composing the shared builder.

### Copy-pasteable PR checklist

```
## SQL semantic-shift audit
- [ ] (a) Contract docs: grep api-contracts/ + hive-schemas.md + reputation-algorithm.md
          for field descriptions, trigger descriptions, CTE fragments referencing this gate
- [ ] (b) Frontend defaults: grep frontend/src/ for `|| 0` / `?? 0` / `?? ''` on fields
          the new gate guarantees or newly admits; mark dead or newly reachable
- [ ] (c) Notification arms: read every notification-queries.ts arm that uses the helper;
          confirm parent-paper scope is explicit (JOIN/predicate), not a dropped-predicate side effect
- [ ] (d) Listing/detail accreditation symmetry: confirm every listing endpoint that uses
          the helper also applies the accreditation predicate; verify detail endpoint matches
- [ ] (e) Stats counters: grep stats.ts for COUNTs using the helper; compute net shift
          direction; update contract doc if the semantics changed
- [ ] (f) Cycle/display parity twins: if the change shifts credited/excluded SET membership,
          grep the display layer for parity-claiming twins of the cycle gate; confirm each
          tests the cycle's CURRENT set; guard form: literal cycle-vs-display parity test
          while the twin is a separate implementation; shared-builder single-sourcing +
          seed-equivalence pin + per-side canaries once membership is single-sourced
```

## Why This Matters

The five surfaces listed above each failed in the `8be9206` review, producing 21 findings across 11 reviewers. Contract docs at `agents/docs/api-contracts/papers.md`, `misc.md`, `notifications.md`, `hive-schemas.md`, and `reputation-algorithm.md` described gate semantics that the commit had just changed; the CTE fragments at 8 sites in `reputation-algorithm.md` drifted the moment the canonical SQL shifted. The frontend's `|| 0` fallbacks in `paper-detail.js:865-868` became unreachable dead code because the new rating-shape gate guarantees each dimension is present and in range. Notification arm 1a in `notification-queries.ts:147` admitted review-shaped replies to any of the recipient's Hive comments because the `app LIKE` predicate had been the implicit universe restriction; dropping it opened a cross-zone griefing vector. The profile listing at `profile.ts:317-409` returned rows from unaccredited authors because `app LIKE` had been masking the missing accreditation predicate; the detail endpoint at `/api/reviews/:author/:permlink` returned 404 for those same rows, producing a listing↔detail split. Stats counters at `stats.ts` shifted in both directions simultaneously: malformed-rating rows exited, non-PEvO-app rows entered; dashboard consumers treating these as monotonic saw step-changes.

The same class of cross-surface fallout appeared when commit `d92e605` dropped `app LIKE` from discussion comments. That commit preceded this named checklist. `8be9206` reproduced all five surfaces. The pattern is recurring, not one-off: SQL semantic-shift commits are a category of change whose fallout is structurally predictable but invisible to SQL-only review.

Surface (f) was added after the consented-authorship migration (commit `319f0c3c`) demonstrated a recurrence the original five surfaces could not catch: the reputation cycle's self-dealing exclusion gates were generalized from accepted claims to the full consented set, this checklist was consulted during review and PASSED on all five surfaces — and the display parity twins (`excludeClaimedSelfWhere` and the `batchResolveVotes` claimed-set exclusion, both still testing accepted claims only) drifted anyway, because no surface named them. Two independent review lenses caught the drift; the checklist did not. A checklist that gets run and passes while the fallout lands is a checklist with a missing surface, not a process failure. The three existing conventions in this directory are necessary but not sufficient: they verify the SQL predicate's correctness and call-site completeness, and they require a centralized helper so the rule can be audited by grep. None of them prompt the reviewer to check contract docs, frontend defaults, notification arm scope, listing↔detail symmetry, or stats monotonicity — the surfaces where the fallout accumulated.

## When to Apply

Trigger this audit when:

- A `WHERE` conjunct is **removed** from a query that identifies PEvO content objects (papers, reviews, discussion comments, bridge papers), even if a new conjunct is simultaneously added.
- A predicate is **replaced** with one that admits a different set of rows, even if the new predicate is strictly more correct (e.g., replacing an `app LIKE` client-tag check with a structural rating-shape gate).
- A **centralized helper** is introduced that canonicalizes a predicate previously written per-site: the helper's first commit is a semantic-shift commit because it must choose a canonical semantics that may differ from what each per-site variant had.
- A gate is **narrowed** in a way that could push rows from "in" to "out" (e.g., adding the rating-shape regex excludes previously admitted malformed rows, which may cause stats counters to drop and frontend rows to disappear from listings).
- A gate is **broadened** in a way that could pull rows from "out" to "in" (e.g., dropping `app LIKE` admits reviews authored via non-PEvO clients, which may add rows to stats and listings that were previously absent).
- A change alters **membership of a credited or excluded set** that another surface mirrors (e.g., generalizing the cycle's self-dealing exclusion from accepted claims to the consented set). This triggers surface (f) even when no display-side WHERE clause changed — the display twins drifting is the point.

Do NOT trigger for:

- Adding a new `AND` conjunct to an existing gate that only further narrows the admitted set and has no other semantic implication (e.g., adding `AND c.block_num > $N` for time filtering).
- Alias renames, parameter-index renumbering, or whitespace/formatting changes that preserve the predicate semantics exactly.
- Typo fixes to predicate literals where the intent is unambiguous and the before/after SQL admits the same rows.
- Pure refactors that extract a sub-expression into a local variable without changing evaluation order or set membership.

The distinguishing question is: **does this change alter which rows the gate admits or excludes?** If yes, run the full checklist. If no, skip it.

## Examples

All five surfaces are from the `/ce-code-review` on commit `8be9206` ("backend(reviews): canonical validReviewWhere helper + display↔reputation parity"). File references are greppable against the repo at that commit.

**(a) Contract doc staleness**

- `agents/docs/api-contracts/papers.md` — `review_count` field description and `?type=review` search filter referenced the old gate semantics.
- `agents/docs/api-contracts/misc.md` — `total_reviews` and `reviews_last_30_days` field notes described the pre-shift universe.
- `agents/docs/api-contracts/notifications.md` — `new_review` trigger description did not reflect the expanded notification arm.
- `agents/docs/hive-schemas.md` — Section 4 canonical SQL + line 20 generalization.
- `agents/docs/reputation-algorithm.md` — parameter table (line 305) plus 8 CTE sites in review arms.

**(b) Frontend dead code**

- `frontend/src/pages/paper-detail.js:865-868` — `r.rating.methodology || 0` (and parallel `|| 0` defaults for the other three dimensions). The new `validReviewWhere` rating-shape gate (`~ '^[1-5]$'` on all four dimensions) guarantees each value is in-range and present for any row that reaches the API. The `|| 0` fallback is now unreachable for API-sourced review rows.

**(c) Notification arm scope**

- `backend/src/notification-queries.ts:147` (arm 1a) — `WHERE co.parent_author = $1 AND <validReviewWhere>`. The LEFT JOIN to parent paper `p` is for title fetch only; it does not restrict `co.parent_author` to be a PEvO paper. Pre-commit, `app LIKE` was incidentally excluding non-PEvO-app comments from the notification universe. Post-commit, arm 1a matches review-shaped replies to any Hive comment by the recipient, not only replies to PEvO papers.
- `backend/src/notification-queries.ts` (arm 1b, bridge) — correctly tighter: uses `JOIN user_bridge_papers bp ON bp.author = co.parent_author AND bp.permlink = co.parent_permlink`, which explicitly restricts the parent to the user's bridge papers. Used as the reference for the arm 1a fix.

**(d) Listing/detail accreditation symmetry**

- `backend/src/routes/profile.ts:317-409` (`fetchUserReviewsFromHaf`) — the function calls `validReviewWhere` but has no `JOIN active_accreditations` or equivalent `IN (SELECT account FROM active_accreditations)` predicate. Pre-commit, `app LIKE` masked this gap because few unaccredited Hive users set the `pevotest` app tag. Post-commit, any unaccredited author who posts a rating-shape-valid Hive comment parented to a real paper appears in the profile reviews listing.
- The detail endpoint `/api/reviews/:author/:permlink` (in `routes/reviews.ts`) applies the accreditation gate and returns 404 for unaccredited authors. The listing and detail sets are now asymmetric: listing returns rows that detail rejects.

**(e) Stats counters**

- `backend/src/routes/stats.ts` — `total_reviews` and `reviews_last_30_days` shift in both directions simultaneously on the `8be9206` deploy: malformed-rating rows (previously counted) exit the gate; non-PEvO-app reviews from accredited authors (previously excluded by `app LIKE`) enter the gate. Net direction is dataset-dependent. Any monitoring dashboard treating these as monotonic will observe step-changes at deploy time. The API contract doc for these fields did not note the semantics shift until the architect synced them in commit `588a654`.

## Related

- [`pevo-object-identity-is-author-vouching-not-metadata-claim-2026-04-28.md`](pevo-object-identity-is-author-vouching-not-metadata-claim-2026-04-28.md) — the principle that motivates dropping the `app LIKE` gate (accreditation is the trust layer; metadata claims are not). Establishes `validPevoPaperWhere()` / `validReviewWhere()` as the centralized SQL helpers this audit applies to.
- [`enumerated-exemption-lists-are-drift-vectors-2026-04-28.md`](enumerated-exemption-lists-are-drift-vectors-2026-04-28.md) — meta-rule that audit surfaces must be structural (grep + centralized helper) rather than hand-curated. This doc's checklist follows that rule (grep-based detection per surface).
- [`wrapping-primitive-exhaustive-call-site-audit-2026-04-22.md`](wrapping-primitive-exhaustive-call-site-audit-2026-04-22.md) — call-site audit discipline when introducing a new helper. Complements this doc: that doc verifies "every site adopts the helper"; this doc verifies "every site adopts the helper correctly composed with the contracts the gate-change affects."
- [`backend-api-contracts-are-architect-owned-2026-04-21.md`](backend-api-contracts-are-architect-owned-2026-04-21.md) — ownership convention for surface (a). Backend implementers flag api-contract drift in their signal block; the architect performs the contract-doc update.
- [`defense-in-depth-canary-must-pin-each-layer-2026-05-07.md`](defense-in-depth-canary-must-pin-each-layer-2026-05-07.md) — adjacent test-discipline rule. When this audit's surface (c) or (d) is fixed with a new gate at the route layer, the route-level test must independently pin that gate (not rely on the helper's unit test alone).
- [`load-bearing-greps-at-signal-block-write-time-2026-05-06.md`](load-bearing-greps-at-signal-block-write-time-2026-05-06.md) — timing rule. The five greps in this doc's checklist are load-bearing: they must run at signal-block-write-time, not be deferred to architect review-intake.
- [`helper-contract-flip-untouched-adopter-audit-2026-05-16.md`](helper-contract-flip-untouched-adopter-audit-2026-05-16.md) — JS/TS helper-layer sibling. This doc covers SQL gate semantic shift; the sibling covers JS/TS helper-internal defaulting semantic shift (e.g., `?? false` → preserve-on-undefined). Same audit imperative ("re-grade all adopters, not just diff-touched sites"), same root cause (semantic shift at a shared surface propagates silently to consumers), different layer. Together they cover the SQL-layer and JS/TS-layer instances of the same generalized failure mode.
- [`perf-floor-drop-removes-incidental-security-predicate-2026-05-25.md`](perf-floor-drop-removes-incidental-security-predicate-2026-05-25.md) — the sharpest security-critical instance of this audit. When the dropped conjunct is a `block_num` floor removed for BitmapAnd performance reasons, the floor may also have been an incidental authorship/namespace filter; re-audit every read site for a `required_posting_auths ? $issuer` gate before treating the perf fix as done.
