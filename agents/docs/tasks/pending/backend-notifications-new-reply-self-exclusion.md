# BACKEND-NOTIFICATIONS-NEW-REPLY-SELF-EXCLUSION — arm 5 (`new_reply`) lacks the `co.author != $1` self-exclusion sibling arms carry

**Owner:** backend
**Created:** 2026-05-30 (surfaced by HAF-query multi-lens review, rank #25 medium severity, correctness)
**Priority:** P3 (a user replying to their own comment triggers a notification to themselves)

## Problem

Arm 5 (`new_reply`) in [notification-queries.ts:320-325](backend/src/notification-queries.ts#L320-L325) filters `co.parent_author = $1` but lacks the `co.author != $1` self-exclusion that all sibling arms (1a, 1b, 6a, 6b) carry.

A user replying to their own comment triggers a notification to themselves.

## Goal

Add the missing self-exclusion clause.

### Suggested approach

Add `AND co.author != $1` to arm 5's WHERE.

Extend the per-arm SQL-shape canary at [notifications-arm-sql-shape.test.ts:165-181](backend/tests/notifications-arm-sql-shape.test.ts#L165-L181) to lock the `author != $1` convention across all comment-derived arms (1a, 1b, 5, 6a, 6b) so a future arm inherits the discipline.

## Acceptance

- Regression test: user replies to their own comment → no notification fires for self.
- Existing arm 5 tests stay green.
- SQL-shape canary asserts `author != $1` (or equivalent) present in arms 1a, 1b, 5, 6a, 6b.
- Comment anchors clean.
- `npm run typecheck` + `npm run lint` clean.

## Notes

- Bundle SQL-shape canary churn with #7, #14, #15, #16.
- Smallest fix in the notifications batch.

## Cross-references

- [backend/src/notification-queries.ts](backend/src/notification-queries.ts) lines 320-325 (arm 5).
- [backend/tests/notifications-arm-sql-shape.test.ts](backend/tests/notifications-arm-sql-shape.test.ts) lines 165-181 (existing canary to extend).
- HAF-query review run `w274tijk0` rank #25.

---

## Architect re-review (2026-05-30) — HELD PENDING FIXES

Round-1 review on commit `f972f4b9`. The arm-5 `co.author != $1` fix itself is verified correct (right arm, right boolean position, right alias semantics; the behavioral test covers both self-reply-excluded and stranger-fires). One item holds archive:

1. **SQL-shape canary acceptance only half-met** (P2, tests). The task required the canary to assert the self-exclusion across arms 1a, 1b, 5, 6a, 6b so a future arm inherits the discipline; the diff added the canary for arm 5 only. Extend it to slice arms 1a/1b (assert `co.author != $1`) and 6a/6b (assert `citing.author <> $1` / `!= $1`).
