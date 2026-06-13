# BACKEND-CONSENT-STACK-COMPOSER-POLISH — name the consent-seed scope union + complete the composer's excluded-sites docblock

**Owner:** backend
**Created:** 2026-06-14 (architect `/ce-code-review` of `backend-consent-stack-test-infra-dedup`; two P3 maintainability findings, user-elected at triage)
**Priority:** P3 (comment + type-dedup polish; no defect — the composer is byte-equivalent and the migration is complete)

## Problem

The `consentStackCteBody` composer review (commit `acad92d9`) came back clean on correctness/security/adversarial/testing/performance. Maintainability surfaced two genuine low-stakes nits worth a follow-up:

1. **Duplicated inline scope union.** The scope parameter type `{ signer: string } | { papers: Array<{ author: string; permlink: string }> }` is declared inline at BOTH `consentSeedCteBody` and the new `consentStackCteBody` in `backend/src/hafsql.ts`. The two copies must stay in sync by hand; they differ from `ConsentChainScope` and are covered by no named type today.

2. **Incomplete excluded-sites docblock.** The `consentStackCteBody` docblock lists two reasons a site stays on direct composition (the reputation cycle's batch-activity seed; the pending-consents `pending_seed` up-walk) but omits the per-paper badge/detail sites (`fetchConsentedAccountsForPaper` / the per-paper detail chain in `papers.ts`). Those are NOT 3-tuple sites — they seed via `{ paperAuthor, paperPermlink }` directly into `consentChainCteBody` with NO `consent_seed` CTE at all. A future agent scanning for "remaining direct chain+consented callers" will find them and may incorrectly attempt migration. (The `/ce-code-review` learnings researcher independently flagged this under the cross-surface-parity-audit-at-sibling-composition-sites convention.)

## Goal

- Extract a named exported type (e.g. `ConsentSeedScope`) for the seed scope union and use it at both `consentSeedCteBody` and `consentStackCteBody` signatures, eliminating the hand-sync copies.
- Add a third bullet to the `consentStackCteBody` docblock clarifying that the per-paper badge/detail sites seed via `{ paperAuthor, paperPermlink }` directly into `consentChainCteBody` (no `consent_seed`) and are therefore not this composer's callers — distinct from the two custom-seed exclusions already listed.

## Acceptance

- One named scope type; both function signatures reference it; no behavior change (the union members are unchanged).
- The docblock's excluded-sites list is complete (covers the custom-seed sites AND the seed-less per-paper sites).
- Comment anchors on stable symbols (no slug/round/line/SHA).
- `npm run typecheck` + `npm run lint` clean; the consentStackCteBody composition-equivalence pins in `hafsql.test.ts` stay green (type-only + comment change).

## Cross-references

- `backend/src/hafsql.ts` (`consentSeedCteBody`, `consentStackCteBody`, `consentChainCteBody`, `consentedAuthorsCteBody`).
- `backend/src/routes/papers.ts` (`fetchConsentedAccountsForPaper` and the per-paper detail chain — the seed-less direct callers to name in the docblock).
- Parent: `backend-consent-stack-test-infra-dedup` (archived 2026-06-14).

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
