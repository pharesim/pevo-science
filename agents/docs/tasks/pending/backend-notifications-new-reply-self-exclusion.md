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

---

## Backend re-review signal (2026-05-30, working tree)

Round-2 hold item 1 addressed in `backend/tests/routes/notifications-arm-sql-shape.test.ts`:

- Added per-arm slice canaries isolating arm 1a (first→second `new_review` tag) and arm 1b (second `new_review` → first `new_vote` tag), each asserting `AND co.author != $1` lives inside that arm's slice.
- Added per-arm slice canaries for the citation arms: arm 6a (first→second `new_citation` tag) and arm 6b (second `new_citation` → `claim_pending` tag), each asserting `AND citing.author <> $1` (the citation-side self-exclusion analogue the hold asked for).
- Retained the pre-existing collective `co.author != $1` count==3 canary (arms 1a/1b/5) as the cross-arm backstop.
- Refreshed the file-header canary inventory and mutation-kill summary to enumerate the per-arm self-exclusion slices, and neutralized a stale round-number anchor in the thematically-adjacent header item.

Note: arms 6a/6b already carry `citing.author <> $1` and the INNER-JOIN paper-existence gate in production code; this task adds only the canary coverage the hold required (no production-SQL change).

Verification: `npm run typecheck` + `npm run lint` clean; `notifications-arm-sql-shape.test.ts` passes (9 tests, including the 4 new per-arm slices).

---

## Architect re-review (2026-06-02) — HELD PENDING FIXES

`/ce-code-review` (correctness/testing/maintainability/project-standards) on the round-2 diff (commits `a2189776` + `3001102b`), scoped to the changes since the 2026-05-30 hold.

**Round-2 hold item 1 is FIXED.** All four per-arm slice canaries are present and verified to localize correctly against the production SQL: arms 1a/1b assert `AND co.author != $1` inside their tag-bounded slice; arms 6a/6b assert `AND citing.author <> $1`. Correctness confirmed each boundary tag literal occurs exactly the expected number of times (`'new_review'::text` ×2, `'new_citation'::text` ×2), so no slice captures the wrong region; production arms 6a/6b genuinely carry `citing.author <> $1`; the `a2189776` production change is a pure comment reword with no behavioral effect; suite green (9 tests).

**NEW hold item (P2, comment-anchor convention).** Round-2 rewrote the file-header docblock (items 3/4/5 + the mutation-kill summary) and neutralized one stale round-number anchor, but a round-number anchor still survives **in the same docblock it otherwise rewrote**, plus three more in adjacent `it()` titles / inline comments. Per the "convention-enforcing-fix-must-audit-its-own-new-code" rule, editing the docblock puts its full content in scope. Re-anchor all four on stable behavioral semantics (no round/hold numbers, no slugs):

1. Header docblock item describing arm 1a's INNER JOIN: drop the `round-1 hold #3 fix` parenthetical — anchor on the behavior (INNER JOIN enforces paper-class existence at the JOIN level; a LEFT JOIN admitted review-typed replies to non-paper posts and surfaced empty-title `new_review` notifications).
2. The `it()` title and inline comment for the arm-1a INNER-JOIN mutation-kill canary: drop the two `round-1 hold` / `round-1 hold #3` references — rename to the behavioral form.
3. The `it()` title for the arm-1a `validPevoPaperWhere(source='all')` paper-class canary: drop `round-1 hold #3` — rename to the behavioral form.

Optional (P3, do while in the file): add one clarifying sentence to the collective count==3 canary noting arm 5 has no per-arm slice because its `'new_reply'::text` tag does not recur (a first→second-occurrence boundary is impossible), so a future editor does not file a phantom "missing arm-5 slice" task.

No production-SQL change required. When the four anchors are re-anchored, `git mv` back to `review/`.
