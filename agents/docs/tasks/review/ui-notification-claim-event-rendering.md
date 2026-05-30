# UI-NOTIFICATION-CLAIM-EVENT-RENDERING — claim_* notifications render the raw type token ("claim_pending"); also bring the notifications contract in sync

**Owner:** ui (rendering — the headline deliverable) + architect companion (contract doc, deliverable 2)
**Created:** 2026-05-30 (surfaced by architect `/ce-code-review` of `ui-notification-target-type-render`, commit f5295b75; pre-existing, out of that task's scope — filed per user triage)
**Priority:** P3 (real but low-impact: claim notifications are comparatively rare and the dropdown still shows *something*, just an unfriendly token)

## Problem

`formatNotification` in `frontend/src/components/header.js` has no `typeMap` entry for the authorship-claim event types, and `frontend/public/messages/en.json` has no `notifications.claim*` i18n keys. So `claim_pending` / `claim_approved` / `claim_revoked` events fall through `if (!key) return event.type;` and render the literal token (e.g. `claim_pending`) in the notifications dropdown instead of a human sentence.

These events are emitted by the backend (`backend/src/notification-queries.ts`): an authorship claim on a paper produces `claim_pending` to the post author, and `claim_approved` / `claim_revoked` on resolution.

Separately, `agents/docs/api-contracts/notifications.md` documents no `claim_*` event type, even though the frontend notifications-store dedup key already reads `paper_permlink` for these events (added in commit f5295b75). The contract is out of sync with what the backend emits.

## Event shapes (from `backend/src/notification-queries.ts`, verify before writing copy)

- `claim_pending`: `{ block_num, type: 'claim_pending', actor, paper_author, paper_permlink }`
- `claim_approved`: `{ block_num, type: 'claim_approved', paper_author, paper_permlink }` (no `actor`)
- `claim_revoked`: `{ block_num, type: 'claim_revoked', paper_author, paper_permlink }` (no `actor`)

Confirm the full `BaseNotificationEvent` field set and re-confirm whether `claim_approved` / `claim_revoked` carry an `actor` before authoring strings — `claim_pending` does, the resolution events as typed do not.

## Goal

1. **(UI)** Render claim events as human sentences. Add `typeMap` entries for the three claim types in `formatNotification` plus matching `notifications.claimPending` / `notifications.claimApproved` / `notifications.claimRevoked` keys in `en.json` (and any sibling locale files that mirror `en.json`). The pending copy can be actor-driven ("{actor} claimed authorship of your paper"); approved/revoked carry no `actor`, so phrase them impersonally. Reuse the snake_case wire-field read pattern established by f5295b75 (read `paper_author` / `paper_permlink` directly; the `{actor}` param bag key stays camelCase to match the i18n placeholder). Add a header test feeding the **real snake_case wire shape** for each claim type that asserts the rendered string is non-empty and contains no raw `claim_` token (it would fail against the current pass-through).
2. **(Architect companion)** Add the `claim_pending` / `claim_approved` / `claim_revoked` event entries to `agents/docs/api-contracts/notifications.md`, matching the shapes above, including the `paper_permlink` field the store dedup key relies on. This can be done by the architect during review of part 1 or ahead of it.

## Acceptance

- claim_* notifications render a localized sentence, not the raw type token.
- A header test feeds a real snake_case claim event and asserts the sentence renders (would fail against the current `return event.type` fall-through).
- `notifications.md` documents the three claim event shapes (including `paper_permlink`).
- `npm run typecheck` + `npm run lint` clean; any new i18n key recorded per the STUBS.md convention if one applies.

## Cross-references

- `frontend/src/components/header.js` — `formatNotification` typeMap (no claim entry; hits the `return event.type` fall-through).
- `frontend/public/messages/en.json` — `notifications.*` keys.
- `backend/src/notification-queries.ts` — `ClaimPendingEvent` / `ClaimApprovedEvent` / `ClaimRevokedEvent`.
- `agents/docs/api-contracts/notifications.md` — missing claim_* contract entries.
- Surfaced by architect `/ce-code-review` run 20260530-195129.

## UI completion note (2026-05-30)

Deliverable 1 (UI rendering) landed. Deliverable 2 (the `notifications.md`
contract entries) is the architect companion's and is intentionally untouched
here (outside the UI zone).

Event shapes re-confirmed against `backend/src/notification-queries.ts` before
authoring copy:
- `claim_pending` carries `actor` (the claimer) and notifies the **post author**
  (arm 7, `paper_author = $1`). Copy is actor-driven: "{actor} claimed authorship
  of your paper".
- `claim_approved` / `claim_revoked` carry **no `actor`** (the column is NULL) and
  notify the **claimer** (arms 8/9, `claimer = $1`). Copy is impersonal and in the
  claimer's voice: "Your authorship claim was approved" / "...was revoked".
- None of the three carry `paper_title`, so no copy references a title.

Changes:
- `header.js`: three `typeMap` entries (claim_pending/approved/revoked →
  `notifications.claimPending/claimApproved/claimRevoked`). The generic branch
  already passes `actor`, satisfying claim_pending.
- `en.json`: three real-English keys after `newReply`. The 15 non-English locales
  carry the same English as stubs, tracked in `STUBS.md` under a new
  `### Added 2026-05-30 (UI-NOTIFICATION-CLAIM-EVENT-RENDERING)` sweep (45 lines).
- `components-header.test.js`: three `formatNotification` tests feeding the real
  snake_case claim wire shape, asserting the localized key renders, the claimer
  actor appears for claim_pending, and no raw `claim_` token leaks. Each fails
  against the pre-fix `return event.type` fall-through. Suite green (15).
