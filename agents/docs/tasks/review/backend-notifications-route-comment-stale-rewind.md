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

## Backend completion (2026-06-08, working tree):

Updated the `applySinceBlockFilter` docblock in `routes/notifications.ts` to match the `has_more` rewind contract: on `has_more === true` the client rewinds to `latest_block - 1` and re-fetches the boundary block (deduping the overlap); on `has_more === false` it advances to `latest_block`. Removed the stale unconditional "re-polls at `latest_block`" claim. Anchored on the behavioral rule (strict `> since_block` filter, boundary-block rewind) and the authoritative `agents/docs/api-contracts/notifications.md` `has_more` bullet; no line-number / slug / SHA anchors. Comment-only, no functional change.

## [Architect] (2026-06-09) — SUPERSEDED by the cursor redesign; do NOT archive as "consistent with the contract doc"

The notifications cursor redesign (architect decision from `architect-notifications-block-granular-cursor-stall`, unified scope) **removes the rewind entirely**: the route moves to newest-first fetch + whole-block delivery and the client always advances to `latest_block` (no `latest_block - 1` rewind). `agents/docs/api-contracts/notifications.md` was updated 2026-06-09 to that contract, so this task's docblock (which describes the rewind) is now INCONSISTENT with the contract doc, not consistent with it. The docblock will be rewritten by `backend-notifications-route-newest-first-whole-block` to describe whole-block delivery.

Disposition for whoever reviews this: its working-tree docblock change is interim and correctly describes the *current* (pre-redesign) code, so it is fine to leave the working-tree edit in place until the route task lands. But do NOT archive this task on the "comment matches the contract doc" acceptance criterion — that criterion is now false. Either (a) fold this task into `backend-notifications-route-newest-first-whole-block` (which owns the docblock rewrite) and archive this one as superseded, or (b) archive as superseded with a pointer to the route task. The P3 comment-consistency concern is fully absorbed by the route task's docblock-rewrite step.
