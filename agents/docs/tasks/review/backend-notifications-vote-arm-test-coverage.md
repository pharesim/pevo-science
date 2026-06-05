# BACKEND-NOTIFICATIONS-VOTE-ARM-TEST-COVERAGE — add an arm-2b behavioral canary + make the 2a/2c `target_type` assertions non-tautological

**Owner:** backend
**Created:** 2026-05-30 (follow-up test polish from architect `/ce-code-review` of `backend-notifications-vote-arm-content-filter`, which archived round-1 clean on the code; these are P3 test-quality gaps, not regressions)
**Priority:** P3

## Problem

The vote-arm split (2a native paper / 2b bridge paper / 2c review) landed clean, but the new canaries in `backend/tests/notification-arm-semantics.test.ts` have two gaps:

1. **Arm 2b (bridge-paper votes) has no behavioral canary** — only the source-shape grep (`toContain('-- 2b.')`) covers it. The parent task listed "vote on a PEvO bridge paper → `target_type=paper`" as a required regression case. A weakening of the `user_bridge_papers` JOIN (e.g. switching to a `LEFT JOIN`, or dropping the `registered_by = $1` filter in that CTE) would not be caught behaviorally by any test. (Cross-reviewer: testing, security, kieran-typescript, and the correctness residual all flagged this.)

2. **The arm-2a/2c `target_type` behavioral assertions are tautological.** The synthetic-VALUES tests project `MIN('paper')` / `MIN('review')` — string constants in the *test's* reconstructed SQL — so the `.toBe('paper')` / `.toBe('review')` assertions cannot fail even if production emitted the wrong literal. The `hit_count` assertion (content filter + self-vote drop) is meaningful, and the source-shape canary's `toContain("'review'")` partly compensates, but the `target_type` behavioral check proves nothing on its own.

## Goal

Close both gaps without expanding the synthetic-VALUES pattern beyond what PEvO already accepts.

### Acceptance

- A `skipIf(!isHafConfigured())` synthetic-VALUES canary mirrors the `user_bridge_papers` CTE inline: one **registered** bridge paper (`registered_by` = recipient) and one **unregistered** `bridge_paper` authored by the same bridge account; assert `hit_count = 1` so a JOIN-form or `registered_by` regression is caught behaviorally.
- The 2a/2c `target_type` assertions derive the projected value from the joined row's `json_metadata` (or the arm's actual fixed projection) rather than a `MIN('<literal>')` constant, so the assertion would fail if production emitted the wrong type.
- Existing canaries stay green; `npm run typecheck` + `npm run lint` clean; comment anchors clean.

## Notes

- Optional, low value (do only if trivial): a one-line comment on the trailing NULL-padding block in arms 2a/2b/2c naming the skipped columns (`paper_title`, `accredit_action`, `accredit_method`, `vouch_relationship`, `parent_author`, `parent_permlink_ref`). Column-count misalignment is already caught at query-execution and by the source-shape canary, so this is readability only. Do NOT introduce a shared SQL helper/CTE to DRY the three projections — that is premature abstraction for `UNION ALL` branches whose JOIN strategies differ.
- Parent task `backend-notifications-vote-arm-content-filter` archived clean 2026-05-30; this is additive coverage, not a hold.
- Synthetic-VALUES `it.skipIf(!isHafConfigured())` canaries are the accepted PEvO deterministic-edge-case pattern.
- Per CLAUDE.md `agent-native` carve-out, do not invoke `ce-agent-native-reviewer` during `/ce-code-review` for this.

## Cross-references

- `backend/tests/notification-arm-semantics.test.ts` — arm-2a/2b/2c canaries.
- `backend/src/notification-queries.ts` — vote arms 2a/2b/2c and the `user_bridge_papers` CTE.
- Surfaced by architect `/ce-code-review` run `20260530-141618`.
