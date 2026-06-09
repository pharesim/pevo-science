# BACKEND-NOTIFICATION-ARM-CLAIM-REVIEW-PARITY — does new_review still notify for a claimer self-review now excluded from display/score?

**Owner:** backend
**Created:** 2026-06-09 (architect `/ce-code-review` follow-up from `backend-claimer-self-review-display-callsite-exclusion`; learnings-researcher cross-surface parity flag)
**Priority:** P3 (notification parity; no state/credit impact — display and score already exclude the claimer self-review)

## Problem

`backend-claimer-self-review-display-callsite-exclusion` added `excludeClaimedSelfWhere` to the display review/vote surfaces, and the reputation cycle already excludes accepted-claimer self-reviews via its own gate. But the `new_review` notification arm in `notification-queries.ts` was NOT examined. If a credited claimer (ORCID / name-only slot, absent from `authors[].hive`) posts a review on the paper they are credited for, a `new_review` notification may still fire to the paper author even though that review is now excluded from every display aggregate and from the reputation score. That is a cross-surface parity gap: a notification fires for an object the display and score paths treat as non-existent.

## Goal

Decide whether the `new_review` arm (and any sibling review-triggered arm) should also exclude accepted-claimer self-reviews, and align it with the display/cycle exclusion if so — or record a rationale for why the notification intentionally still fires.

### Suggested approach

- Audit the `new_review` arm (and any review-derived notification arm) in `notification-queries.ts` for the accepted-claimer self-review case.
- If it should exclude: compose the accepted-claims gate (`authorshipClaimsCteBody`, or the recipient-bound EXISTS pattern the claim-correlation task used for arms 8/9) so the arm does not fire for a claimer self-review.
- If it should NOT exclude (e.g. the author still wants to know a credited co-author reviewed): record the rationale in-code, anchored on behavioral semantics, not on a task slug / line number / SHA.

## Acceptance

- The `new_review` arm's behavior for an accepted-claimer self-review is decided and either gated or rationale-documented.
- If gated: a behavioral canary (accepted claimer self-review → no `new_review` notification; a third-party review → still fires).
- `npm run typecheck` + `npm run lint` clean; comment anchors on stable symbols.

## Cross-references

- `backend/src/notification-queries.ts` (`new_review` arm + review-derived arms).
- `backend/src/hafsql.ts` (`authorshipClaimsCteBody`, `excludeClaimedSelfWhere`).
- Parent: `backend-claimer-self-review-display-callsite-exclusion`.
- Related: `backend-notifications-claim-approve-revoke-correlation` (the recipient-bound EXISTS pattern for arms 8/9).
