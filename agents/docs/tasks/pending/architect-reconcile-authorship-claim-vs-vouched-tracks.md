# ARCHITECT-RECONCILE-AUTHORSHIP-CLAIM-VS-VOUCHED-TRACKS — two overlapping authorship mechanisms need a unified model

**Owner:** architect
**Created:** 2026-06-05 (surfaced during the `backend-co-author-claim-zero-score` review + list-final decision)
**Priority:** P2 (design coherence; not a live defect)

## Problem

PEvO appears to have two distinct, overlapping authorship mechanisms:

1. **`claim_authorship` / `approve_authorship` / `revoke_authorship`** — the co-author **credit** flow. Resolved by `accepted_claims` (`reputation.ts`) and `authorshipClaimsCteBody` (`hafsql.ts`); documented in `hive-schemas.md` § 2.9–2.11. Drives reputation credit.
2. **`author_accept` / `author_resign`** — the **vouched-consent** flow. Documented in `ARCHITECTURE.md` § 6 ("Vouched vs claimed authorship", "Authors mutation"). Gates continuation admission, display badges, and (Phase 2) reputation/citation flow.

These were reviewed together and their relationship is unclear: does an approved `approve_authorship` claim also confer vouched status? Does `author_accept` feed reputation credit, or only the vouched gate? Is one intended to supersede the other? The review could not determine this from code/docs alone.

## Goal

Determine whether the two tracks are redundant, complementary, or one supersedes the other, and document a single coherent authorship model: how a name becomes (a) displayed, (b) credited in reputation, (c) vouched for continuation/consent.

### Constraints to honor

- **List-final invariant (decided 2026-06-05):** authorship credit binds only to a slot named at posting; new co-authors only via continuation revisions. Already applied to the credit flow in `hive-schemas.md` § 2.9/2.10 and `reputation-algorithm.md` "Co-author Credit". Ensure the vouched flow (§ 6) is consistent with it.
- Chain is SSoT; reputation must be reproducible from public on-chain data.

## Acceptance

- A single section (in `ARCHITECTURE.md` § 6, or a clearly cross-linked pair) that states, for each op type, what state it changes (displayed / credited / vouched) and how the two op families compose.
- No contradiction between `hive-schemas.md` § 2.9–2.11, `ARCHITECTURE.md` § 6, and `reputation-algorithm.md` "Co-author Credit".
- If the two tracks are genuinely redundant, a recommendation on consolidation (and a backend task if code changes follow).

## Cross-references

- `agents/docs/hive-schemas.md` § 2.9–2.11; `agents/docs/ARCHITECTURE.md` § 6; `agents/docs/reputation-algorithm.md` "Co-author Credit".
- `backend/src/reputation.ts` (`accepted_claims`), `backend/src/hafsql.ts` (`authorshipClaimsCteBody`).
