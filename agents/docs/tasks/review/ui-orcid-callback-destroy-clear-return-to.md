# UI-ORCID-CALLBACK-DESTROY-CLEAR-RETURN-TO — clear stale `pevo_orcid_return_to` on orcid-callback destroy()

**Owner:** UI
**Created:** 2026-05-17 (architect, surfaced by `/ce-code-review` on `ui-pevo-orcid-return-to-session-storage-migration` — julik-frontend-races RR-2)
**Priority:** P3

## Problem

`frontend/src/pages/orcid-callback.js` reads + removes `pevo_orcid_return_to` on the happy path of `completeOrcid`. If the controller is torn down before that line runs — user SPA-navigates away from `/orcid/callback` while the callback is still in flight (waiting for the backend response) — the key persists in sessionStorage for the rest of the tab session.

A subsequent ORCID flow initiated in signup mode (or any flow that does NOT write `pevo_orcid_return_to`) then reads the stale `returnTo = 'recover'` on its callback and routes the user to `/recover` instead of the correct destination after a successful link.

`pevo_orcid_mode` has a destroy-time-clear counterpart at `auth.js:155`; `pevo_orcid_return_to` lacks the parity. The migration to sessionStorage (task `ui-pevo-orcid-return-to-session-storage-migration`, archived 2026-05-17) reduced cross-tab corruption to per-tab; this finding is the per-tab residual that the round-2 sister key already closes.

## Goal

Add a one-line `sessionStorage.removeItem('pevo_orcid_return_to')` in the orcid-callback controller's `destroy()` so that abandoning mid-callback does not leak the return-path into the next ORCID flow.

## Acceptance

1. `frontend/src/pages/orcid-callback.js` — in `destroy()`, call `sessionStorage.removeItem('pevo_orcid_return_to')`. Mirror the existing `pevo_orcid_mode` destroy-time cleanup pattern (which lives in `auth.js:155` for the sibling key — verify before deciding whether to colocate or follow the orcid-callback-local pattern).
2. Unit test in `frontend/tests/unit/pages-orcid-callback.test.js`: seed sessionStorage with `pevo_orcid_return_to = 'recover'`, call `destroy()` on the controller before `completeOrcid` resolves, assert the key is removed.
3. No production behavior change on the happy path (the key is already removed when the callback completes successfully).

## Out of scope

- The same parity check for any other ORCID-flow-scoped sessionStorage keys not enumerated in this task. If new keys land later, apply the destroy-clear pattern at write time.
- Cross-tab cleanup (already addressed by the sessionStorage migration; localStorage stale values from pre-deploy bundles are inert per the migration task's documented design).

## Cross-references

- `agents/docs/tasks-archive.md` — `UI-PEVO-ORCID-RETURN-TO-SESSION-STORAGE-MIGRATION (archived 2026-05-17)` for the parent migration.
- `frontend/src/pages/orcid-callback.js` (read/remove on success at line ~249-253).
- `frontend/src/auth.js:155` — sibling pattern for `pevo_orcid_mode`.
