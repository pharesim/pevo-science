# UI-NOTIFICATION-TARGET-TYPE-RENDER — `new_vote` / `new_downvote` notifications render an empty noun (SPA reads camelCase `event.targetType`, backend emits snake_case `target_type`)

**Owner:** ui
**Created:** 2026-05-30 (surfaced by architect `/ce-code-review` of the notifications vote-arm pair; cross-reviewer P2 — correctness, api-contract, adversarial all converged at confidence 100)
**Priority:** P2 (every vote notification currently renders "X endorsed your " with the noun missing; the paper-vs-review distinction is invisible)

## Problem

`formatNotification` in `frontend/src/components/header.js` interpolates `event.targetType` (camelCase) into the `notifications.newVote` / `notifications.newDownvote` i18n strings, but the backend `NewVoteEvent` emits `target_type` (snake_case), and the notifications store ingests `batch.events` verbatim with no snake→camel transform. So `event.targetType` is always `undefined`, the `|| ''` fallback kicks in, and the i18n string `"{actor} endorsed your {targetType}"` renders as `"{actor} endorsed your "` (empty noun).

This is **pre-existing** (it predates the vote-arm content-filter change), but the backend change that just landed — `backend-notifications-vote-arm-content-filter` (archived 2026-05-30), which started emitting `target_type='review'` to distinguish endorsements of reviews from papers — raises its impact: the new distinction is computed correctly server-side and then discarded at render.

## Goal

Make `new_vote` / `new_downvote` notifications render the correct noun.

### Suggested approach

Either:
- Read `event.target_type` in `formatNotification` (both the `new_vote` case and the generic `typeMap` branch that reference `event.targetType`), OR
- Normalize snake_case→camelCase once at event ingestion in the notifications store (`frontend/src/notifications.js`, where `batch.events` is merged into `this.events`), which also covers `target_author` / `target_permlink` if any render path needs them.

Prefer the ingestion-normalization approach if other snake_case fields are (or will be) read; otherwise the local `formatNotification` read is the smaller change.

## Acceptance

- `new_vote` and `new_downvote` notifications render the noun (`paper` or `review`) in the message, not an empty string.
- A frontend test feeds a **real backend-shaped event** (snake_case `target_type`) into `formatNotification` and asserts the rendered string contains the noun for both `target_type: 'paper'` and `target_type: 'review'`. The existing header test that hand-feeds camelCase `targetType` masks this bug — update it to the real wire shape so it would have failed before this fix.
- No other notification render path silently depends on a camelCase alias of a snake_case wire field (audit `target_author` / `target_permlink`).
- `npm run typecheck` + `npm run lint` clean.

## Notes

- Optional polish (out of scope unless trivial): `{targetType}` currently interpolates the raw English token `paper` / `review`. If localized nouns are wanted, map the token to a translated word; the core fix here is only that the noun appears.
- Per CLAUDE.md `agent-native` carve-out, do not invoke `ce-agent-native-reviewer` during `/ce-code-review` for this.

## Cross-references

- `frontend/src/components/header.js` — `formatNotification` (reads `event.targetType`).
- `frontend/src/notifications.js` — event store ingestion (keeps `batch.events` verbatim).
- `frontend/public/messages/en.json` — `notifications.newVote` / `notifications.newDownvote` (interpolate `{targetType}`).
- `backend/src/notification-queries.ts` — `NewVoteEvent` (`target_type: 'paper' | 'review'`) and the `new_vote` handler.
- `agents/docs/api-contracts/notifications.md` — `new_vote` event contract.
- Surfaced by architect `/ce-code-review` run `20260530-141618`.

## UI completion note (2026-05-30)

Core fix landed: `formatNotification` now reads `event.target_type` (both the
`new_vote` case and the generic branch). Local-read approach chosen over
ingestion-normalization, confirmed safe: the notifications dropdown
(`index.html`, `x-text="formatNotification(event)"`) builds no links from
`target_author`/`target_permlink` (criterion #3 named-field audit clean), and
full snake→camel normalization would have broken the existing `block_num` /
`permlink` snake reads in the store. Tests feed the real snake_case wire shape
and were confirmed to fail against the pre-fix source.

Audit (criterion #3) surfaced two further same-class wire-field mismatches in
notification handling; both folded into this task with user approval:

1. **`paper_title` (render):** the generic branch read `event.title`, but
   `NewReviewEvent` / `NewCitationEvent` emit `paper_title` — so `new_review` /
   `new_citation` rendered an empty paper title. Now reads `event.paper_title`;
   `new_review` + `new_citation` tests assert the title renders.
2. **per-type permlink (dedup):** the store dedup key read `e.permlink`, absent
   on `new_vote` (`target_permlink`), `new_citation` (`citing_permlink`), and
   `claim_*` (`paper_permlink`) events, so the key dropped its discriminator and
   could over-dedup distinct same-block, same-actor events. The key now falls
   through the per-type permlink fields; a test asserts two same-block votes on
   different targets are both kept.

No i18n keys added/changed (existing placeholders reused), so no `STUBS.md`
entry. No contract change: `notifications.md` already documents the correct wire
shape; the frontend was the side out of sync.

## Architect re-review (2026-05-30) — HELD PENDING FIXES:

`/ce-code-review` of commit f5295b75 (6-persona fleet: correctness, testing,
maintainability, project-standards, julik-frontend-races, learnings-researcher)
confirmed the change is **functionally correct** — correctness found no logic bug,
julik confirmed the dedup key is mechanically sound (stable across polls, no
unbounded growth), project-standards is clean (no emdashes, comment anchors
durable, no new i18n keys), and learnings verified the new snake_case reads match
`api-contracts/notifications.md` exactly. One test-coverage gap blocks archive:

1. **Dedup fallback legs `citing_permlink` + `paper_permlink` are untested.** This
   commit introduced a 3-leg fallback in the store dedup key
   (`permlink || target_permlink || citing_permlink || paper_permlink`) but added
   keep-distinct + still-dedup tests only for the `target_permlink` (new_vote) leg.
   Four reviewers converged here (testing P2; corroborated by correctness,
   maintainability, julik — promoted to confidence 100). The `citing_permlink`
   (new_citation) and `paper_permlink` (claim_*) legs face the identical
   same-block / same-actor / different-target scenario the fix exists to handle, so
   they need the same regression guard the vote leg got. Add to
   `frontend/tests/unit/notifications.test.js`, each mirroring the existing
   `target_permlink` keep-distinct test:
   - two same-block, same-actor `new_citation` events differing only by
     `citing_permlink` survive dedup as 2 events.
   - two same-block, same-actor `claim_*` events (e.g. `claim_pending`) differing
     only by `paper_permlink` survive dedup as 2 events.
   (The still-dedup-identical case is already covered by the vote test; a second
   copy is optional.)

Surfaced but **NOT held** (tracked elsewhere, do not block on these):
- Pre-existing `has_more` non-read in the notifications store (julik) — separate
  reliability concern, predates this commit.
- Pre-existing `claim_*` raw-token render + missing `notifications.md` contract
  entry — filed as its own follow-up task (`ui-notification-claim-event-rendering`).
- Advisory casing/comment polish (maintainability) — optional, not required.

When the two tests land, `git mv` this file back to `tasks/review/`.

## UI re-review signal (2026-05-30, working tree)

Hold item 1 (untested dedup fallback legs) addressed. Added two keep-distinct
tests to the `dedup logic` block in `frontend/tests/unit/notifications.test.js`,
each mirroring the existing `target_permlink` (new_vote) keep-distinct test:

1. `keeps distinct new_citation events that differ only by citing_permlink` —
   two same-block, same-actor `new_citation` events in the real wire shape
   (target under `citing_permlink`, no top-level `permlink`) survive dedup as 2.
2. `keeps distinct claim_pending events that differ only by paper_permlink` —
   two same-block, same-actor `claim_pending` events (target under
   `paper_permlink`) survive dedup as 2.

Both exercise the per-type permlink fallback in the store dedup key
(`permlink || target_permlink || citing_permlink || paper_permlink`): with the
pre-fix single-leg `e.permlink` key both events in each pair collapse to one
(`toBe(2)` would fail), so each is a genuine regression guard for its leg. The
still-dedup-identical case stays covered by the existing vote test and is not
duplicated, per the hold note. Full `notifications.test.js` suite green (24).

