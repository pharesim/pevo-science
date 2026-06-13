# BACKEND-NOTIFICATION-VOTE-ARMS-ID-TIEBREAKER — audit the DISTINCT ON vote-arm orderings for the missing same-block id tiebreaker

**Owner:** backend
**Created:** 2026-06-12 (architect, surfaced during validation of the tiebreaker eslint-guard review: the notification vote arms use the exact latest-wins shape the accreditation convention guards, without the secondary key)
**Priority:** P3 (latent nondeterminism; consequences are display-level — a notification row's kept variant — not credit or score)

## Problem

`backend/src/notification-queries.ts`'s vote arms dedup via `SELECT DISTINCT ON (v.author, v.permlink, v.voter) ... ORDER BY v.author, v.permlink, v.voter, v.block_num DESC` with NO `id`/`op_id` secondary key. A voter CAN vote and revote (or vote twice via edit flows) within one 3-second block; for a same-block pair the kept row is planner-dependent — the same nondeterminism class the accreditation-state convention closed (`hive-primitive-aware-design-rules-for-pevo-custom-json-ops-2026-05-05.md` Rule 2 names the `(block_num, id)` ordering for ANY latest-action-wins read, explicitly including late vote ops). The `reputation.ts` DISTINCT ON sites already carry `op_id DESC`; the notification arms are the family members without it. The new `pevo/no-accred-state-read-missing-id-tiebreaker` lint rule deliberately does not cover this namespace (its gate is accredit/revoke-scoped), so the gap is unguarded.

## Goal

Every latest-wins ordering in the notification arms (and any sibling vote latest-wins read found during the audit) is deterministic for same-block op pairs — either it carries the `id`/`op_id` secondary key, or a pinned comment establishes why the tie cannot change the outcome (e.g. an earliest-wins dedup where any member of the tie group yields the same notification).

### Suggested approach

- Enumerate the `DISTINCT ON` / latest-wins orderings in `notification-queries.ts` (vote arms first; check the review/edit arms while there — some are documented earliest-wins, which may genuinely be tie-insensitive).
- For each: if the kept row's content varies across the tie group (vote vs revote, differing payload fields), add the secondary key matching the view's op-id column (mirror the `reputation.ts` sites' `op_id DESC` form). If the tie is outcome-invariant, pin the rationale in the comment instead — do not add keys mechanically where they change nothing.
- Re-verify row sets against real HAF where feasible; the tiebreaker is order-only and must not change which logical events surface, only which same-block variant is kept deterministically.

## Acceptance

- No latest-wins ordering in the notification arms lacks BOTH a deterministic secondary key AND a tie-insensitivity rationale comment.
- Notification suites green (`notifications`, `notifications-window-cursor`, `notifications-arm-sql-shape`, digest suites); any SQL-shape pins updated alongside.
- Comment anchors clean; `npm run typecheck` + `npm run lint` clean.

## Cross-references

- `backend/src/notification-queries.ts` (the vote arms).
- `backend/src/reputation.ts` (the `op_id DESC` precedent on its DISTINCT ON sites).
- `agents/docs/solutions/conventions/hive-primitive-aware-design-rules-for-pevo-custom-json-ops-2026-05-05.md` (Rule 2).
- `agents/docs/solutions/conventions/accreditation-state-read-latest-action-wins-2026-05-15.md` (the sibling family's contract).

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>

---

## Backend completion note (2026-06-14)

Audited every `DISTINCT ON` / latest-wins ordering in `notification-queries.ts`.

**Changed (added `v.id DESC` secondary key):** vote arms 2a, 2b, 2c. These are latest-wins (`ORDER BY ... v.block_num DESC`); a same-block vote/revote (or weight toggle) pair carries differing `vote_weight`, so the kept variant was planner-dependent. Added the monotonic op-id key `v.id DESC` to each dedup ORDER BY, mirroring `reputation.ts` `paper_latest_votes`' `op_id DESC` (the vote view exposes its op-id as `id`, projected `v.id AS op_id`). The DISTINCT ON prefix is preserved, so this is order-only: it changes which same-block variant is deterministically kept, not which logical events surface.

**Left key-free with a tie-insensitivity rationale comment:** all earliest-wins arms (reviews 1a/1b, reply 5, citations 6a/6b, claims 8/9). For each, a same-block tie group shares the full dedup key + `block_num`, and every emitted field is derived solely from those keys (plus joins keyed on them), so the kept variant is outcome-invariant. Per the task, keys were not added mechanically where they change nothing. The plain-SELECT arms (3 accreditation_update, 4 new_vouch, 7 claim_pending) have no DISTINCT ON and are out of scope (outer query already orders by `block_num, op_id`).

Updated the SQL-shape pin (`notifications-arm-sql-shape.test.ts` canary #7 + header) to assert the full tie-broken `ORDER BY v.author, v.permlink, v.voter, v.block_num DESC, v.id DESC` so a dropped secondary key fails red.

Implemented in worktree fan-out (worker on a rebased-onto-main base; stale-base detected and corrected before starting), commit cherry-picked to main. Comment anchors on convention names and stable symbols (no slug/round/line/SHA). Verification: `npm run typecheck` (src+tests) + `npm run lint` clean (one pre-existing `author-supersession.ts` warning, untouched); notification + digest suites 9 files / 100 tests green. Re-confirmed by the parent's post-merge full-suite run.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
