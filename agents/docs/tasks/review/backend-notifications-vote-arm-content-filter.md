# BACKEND-NOTIFICATIONS-VOTE-ARM-CONTENT-FILTER — vote-arm notifications fire for any Hive content + hardcode `target_type='paper'` for review-votes

**Owner:** backend
**Created:** 2026-05-30 (surfaced by HAF-query multi-lens review, rank #14 medium severity, correctness)
**Priority:** P2 (votes on non-PEvO Hive content the user authored surface as "X endorsed your paper"; review-vote target_type is wrong)

## Problem

Arms 2a/2b in [notification-queries.ts:225-263](backend/src/notification-queries.ts#L225-L263) only require `v.author = $1` (plus accreditation) — no PEvO content-type filter, and no constraint that the voted post is a paper.

- Votes on non-PEvO Hive content the user authored surface as "X endorsed your paper."
- Votes on the user's REVIEW comments also surface with `target_type='paper'` (the schema is hardcoded for paper).
- Arm 1a was hardened earlier against exactly this class via `validPevoPaperWhere`; arm 2 was missed.
- Self-vote also not excluded.

## Goal

Split arm 2 into native paper, bridge paper, and review-vote sub-arms with the right content filters and `target_type`.

### Suggested approach

- **2a — native paper votes:** `JOIN comments` + `validPevoPaperWhere(source='all')`, `target_type='paper'`.
- **2b — bridge paper votes:** `JOIN user_bridge_papers`, `target_type='paper'`.
- **2c — review votes:** `JOIN comments` + `validReviewWhere`, `target_type='review'`.
- Add `v.voter != v.author` to drop self-votes.

## Acceptance

- Regression tests:
  - Vote on a user's non-PEvO Hive blog post → no notification fires.
  - Vote on a user's PEvO paper → `new_vote` with `target_type='paper'`.
  - Vote on a user's PEvO bridge paper → `new_vote` with `target_type='paper'`.
  - Vote on a user's PEvO review → `new_vote` with `target_type='review'`.
  - Self-vote → no notification fires.
- Existing positive arm-2 tests stay green (the legitimate paper-vote case).
- SQL-shape canary: assert each of arms 2a/2b/2c uses the correct content gate (`validPevoPaperWhere`, `user_bridge_papers`, `validReviewWhere`) and emits the correct `target_type` literal.
- Comment anchors clean.
- `npm run typecheck` + `npm run lint` clean.

## Notes

- Bundle the SQL-shape canary update with #7 (dedup), #15 (citation arms), #16 (claim/vouch arms), and #25 (new_reply self-exclusion) — those all touch the same canary file. Coordinate to minimize churn.
- Frontend may show "endorsed your review" copy for `target_type='review'`; verify the SPA already handles the new value (a UI task may follow if it doesn't).

## Cross-references

- [backend/src/notification-queries.ts](backend/src/notification-queries.ts) lines 225-263 (arms 2a/2b).
- `validPevoPaperWhere`, `validReviewWhere` helpers in [backend/src/hafsql.ts](backend/src/hafsql.ts) (precedent for arm 1a hardening).
- HAF-query review run `w274tijk0` rank #14.
