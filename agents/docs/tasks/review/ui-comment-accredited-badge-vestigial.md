# Comment-side `is_accredited` badge becomes vestigial — drop or repurpose

**Owner:** UI Agent
**Created:** 2026-04-28 (surfaced by `/ce-doc-review` of `backend-papers-filter-accreditation.md` — adversarial + product-lens convergence)
**Priority:** P3
**Blocked by:** `backend-papers-filter-accreditation.md` (when the comments hard-gate lands, every comment in the response carries `is_accredited: true` — the field's information content drops to zero on this surface; until then the badge is still meaningful).

## Problem

`frontend/src/components/threaded-comments.js:42` renders an "accredited" badge based on `comment.is_accredited`. After the comments hard-gate lands as part of the filter-accreditation task, every comment in `GET /api/papers/:author/:permlink/comments` has `is_accredited: true` (unaccredited authors are filtered out at the SQL level). The badge becomes visual noise — it renders unconditionally on every comment, lost signal.

## Acceptance criteria

Pick one. UI implementer's call based on visual review:

1. **Drop the badge.** Remove the conditional render at `threaded-comments.js:42` and any sibling renderings (search the file). Lose the visual element entirely; users see comments without accreditation badges (every comment is implicitly verified). Lightest change.
2. **Repurpose the badge.** Change copy/icon to "PEvO commenter" or similar — treat the always-present badge as a design statement (every comment is verified; the badge is decoration). Trade-off: visual clutter, weakens the badge's distinctiveness in other contexts.
3. **Keep the field server-side, drop only the badge.** Useful if the field has other consumers (search the codebase before deleting from the API response).

## Out of scope

- Backend-side removal of the `is_accredited` field from comments responses (separate task if this UI cleanup determines no consumer remains).
- The reviews-side `is_accredited` field — that one is still load-bearing (distinguishes direct-accredited reviewers from `hiveAnonAccount` anon-proxy reviews; do not touch).
- The papers-side `is_accredited` field — distinguishes accredited authors from `bridge_paper` exemption posts; do not touch.

## Why now

Day-1 visual coherence after the filter-accreditation task lands. Without this UI cleanup, users who learned the badge as a "verified commenter" signal lose the signal silently.

[BLOCKED by Backend] (2026-04-28) — Cannot proceed: `backend-papers-filter-accreditation.md` is itself in `blocked/` (transitively gated on `backend-bridge-paper-author-gate.md`). Until the comments hard-gate ships and every comment in the response carries `is_accredited: true`, the badge is still meaningful and dropping/repurposing it would lose live signal. Move back to `pending/` once the backend filter-accreditation task archives.
