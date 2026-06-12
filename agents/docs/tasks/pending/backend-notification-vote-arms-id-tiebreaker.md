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
