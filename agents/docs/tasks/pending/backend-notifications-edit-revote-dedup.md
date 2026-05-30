# BACKEND-NOTIFICATIONS-EDIT-REVOTE-DEDUP — notification arms re-fire on every edit and revote (reviews, replies, citations, votes)

**Owner:** backend
**Created:** 2026-05-30 (surfaced by HAF-query multi-lens review, rank #7 high severity, correctness)
**Priority:** P1 (every edit and weight change produces a new notification surviving SPA dedup; email digests amplify)

## Problem

Arms 1a/1b/5/6a/6b in [notification-queries.ts:181-263](backend/src/notification-queries.ts#L181-L263) and [309-401](backend/src/notification-queries.ts#L309-L401) read raw `operation_comment_view`, which per [hive-schemas.md line 106](agents/docs/hive-schemas.md) carries every edit. Arms 2a/2b read raw `operation_vote_view` with no `DISTINCT ON`. Each comment edit and each weight change produces a new notification with a different `block_num`. The SPA dedup key includes `block_num`, so duplicates survive into the feed AND the email digest.

Concrete failure modes:
- A reviewer making 3 typo fixes sends 4 `new_review` notifications.
- A voter toggling 100% → 50% → 100% sends 3 `new_vote` notifications.

The `DISTINCT ON` pattern is already established at [routes/papers.ts:3249](backend/src/routes/papers.ts#L3249) and is the canonical fix.

## Goal

Wrap each affected arm in a `DISTINCT ON` subquery so edits/revotes do not produce duplicate notifications, while preserving the intent of each arm.

### Suggested approach

- **Comment arms (1a/1b/5):** `DISTINCT ON (co.author, co.permlink) ... ORDER BY ..., co.block_num ASC` — notify on publication; edits silent.
- **Citation arms (6a/6b):** `DISTINCT ON (citing.author, citing.permlink, cited_ref.author, cited_ref.permlink)` — new citations introduced in an edit still surface, but the same citation surviving across edits doesn't re-fire.
- **Vote arms (2a/2b):** `DISTINCT ON (v.author, v.permlink, v.voter) ... ORDER BY ..., v.block_num DESC` with `v.weight != 0` moved to the OUTER select so vote-then-retract suppresses the notification.

## Acceptance

- Regression tests:
  - Reviewer makes 3 edits → exactly 1 `new_review` notification.
  - Voter toggles 100% → 50% → 100% → exactly 1 `new_vote` notification with the latest weight.
  - Voter votes then retracts (weight → 0) → no `new_vote` notification.
  - Author edits a paper to add a new citation → `new_citation` fires once for the new citation; no re-fire for prior citations.
- Existing arm tests stay green.
- One real-HAF smoke test confirms the feed against a known-active account has no duplicate `block_num` keys per `(arm, author, permlink, voter)` tuple.
- Comment anchors clean.
- `npm run typecheck` + `npm run lint` clean.

## Notes

- Same file, complementary scope: this fix is structural (dedup); #14 (vote-arm content filter), #15 (citation arms paper-exists gate), #16 (claim/vouch arms signer gate), and #25 (new_reply self-exclusion) are all separate semantic fixes in the same module. They can land in any order — but bundle the SQL-shape canary changes coherently so test churn is minimized.
- The notification cache key fix (#8) makes this fix's payoff dramatically more visible — together they reduce the polling cost for active users.

## Cross-references

- [backend/src/notification-queries.ts](backend/src/notification-queries.ts) lines 181-263 (arms 1a/1b/2a/2b), 309-401 (arms 5/6a/6b).
- [backend/src/routes/papers.ts](backend/src/routes/papers.ts) line 3249 (`DISTINCT ON` precedent).
- [agents/docs/hive-schemas.md](agents/docs/hive-schemas.md) line 106 (edit semantics).
- HAF-query review run `w274tijk0` rank #7.
