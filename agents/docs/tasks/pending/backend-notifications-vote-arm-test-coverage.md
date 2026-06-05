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

---

## Architect re-review (2026-06-05) — HELD PENDING FIXES

`/ce-code-review` fan-out (correctness, testing, maintainability, project-standards, kieran-typescript) on commit `93efaf30`. The new 2b canary's internal discrimination verified (an INNER-to-LEFT flip or a registered_by drop inside the mirrored SQL flips hit_count from 1 to 2); standards clean; no DRY helper introduced. But the task's core acceptance is not met. Two items block archive:

1. **target_type is still never pinned against production (P1).** The de-tautologization moved the constant from the test's SELECT into the test's own VALUES fixture; production's projection literals remain unconsulted. Repo-wide, nothing asserts `'paper'::text AS target_type` for arms 2a/2b or `'review'::text` for arm 2c, so swapping a literal in production fails zero tests (with a single fixture row, `MIN(p.target_type)` is fully implied by hit_count). The new 2b canary also reintroduces the condemned `MIN('paper'::text)` shape. Fix: (a) add slice-localized SOURCE pins in the vote-arms source-shape test asserting each arm's projection literal inside its tag-bounded slice — the source layer is the only one that consults production; (b) bring 2b to the fixture-derived form 2a/2c use (a target_type column on bp_src, carried through user_bridge_papers, projected via `MIN(bp.target_type)`) for pattern consistency.

2. **2b production pins (P2).** The two mutations the completion note claims to catch (INNER-to-LEFT on the user_bridge_papers JOIN, dropped `registered_by` predicate) leave every test green when applied to PRODUCTION SQL — the source test pins only the `-- 2b.` comment marker. Slice arm 2b in the source test and assert the INNER JOIN form (no LEFT variant) plus the `registered_by` predicate text inside the user_bridge_papers CTE region, per the established citation-arm pin pattern.

Optional (non-blocking, while in the file): (a) one-line comment scoping the vote-arm mirrors to the single-op-per-voter simplification — they reproduce the pre-dedup flat arm shape with an inline weight filter that production no longer contains anywhere, and a sibling canary pins production's inline-weight count at zero; (b) inline registered/unregistered comments on the bp_src rows matching the v-CTE rows' style; (c) name the production symbol (`fetchNotificationsFromHaf`, notification-queries.ts) in the mirror comment as the drift breadcrumb.
