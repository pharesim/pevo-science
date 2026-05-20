# UI-BRIDGE-REGISTER-LOCK-HELD-UX — SPA affordance for the new 409 LOCK_HELD error code on /api/bridge/register

**Owner:** UI Agent
**Created:** 2026-05-20 (architect, filed at archive of `backend-bridge-write-haf-lag-and-retry-amplification` — carry-forward from round-2 hold block 2026-05-11 that prescribed this followup "at archive"; gating dependency LOCK_HELD rename landed in round-2 commit `8f81492`)
**Priority:** P2

## Problem

`backend-bridge-write-haf-lag-and-retry-amplification` round-2 split the `/api/bridge/register` 409 conflict response into two distinct error codes (per architect hold item 1):

- `LOCK_HELD` — concurrent `/register` attempt in flight on the same deterministic permlink. The first request holds a Redis SETNX lock; the second gets 409 with `{retriable: true}`. Self-clears in ≤35s when the first lock TTL expires.
- `DUPLICATE` — a paper with that permlink already exists on chain (broadcast landed previously). Non-retriable. Response carries `existing_author` and `existing_permlink`.

The SPA's `/register` flow today branches on `err.code === 'DUPLICATE'` (or message text — verify the current branch shape). It does not distinguish `LOCK_HELD` from `DUPLICATE`. Effect: a user who hits a transient lock conflict sees the "already registered" message (with the `existing_author`/`existing_permlink` fields missing on the lock-held branch — which the SPA may render as "undefined" or fall back to a generic error). The lock conflict is retriable; the user should see a "retry in a moment" affordance, not a permanent failure message.

## Goal

Update the SPA's `/register` (bridge registration) flow to branch on the new error code split:

- `code === 'LOCK_HELD'` → user-facing message "Registration is in progress; please retry in a moment" + automatic or button-driven retry after a short delay (1-3s). Surface the `details.retriable: true` discriminator if available.
- `code === 'DUPLICATE'` → existing behavior, surface `existing_author` and `existing_permlink`. No retry affordance.
- Other 4xx/5xx → existing error envelope handling.

## Acceptance

1. **Locate the SPA bridge-register call site.** Likely in `frontend/src/pages/` (publish/bridge flow) or a sibling component. Inspect which file consumes the `/api/bridge/register` response and where the current error branching happens.
2. **Branch on `err.code`** for the two 409 cases. Match the established pattern used elsewhere in the SPA (e.g., the HAF-outage 503 retry-card affordance from `ui-haf-outage-503-retry-affordance`).
3. **Retry UX for LOCK_HELD.** Match the SPA's existing retry-affordance convention. Architect discretion: auto-retry with a small backoff (1-3s, capped at 2-3 attempts) vs. manual retry button — pick what matches the surrounding UX.
4. **i18n.** New error-message key for the LOCK_HELD case. Stub the other locales per the `frontend/public/messages/STUBS.md` convention.
5. **Test.** A component-tier test pinning the LOCK_HELD branch routes to the retry affordance (not the existing-duplicate template).

## Out of scope

- Changing the backend contract. The contract is shipped and documented in `agents/docs/api-contracts/bridge.md` + `common.md`.
- Adding new error codes. Only the existing LOCK_HELD / DUPLICATE split is being surfaced to UX.

## Cross-references

- `agents/docs/api-contracts/bridge.md` — contract for the two 409 codes.
- `agents/docs/api-contracts/common.md` — standard `details.retriable` convention.
- `backend/src/routes/bridge.ts` — backend emit sites (LOCK_HELD at line ~420, DUPLICATE at line ~426 area).
- `ui-haf-outage-503-retry-affordance` (archived 2026-05-20) — analogous SPA retry-card pattern.
- `agents/docs/tasks-archive.md` — `backend-bridge-write-haf-lag-and-retry-amplification` archive entry references this followup.
- Round-2 hold-block of `backend-bridge-write-haf-lag-and-retry-amplification` (2026-05-11) — original architect-zone followup prescription.
