# UI-BRIDGE-REGISTER-LOCK-HELD-UX — Add LOCK_HELD-specific catch branch in `handleRegister()` for friendlier retry messaging

**Owner:** ui
**Created:** 2026-05-11 (surfaced by `backend-bridge-write-haf-lag-and-retry-amplification` round-1 review, api-contract reviewer AC-5 anchor 75)
**Priority:** P3

## Context

`backend-bridge-write-haf-lag-and-retry-amplification` round-2 hold item 1 renames the lock-held 409 response code on `POST /api/bridge/register` from `DUPLICATE` to `LOCK_HELD` (to distinguish "registration in progress, retry shortly" from "preprint already registered, see existing post"). When that round-2 hold lands, the SPA can branch on `err.code === 'LOCK_HELD'` to show a friendly transient-contention message instead of the generic registration-failed UI.

Today, `frontend/src/pages/bridge.js` `handleRegister()` catch (around lines 319-326) treats all errors generically: sets `step = 'error'`, logs to console, displays `$t('common.registrationFailed')` with a manual Try Again button. The user clicks Try Again and the second attempt usually succeeds (the 35s lock TTL has elapsed or the winner has released), so the behavior is functionally correct — just UX-suboptimal.

This task lands the friendlier branch after the backend `LOCK_HELD` rename ships.

## Dependency

**Gated on `backend-bridge-write-haf-lag-and-retry-amplification` round-2 hold item 1 landing.** Until the backend emits `code: 'LOCK_HELD'`, this task's SPA branch has nothing to discriminate on. Move this task from `pending/` to `blocked/` with `[BLOCKED by Backend]` if it gets picked up before round-2 lands.

## Acceptance

1. In `frontend/src/pages/bridge.js` `handleRegister()` catch (around line 319), add a branch BEFORE the generic error fallback that checks `err.code === 'LOCK_HELD'`:

   ```js
   if (err.code === 'LOCK_HELD') {
     this.step = 'error';
     this.errorMessage = this.$t('bridge.lockHeldRetry');
     // Optional: auto-retry-after-N-seconds UX, or a "Retry now" button that
     // re-invokes the register flow. Implementer's choice.
     return;
   }
   ```

   The exact branch shape (auto-retry vs explicit user action) is the implementer's call; the requirement is that `LOCK_HELD` no longer reaches the generic error path.

2. Add new i18n key `bridge.lockHeldRetry` to all 16 locale files in `frontend/public/messages/*.json`. Suggested English: "A registration for this preprint is already in progress. Please retry in a few seconds." Translations follow each locale's existing tone.

3. Verify the existing-duplicate 409 path (`code: 'DUPLICATE'`, with `existing_author`/`existing_permlink`) is NOT affected by this change — that path should continue to land on whichever existing UX handler it currently uses (likely showing the existing-post link).

4. Page renders without errors; no broken i18n references; targeted UI smoke (trigger a registration during a held lock window if possible, or mock the 409 LOCK_HELD response in a unit test).

## Tests

Add a unit test in `frontend/tests/unit/pages-bridge.test.js` (or the appropriate test file) asserting:
- A 409 response with `err.code === 'LOCK_HELD'` triggers the new branch (`errorMessage` becomes the LOCK_HELD-specific text).
- A 409 response with `err.code === 'DUPLICATE'` AND `existing_author`/`existing_permlink` does NOT trigger the LOCK_HELD branch.
- A 503 or generic 500 response still reaches the generic fallback.

## Coordination

- **Hard dependency:** `backend-bridge-write-haf-lag-and-retry-amplification` round-2 hold item 1 must land first (LOCK_HELD code rename + bridge.test.ts assertion update). If this task is picked up before that round-2 lands, mv to `tasks/blocked/` with `[BLOCKED by Backend]` note.
- Coordinate i18n key naming with any existing `bridge.*` retry-related keys (today: `bridge.lookupUnavailable`, `bridge.lookupFailed` — pick a similar tone).

## Out of scope

- Auto-retry-on-409 logic with exponential backoff. The simple manual-retry UX is sufficient for the contention frequency expected at PEvO's beta scale.
- Adding a contention-counter UI ("you are 2nd in line"). Backend doesn't expose ordering; SPA cannot show ordering.
- Other 409 paths in the bridge flow (the existing-duplicate path, which already has its own UX surface).

## Priority rationale

P3 because the user-visible impact is small (manual retry succeeds within seconds; the lock TTL is 35s worst-case). Filed because the backend rename creates a clean signal the SPA can act on, and ignoring the new code wastes the architect's hold-block work.

[BLOCKED by Backend] (2026-05-11) — `backend-bridge-write-haf-lag-and-retry-amplification` is in `tasks/pending/` with an architect round-2 hold block (re-review dated 2026-05-11) listing 9 items including item 1 (LOCK_HELD rename at `backend/src/routes/bridge.ts:321`). Verified current `bridge.ts` still emits `code: 'DUPLICATE'` for the lock-held 409 — the discriminator this task branches on does not yet exist on the wire. Move back to `pending/` once that backend task's round-2 lands and ships `code: 'LOCK_HELD'` on the lock-held 409 path.
