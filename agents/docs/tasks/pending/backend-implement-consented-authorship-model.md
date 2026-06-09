# BACKEND-IMPLEMENT-CONSENTED-AUTHORSHIP-MODEL — wire the consent model; remove auto-accept; credit the consented-set via a shared chain-aware SQL CTE

**Owner:** backend
**Created:** 2026-06-05 (from the `architect-reconcile-authorship-claim-vs-vouched-tracks` brainstorm)
**Ratified:** 2026-06-09 (architect + user — the open forks below are settled; supersedes the standalone deep-plan, now removed)
**Priority:** P2 (design coherence; docs are intentionally ahead of code)

## Problem

Reputation/citation credit must flow only to co-authors who have **consented** to a paper. Today the live cycle still uses **legacy auto-accept**: a bare ORCID-or-hive match in `authors[]` confers credit with no act of consent (the ORCID + hive arms of `authorshipClaimsCteBody`). Two mechanisms exist:
- `claim_authorship` / `approve_authorship` / `revoke_authorship` (LIVE) — credit via `accepted_claims` (`reputation.ts`) + `authorshipClaimsCteBody` (`hafsql.ts`), with ORCID/hive **auto-accept**.
- `author_accept` / `author_resign` (INERT) — `computeVouchedAuthors` / `fetchConsentOpsForPaper` in `consent-ops.ts`, keyed on `authors[].hive`, wired into no gate.

The docs (`ARCHITECTURE.md` § 2, `hive-schemas.md` § 2.9–2.11, `reputation-algorithm.md` "Co-author Credit") describe the unified model; the code does not yet implement it.

## Decided model (see `ARCHITECTURE.md` § 2 "Consented vs claimed authorship")

A claimed author (named in `authors[]` at the root post or via a continuation revision) becomes **consented** — credited + badged — via one of:
- **Route 1 — root broadcaster:** implicit consent via the post signature.
- **Route 2 — anchored slot:** the co-author broadcasts `author_accept`. Eligibility anchor = `slot.hive == signer` OR `slot.orcid ==` the signer's authority-attested ORCID.
- **Route 3 — name-only slot (no `hive`/`orcid`):** `claim_authorship` + the author/admin's `approve_authorship`.

There is **no metadata auto-accept**: an ORCID/hive match only gates *who may consent*, never credit. Demotion: `author_resign` (anchored self) / claimer self-`revoke_authorship` (name-only) + the author/admin `revoke` backstop (either route). **No data migration / no flag-day** — nothing live uses these ops yet.

## Ratified decisions (2026-06-09) — settled, do not re-litigate

1. **Credited-set lives in SQL (Option A).** One shared lean recursive CTE computes the credited *set* — which slots are credited per paper. BOTH the reputation cycle and the read surfaces consume it: single source of truth for *who is credited* (the no-cycle-vs-read-drift outcome `reputation-claims-cte-dedup` established for claims). Display polish — name resolution, the 5-branch ORCID server-override, audit emission — stays in JS on top (audit emission is side-effectful and cannot move to SQL). SQL owns membership; JS owns presentation.

2. **Full cumulative chain, not root-slot only.** A `WITH RECURSIVE` walk over the `continues` pointer chain assembles each root paper's cumulative `authors[]` union across ALL revisions, threading the cumulative-author admission gate down the recursion (mirroring the JS `resolveContinuationChain` rule: a continuation post is admitted only if its author is in the cumulative set built from prior hops). Per slot it emits `{hive, orcid, name, first-appearance block}`. Rationale: a co-author named in a later revision contributed to that version and must earn credit. **Today the cycle has ZERO chain-awareness** — `user_papers` filters `(continues) IS NULL` and every `authorshipClaimsCteBody` arm resolves against the root post only — so this CTE is foundational new infrastructure that all three credit routes sit on.

3. **Retroactivity invariant — consent gates MEMBERSHIP, never the vote window.** Once an author becomes consented, the next cycle credits them the paper's FULL vote/review history, including votes/reviews from BEFORE their accept. This is free under the full-recompute cycle (scores are recomputed from scratch each cycle; `prevScores` only weights voters, it is not a per-author accumulator). The only way to break it is to add a `vote.block_num > accept.block_num` window — DO NOT. Rule 6 (accept block must be > the slot's first-appearance block) gates accept *validity* (anti-name-squatting); it does NOT gate which votes count.

4. **Route-3 name-only claims resolve against the cumulative chain — NO op-schema change.** The `claim_authorship` op already carries root `paper_author`/`paper_permlink` + `author_index`, and `hive-schemas.md` § 2.10 already defines the author list as the cumulative union across the chain. The gap is code-only: `authorshipClaimsCteBody`'s list-final gate resolves `author_index` against the ROOT post only. Fix: resolve `author_index` against the cumulative-chain union (the CTE from #2). A name-only author who first appears in a continuation can then claim + approve + be credited. No on-chain format change.

## Credit composition (directional, not a spec)

```
credited(paper) =
    Route 1: root broadcaster
  ∪ Route 2: author_accept where signer == slot.hive OR signer's attested-ORCID == slot.orcid,
             Rule 6 (accept.block > slot first-appearance block), latest-op-wins (accept vs resign)
  ∪ Route 3: claim + approve(author|bridge) where author_index resolves to a NAME-ONLY slot
             (no hive/orcid anchor) in the CUMULATIVE chain union, latest-op-wins, revoke override
  \ demotions: author_resign / self-revoke / author-admin revoke (latest op per (author, paper))
```

Self-credit exclusion (consenter == post author) and the credited-claimer self-vote/self-review exclusion (from `co-author-claim-zero-score` Item 2) apply to the WHOLE credited set, not just Route-3 claimers. Credit is keyed to on-chain post identity (`chain_papers` dedup); credit = the same full paper score as the poster (shared, not divided).

## Implementation plan (ordered; U1 before U2 is mandatory)

### U1 — Shared consented-set resolution (rename vouched→consented; ORCID anchor; the recursive chain CTE)
- `consent-ops.ts`: rename `computeVouchedAuthors`→`computeConsentedAuthors`, `getVouchedAuthors`→`getConsentedAuthors`, and all sense-3 "vouched" symbols → "consented" (per `vouch-three-senses-consented-not-vouched`; leave the WoT-accreditation and object-vouching senses). Extend eligibility: a slot anchors on `hive == signer` OR `orcid == attested_orcid(signer)`, attested-ORCID resolved **latest-action-wins** over `active_accreditations` (NOT strict existence; a null attested ORCID against an orcid-anchored slot ⇒ NOT eligible / suppress). Source the consented identity `(name, orcid, hive)` atomically from one attestation, never per-field. Keep Rules 2 (`(block_num, id)` order), 5 (signer == `required_posting_auths[0]`), 6 (temporal lower bound).
- `hafsql.ts`: new shared CTE (e.g. `consentedAuthorsCteBody`) — the `WITH RECURSIVE` chain walk (decision #2) emitting per-paper cumulative slots with first-appearance block, then the Route-2 consent resolution over it.
- KTD-3 fail-closed: change the fetch's `[]`/root-only return on `!pool` to a discriminated union `{ status: 'ok', ops } | { status: 'haf_unavailable' }` (mirror the `read-then-write-races` `assertNever` shape). Never cache the failure sentinel.
- Characterization-first: pin current `computeVouchedAuthors` (hive-only) before extending so the ORCID anchor is provably additive.
- Audit the SQL `BTRIM` (U+0020 only) vs JS `.trim()` (full Unicode) asymmetry on any new anchor-equality predicate (`sql-trim-vs-js-trim`).
- **Tests:** hive-anchored accept → consented (characterized); orcid-anchored accept w/ matching *attested* ORCID → consented; broadcaster-claimed-only ORCID → suppress; null attested ORCID on orcid-anchored slot → not consented; attested-then-revoked → not consented; accept block ≤ first-appearance → rejected (Rule 6); accept→resign→accept latest-wins; HAF down → `haf_unavailable` (not empty set); a continuation-added anchored slot is resolvable.

### U2 — Remove the ORCID + hive auto-accept arms; make Route-3 chain-aware
- **Depends on U1** (Route-2 credit must exist before its old auto-accept path is removed — avoid a no-credit window).
- `hafsql.ts` `authorshipClaimsCteBody`: delete the ORCID arm and the hive arm from the status CASE; keep the revoked arm + the explicit-approval arm. Add the name-only constraint (the approval arm credits only when the slot carries NO `hive`/`orcid` anchor — anchored slots go through Route 2). **Resolve `author_index` against the cumulative-chain union, not root-only** (decision #4).
- The shared builder is already landed (`reputation-claims-cte-dedup` collapsed the cycle's inline copy onto `authorshipClaimsCteBody`), so the arms live in ONE place — remove there.
- **KTD-4 blast-radius audit** — removing the arms flips `accepted` vs `pending` for all ~13 `authorshipClaimsCteBody` consumers at once. Two land-mines:
  - **`isApprovedCoAuthor` authz** (`claims.ts`) gates bridge-key co-author broadcasts. An ORCID-auto-accepted co-author LOSES co-sign authority once the arm is removed — a *behavior change*, not just a credit change. Pin it with a test and surface it.
  - **JS ORCID-supersession mirror** (`author-supersession.ts`, shared `CHAIN_ORCID_BTRIM_CHARSET`) mirrors the SQL ORCID arm. Audit/retire it so the four-surface invariant isn't split.
- Invert the existing auto-accept tests (`reputation-orcid-auto-accept-*`) to assert the arms are GONE.
- **Tests:** ORCID/hive-matching slot w/o `author_accept` → NOT credited; name-only claim+approve → credited; anchored slot via Route 3 → NOT credited; `isApprovedCoAuthor` co-sign behavior change pinned; supersession display still agrees with the arm-less SQL on a padded-ORCID case.

### U3 — Wire the union credit-set into the reputation cycle
- **Depends on U1, U2.**
- `reputation.ts` `computeReputationBatch`: credit Route 1 ∪ 2 ∪ 3 − demotions, keyed to on-chain post identity. Compose the Route-2 consented CTE alongside the (now arm-less, chain-aware) `authorshipClaimsCteBody`. **Retroactivity invariant (decision #3): NO accept-block vote window.** Generalize the `co-author-claim-zero-score` Item 2 self-exclusion (`paper_resolved_votes` / `paper_reviews` `NOT EXISTS accepted_claims`) to ANY consented author, not just Route-3 claimers. Re-throw HAF errors (KTD-3) — never swallow to empty (a transient failure must not poison `prevScores` / advance `cycle:last`).
- Characterization-first on the cycle's current credit output for a seed → the union extension is provably additive.
- **Tests:** Route-2 anchored accept gets the paper score (0 without the accept); Route-3 still credited (no regression); consented author self-vote/review excluded; demotion zeroes next cycle, re-accept re-credits; native rows unregressed; **retroactivity — a vote cast before the accept still counts after**; `reputation-lifecycle` (real HAF) green.

### U6 — Regression + parity backstops
- A representative-seed regression proving the credited-set matches the model (approve / ORCID-accept / hive-accept / name-only / revoke / resign / suppress-null-ORCID / continuation-added). Confirm `npm run typecheck` + `npm run lint` clean and the real-HAF lifecycle green.

## [TODO Architect] doc reconciliation (architect-owned; backend files this note, does NOT edit these)
- `reputation-algorithm.md`: drop the "live cycle uses legacy auto-accept" status note; describe the union credit-set in "Co-author Credit"; **state the retroactivity invariant explicitly** — credit gates set-*membership*, never a per-author vote window: once consented, the next full-recompute cycle credits the paper's entire vote/review history (votes/reviews from before the accept included), because scores are recomputed from scratch each cycle and `prevScores` weights voters only. (Today the doc says co-authors get "the same score as the posting author" and that demotion is "going forward," which implies but never names this property; name it so a future editor cannot reintroduce a `vote.block_num > accept.block_num` window.) **FIX the stale param table** — "Canonical SQL Query → Parameters" still lists `$21 = admin`, but the `reputation-claims-cte-dedup` builder shifted the layout to `$1–$20` + builder `$21–$25` (admin re-bound at `$25`).
- `ARCHITECTURE.md` § 2: flip the "not yet wired" / "live cycle does NOT yet compute the consented-set" status statements.
- `hive-schemas.md` § 2.9: tighten the `author_index` resolution domain to "cumulative-chain author union" so root-only resolution isn't re-introduced (resolve the § 2.9 "fixed at posting" vs § 2.10 "cumulative union" ambiguity).
- `api-contracts/papers.md` (`consented` field) + the pending-endpoint contract are covered by `backend-consented-set-read-surfaces`.

## Sequencing & dependencies (verified 2026-06-09)
- **Prerequisite — SATISFIED:** `backend-co-author-claim-zero-score` archived 2026-06-09 (list-final arms + Item 2 self-dealing are live; generalize Item 2 to the consented set).
- **Shared builder — LANDED in code:** `backend-reputation-claims-cte-dedup` collapsed the cycle's inline claim resolution onto `authorshipClaimsCteBody`, so the auto-accept arms live in ONE place. That task is held in `pending/` on 3 test/comment hygiene items (forged-revoke equivalence seed, stale "Mirrors reputation.ts" comments, a test-header slug) — none block the builder's use, but **rebase U2's arm-removal on the final builder once those land** to avoid comment churn.
- **Phasing:** U1 before U2 is mandatory (else anchored co-authors lose all credit in the gap). Go-forward only (no production ops, no migration) — land U1→U2→U3 back-to-back or in one PR to close the window.
- **Read surfaces:** split to `backend-consented-set-read-surfaces` (badge + pending endpoint), which depends on U1's shared CTE.
- **Co-requisites / related:** `backend-authorship-credit-ops-fresh-auth` (pending — § 6.4 fresh-auth for consent ops; assumes it lands in parallel, not re-implemented here), `ui-multi-author-consent-affordances` (blocked — UI), `backend-bridge-paper-author-claim-flow` (blocked — bridge papers stay single-consented-author; consent short-circuits), `backend-extract-chain-cumulative-helper-to-lib` (blocked — the JS cumulative helper; reconcile with the SQL chain CTE). (The former `backend-notification-infra-for-consent-ops` task was superseded by this task + the read-surfaces task and removed 2026-06-09.)

## Acceptance
- Reputation/citation credit flows ONLY to consented authors (Routes 1/2/3); no auto-accept path credits anyone.
- An anchored ORCID slot credits its owner only after that owner — accredited with that ORCID — broadcasts `author_accept`; a name-only slot credits only after `claim` + `approve`.
- The author/admin `revoke` backstop and `author_resign` / self-`revoke` demote a consented co-author next cycle; a later re-consent re-credits.
- A co-author named via a continuation revision (anchored OR name-only) is creditable; credit binds only to named slots.
- **Retroactivity: a vote/review cast before an author consented still counts toward their credit once consented.**
- A consented author's self-vote/self-review is excluded (Item 2 generalized to any consented author).
- The `isApprovedCoAuthor` co-sign-authority behavior change is pinned by a test and surfaced.
- `[TODO Architect]` doc-handoff note filed before the task moves to `review/`.
- No sense-3 "vouched" symbol remains in `consent-ops.ts` or new code; comment anchors on stable symbols (no task slugs / line numbers / SHAs); `npm run typecheck` + `npm run lint` clean.

## Cross-references
- `agents/docs/ARCHITECTURE.md` § 2 "Consented vs claimed authorship", "Consented-set computation (Phase 2 constraints)", wire formats "Author Accept / Author Resign (custom_json)"; § 6.4 re-auth rows.
- `agents/docs/hive-schemas.md` § 2.9–2.11 (name-only route, `author_index`).
- `agents/docs/reputation-algorithm.md` "Co-author Credit" + "Canonical SQL Query".
- `backend/src/reputation.ts` (`computeReputationBatch`, `accepted_claims`), `backend/src/hafsql.ts` (`authorshipClaimsCteBody`, `activeAccreditationsCteBody`, `excludeClaimedSelfWhere`), `backend/src/consent-ops.ts` (`computeVouchedAuthors`, currently inert), `backend/src/routes/papers.ts` (`resolveContinuationChain`, `buildCumulativeAuthorsForChain` — the JS chain walk being ported to SQL), `backend/src/lib/author-supersession.ts`.
