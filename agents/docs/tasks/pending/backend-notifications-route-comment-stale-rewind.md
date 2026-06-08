# BACKEND-NOTIFICATIONS-ROUTE-COMMENT-STALE-REWIND — applySinceBlockFilter docblock describes the old cursor-advance rule

**Owner:** backend
**Created:** 2026-06-08 (review follow-up from `ui-notifications-block-cursor-boundary-rewind`)
**Priority:** P3 (stale doc comment; no behavior change)

## Problem

The docblock above `applySinceBlockFilter` in `backend/src/routes/notifications.ts` states the client "re-polls with `since_block = latest_block`, which is the highest block among the delivered events". That described the cursor-advance rule before the SPA rewind fix landed. The SPA now rewinds the cursor to `latest_block - 1` whenever the route emits `has_more === true`, so the boundary block (events that the response `limit` cut, sharing `latest_block`) is re-fetched. Re-polling at exactly `latest_block` would skip those boundary events under the strict `block_num > since_block` filter.

The comment now mis-describes the consumer contract. The route code itself is correct; only the comment is stale.

## Goal

Update the `applySinceBlockFilter` docblock so its description of the client cursor rule matches the `has_more` rewind: on `has_more === true` the client re-polls at `latest_block - 1` (rewind one block, re-fetch the boundary, dedup the overlap); on `has_more === false` it advances to `latest_block`. The authoritative client-facing statement now lives in `agents/docs/api-contracts/notifications.md` (the `has_more` field bullet, updated 2026-06-08) — keep the code comment consistent with it.

## Acceptance

- The `applySinceBlockFilter` docblock no longer claims the client re-polls at `latest_block` unconditionally.
- Comment anchors on the behavioral rule (strict `> since_block` filter, boundary-block rewind), not on line numbers, task slugs, or SHAs (per root `CLAUDE.md` "Comment anchors").
- No functional change; backend test suite unaffected.

## Cross-references

- `backend/src/routes/notifications.ts` (`applySinceBlockFilter` docblock).
- `agents/docs/api-contracts/notifications.md` (`has_more` field bullet — the authoritative client contract).
- `frontend/src/notifications.js` (poll loop rewind — the consumer).
