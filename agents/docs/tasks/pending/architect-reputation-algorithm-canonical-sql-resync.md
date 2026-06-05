# ARCHITECT-REPUTATION-ALGORITHM-CANONICAL-SQL-RESYNC — re-sync the verbatim Canonical SQL + parameter table to production

**Owner:** architect
**Created:** 2026-06-05 (deferred from the `backend-co-author-claim-zero-score` / `backend-citation-*` review)
**Priority:** P2 (doc reproducibility contract is currently broken; a drift notice marks it)

## Problem

`agents/docs/reputation-algorithm.md` § "Canonical SQL Query" claims "This SQL query **is** the algorithm definition," but the verbatim block and parameter table have drifted from `backend/src/reputation.ts` + `backend/src/hafsql.ts`:

- Missing the `chain_papers` CTE and the `chain_author`/`chain_permlink` columns on `user_papers` (both arms); the vote/review CTEs are shown keyed on `up.author` rather than the on-chain post identity.
- A concurrent floor-sweep removed the `$7` genesis lower-bound and renumbered the parameters after it; the table still lists `$7 = Genesis block number` and the body still references `$7` floors throughout.

A `> Drift notice (2026-06-05)` was added at the section head pointing here; the prose "Co-author Credit" section is already updated.

## Goal

Bring the Canonical SQL Query block and parameter table back into exact agreement with production, then remove the drift notice.

### Decision to make first

Decide whether to keep a verbatim 400-line SQL copy in the doc at all. CLAUDE.md principle: "the code is the source of truth for API shapes, data models, and schemas." Options:
1. Re-sync the verbatim block fully (highest fidelity, highest rot rate).
2. Replace the verbatim block with a structural description (CTE roster + what each computes) plus a pointer to `backend/src/reputation.ts` as authoritative, keeping only the parameter table and the reproducibility guarantees in prose.

Recommendation: option 2 — the verbatim copy has rotted twice now; a structural description + code pointer honors the SSoT rule and stops the rot.

## Acceptance

- The parameter table matches the production bind array (no `$7 = genesis`; `$7`–`$20` are the weights/bridge/anon/appTag/authorities per `computeReputationBatch`).
- The CTE roster reflects `chain_papers` + the chain-identity rekey.
- The list-final enforcement (named-slot approval gate + claimer self-vote/self-review exclusion) is reflected **only once `backend-co-author-claim-zero-score` lands** — until then keep the "pending" framing already in the Co-author Credit section.
- The drift notice is removed.

## Cross-references

- `agents/docs/reputation-algorithm.md` § "Co-author Credit", § "Canonical SQL Query".
- `backend/src/reputation.ts` (`computeReputationBatch`, `user_papers`, `chain_papers`), `backend/src/hafsql.ts` (`authorshipClaimsCteBody`, `activeAccreditationsCteBody`).
- Sequence after `backend-co-author-claim-zero-score` so the list-final arms are final before documenting them.
