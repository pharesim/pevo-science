# UI-MID-BROADCAST-SPA-NAVIGATION-GUARD — block router navigation during light→self custody upgrade broadcast

**Owner:** UI
**Created:** 2026-05-17 (architect, surfaced by `/ce-code-review` re-review of `ui-custody-upgrade-seed-phrase-derive-flow` round-2 — adversarial adv-r2-3 P1/85)
**Priority:** P2 (catastrophic outcome, but requires user-initiated navigation; the broader hold block fix #2 closes the page-close path)

## Problem

Round-2 of `ui-custody-upgrade-seed-phrase-derive-flow` added a `beforeunload` guard (item #2) to warn users when they attempt to close the tab during `upgradePhase === 'upgrading'`. The `beforeunload` event only fires on tab/window close — NOT on SPA-internal navigation via the router (clicking a link, calling `navigate(...)`, browser back/forward).

A user mid-broadcast who clicks the PEvO logo or another navigation link silently leaves the upgrade flow without warning. The component unmounts; the in-flight POST to `/api/custody/upgrade` is orphaned; the chain may already have rotated; backend cleanup may or may not have completed. The user lands on a new page with their session in an indeterminate state — light JWT pointing at an account whose chain keys have rotated.

## Goal

Add a router-level navigation guard that warns or blocks SPA-internal navigation while `upgradePhase === 'upgrading'`.

## Acceptance

1. Hook into the router's pre-navigation event (or equivalent — whatever Alpine's router exposes; if no native hook exists, intercept `navigate(...)` and `<a>` click handlers in the upgrade component's scope).
2. When `upgradePhase === 'upgrading'`, surface a confirmation prompt (same UX register as the `beforeunload` warning) BEFORE allowing the navigation. On confirm, proceed; on cancel, prevent the navigation.
3. The guard activates on `init()` (or when phase enters 'upgrading'), deactivates on terminal phase or `destroy()`. Mirrors the `beforeunload` lifecycle for the page-close path.
4. Unit test: assert the guard fires during 'upgrading' phase and not during any other phase.

## Out of scope

- The page-close path (already addressed by `beforeunload` in round-2 #2).
- Replicating the guard in other long-running flows (publish broadcast, vouch broadcast, etc.) — those flows already complete on a shorter timescale and their step-machine reset on `FRESH_AUTH_REDIRECT_PENDING` covers the recovery path.
- Backend recovery for the orphaned-broadcast case — `tasks/pending/backend-custody-upgrade-status-probe.md` (if filed) would address that separately.

## Cross-references

- `agents/docs/tasks/review/ui-custody-upgrade-seed-phrase-derive-flow.md` — round-2 hold #2 (`beforeunload`) and the round-3 hold carry-forward note.
- `frontend/src/pages/settings.js` — current `beforeunload` implementation at `init()` / `destroy()`; the SPA-navigation guard lives alongside it.
