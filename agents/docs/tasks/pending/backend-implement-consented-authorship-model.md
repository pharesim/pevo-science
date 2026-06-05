# BACKEND-IMPLEMENT-CONSENTED-AUTHORSHIP-MODEL — wire the two-route consent model; remove auto-accept; credit via the consented-set

**Owner:** backend
**Created:** 2026-06-05 (from the `architect-reconcile-authorship-claim-vs-vouched-tracks` brainstorm)
**Priority:** P2 (design coherence; docs are intentionally ahead of code. Sequence AFTER `backend-co-author-claim-zero-score` lands.)

## Problem

PEvO has two authorship mechanisms that the 2026-06-05 decision unifies:
- `claim_authorship` / `approve_authorship` / `revoke_authorship` (LIVE) — drives reputation/citation credit via `accepted_claims` (`reputation.ts`) + `authorshipClaimsCteBody` (`hafsql.ts`), with ORCID/hive **auto-accept**.
- `author_accept` / `author_resign` (INERT) — `computeVouchedAuthors` / `fetchConsentOpsForPaper` in `consent-ops.ts`, keyed on `authors[].hive`, wired into no gate.

The docs (`ARCHITECTURE.md` § 2, `hive-schemas.md` § 2.9–2.11, `reputation-algorithm.md` "Co-author Credit") now describe the unified model; the code does not yet implement it.

## Decided model (see `ARCHITECTURE.md` § 2 "Consented vs claimed authorship")

A claimed author (named in `authors[]` at the root post or via a continuation revision) is **consented** — credited (reputation + citation) + shown with the author badge — via one of:
- **Route 2 (anchored slot):** the co-author broadcasts `author_accept`. Eligibility anchor = `slot.hive == signer` OR `slot.orcid ==` the signer's authority-attested ORCID.
- **Route 3 (name-only slot, no `hive`/`orcid`):** `claim_authorship` + the author/admin's `approve_authorship`.

There is **no metadata auto-accept**: an ORCID/hive match only gates *who may consent*, never credit on its own. Demotion: `author_resign` (anchored self) / claimer self-`revoke_authorship` (name-only) + the author/admin `revoke` backstop (applies to a co-author consented via either route). **No data migration / no flag-day** — nothing live uses these ops yet.

## Goal / scope

1. **Wire the consented-set into the credit path.** Replace the legacy `accepted_claims` auto-accept resolution (`reputation.ts` + `hafsql.ts` `authorshipClaimsCteBody`) so reputation/citation credit flows to the consented-set:
   - **Route 2:** `author_accept` where the signer matches `slot.hive` OR the signer's authority-attested ORCID matches `slot.orcid`. Extend `computeVouchedAuthors` / `consent-ops.ts` (currently keys on hive only) to also match the authority-attested ORCID anchor (sourced from the gated `active_accreditations` set, not broadcaster-controlled).
   - **Route 3:** name-only `claim` + author/admin `approve`, scoped to slots with no `hive`/`orcid` anchor.
   - **Remove the ORCID and hive AUTO-ACCEPT arms** — a claim no longer auto-resolves to credit from a metadata match.
   - Honor `author_resign` / self-`revoke` / author-admin `revoke` demotions in the credit computation.
2. **Rename the consent primitives** "vouched" → "consented" (`computeVouchedAuthors` → `computeConsentedAuthors`, etc.) to match the docs.
3. **Wire the consented-set read path** (paper-detail badge, `GET /api/me/authorships/pending`) per `ARCHITECTURE.md` § 2 "Consented-set computation" constraints: at-most-one-block-stale, O(1) HAF query per request, fail-closed on HAF unavailable, cache invalidation on all five consent ops.
4. Keep credit **reproducible from on-chain ops** (chain SSoT).

## Sequencing

Land AFTER `backend-co-author-claim-zero-score` (the P0 zero-score + self-dealing fix). That fix's Item 2 (self-vote/self-review exclusion for credited claimers) carries forward to the consented model; build this migration on top of it.

## Acceptance

- Reputation/citation credit flows ONLY to consented authors (the two routes); no auto-accept path credits anyone.
- An anchored ORCID slot (`hive: null`, `orcid` set) credits its owner only after that owner — accredited with that ORCID — broadcasts `author_accept`; a name-only slot credits only after `claim` + `approve`.
- The author/admin `revoke` backstop and `author_resign` / self-`revoke` demote a consented co-author in the next cycle; a later re-consent re-credits.
- A co-author named via a continuation revision who self-accepts IS creditable (list-final honored); credit binds only to named slots.
- A consented claimer's self-vote/self-review is excluded (carried from `backend-co-author-claim-zero-score` Item 2, generalized to any consented claimer).
- `reputation-algorithm.md` "Canonical SQL Query" + "Co-author Credit" updated to match the landed code (coordinate with architect; remove the "live cycle uses legacy resolution" note once landed).
- `npm run typecheck` + `npm run lint` clean; comment anchors on stable symbols.

## Cross-references

- `agents/docs/ARCHITECTURE.md` § 2 "Consented vs claimed authorship", "Consented-set computation (Phase 2 constraints)", wire formats "Author Accept / Author Resign (custom_json)"; § 6.4 re-auth rows.
- `agents/docs/hive-schemas.md` § 2.9–2.11 (name-only route).
- `agents/docs/reputation-algorithm.md` "Co-author Credit" + "Canonical SQL Query".
- `backend/src/reputation.ts` (`accepted_claims`, `computeReputationBatch`), `backend/src/hafsql.ts` (`authorshipClaimsCteBody`, `activeAccreditationsCteBody`), `backend/src/consent-ops.ts` (`computeVouchedAuthors`, currently inert).
- **Depends on:** `backend-co-author-claim-zero-score` (land first). **Related:** `backend-authorship-credit-ops-fresh-auth` (§ 6.4), `architect-reconcile-authorship-claim-vs-vouched-tracks` (the model), `backend-notification-infra-for-consent-ops` + `ui-multi-author-consent-affordances` (the consent UX surfaces).
