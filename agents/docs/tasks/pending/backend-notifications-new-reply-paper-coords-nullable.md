# BACKEND-NOTIFICATIONS-NEW-REPLY-PAPER-COORDS-NULLABLE — `new_reply` event has NULL `paper_author`/`paper_permlink` despite `NewReplyEvent` type declaring them required

**Owner:** backend
**Created:** 2026-05-30 (surfaced by HAF-query multi-lens review, rank #26 medium severity, correctness)
**Priority:** P3 (no current consumer crashes today, but any consumer building `/papers/${paper_author}/${paper_permlink}` lands on `/papers/null/null`)

## Problem

Arm 5 in [notification-queries.ts:310-319](backend/src/notification-queries.ts#L310-L319) projects NULL for `paper_author` / `paper_permlink` positions. The JS handler at [notification-queries.ts:518-529](backend/src/notification-queries.ts#L518-L529) casts `r.paper_author as string` and constructs a `NewReplyEvent` whose interface declares both fields required.

The emitted object actually carries null. The published API contract ([notifications.md:70-79](agents/docs/api-contracts/notifications.md)) shows non-null example values.

No current consumer crashes today, but any consumer building `/papers/${paper_author}/${paper_permlink}` lands on `/papers/null/null`.

## Goal

Drop the misleading required fields from the event type and contract — resolving paper coords for an N-deep reply chain would require unbounded recursive SQL, which isn't worth it.

### Suggested approach

1. Drop `paper_author` and `paper_permlink` from `NewReplyEvent` and the API contract example.
2. Update [agents/docs/api-contracts/notifications.md](agents/docs/api-contracts/notifications.md) row + example to match the actual shape.
3. Remove the misleading projection from arm 5's SELECT.
4. Remove the misleading cast in the handler.

## Acceptance

- `NewReplyEvent` type no longer declares `paper_author` / `paper_permlink` as required (or removes them entirely).
- API contract example matches the actual emitted shape.
- Arm 5 SQL no longer projects NULL columns for these fields.
- Frontend (if any) consumer compiles cleanly after the type change. Note: SPA `agent-native parity` does not apply to PEvO per project context — but make sure no SPA page silently builds `/papers/null/null`.
- Comment anchors clean.
- `npm run typecheck` + `npm run lint` clean.

## Notes

- Architect doc-edit will need to land (per agent coordination rule #4 — backend changes API shape, must update doc). File the doc edit as part of this task or as a sibling architect task.
- Per CLAUDE.md `agent-native` carve-out, do not invoke `ce-agent-native-reviewer` during `/ce-code-review` for this.

## Cross-references

- [backend/src/notification-queries.ts](backend/src/notification-queries.ts) lines 310-319 (arm 5 SELECT), 518-529 (handler).
- [agents/docs/api-contracts/notifications.md](agents/docs/api-contracts/notifications.md) row 70-79 and example.
- HAF-query review run `w274tijk0` rank #26.
