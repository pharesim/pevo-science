# UI-PEVO-ORCID-RETURN-TO-SESSION-STORAGE-MIGRATION — migrate sibling `pevo_orcid_return_to` key from localStorage to sessionStorage

**Owner:** UI
**Created:** 2026-05-17 (architect, surfaced by `/ce-code-review` re-review of `ui-non-consent-broadcast-fresh-auth-wiring` round-2 — adversarial adv-r2-5 P2/85)
**Priority:** P2

## Problem

Round-2 of `ui-non-consent-broadcast-fresh-auth-wiring` (item #7, F3) migrated the `pevo_orcid_mode` key from localStorage to sessionStorage to close the cross-tab interference attack where two tabs in different modes corrupted each other's callback dispatch. The fix was scoped to `pevo_orcid_mode`.

The sibling key `pevo_orcid_return_to` (the post-OAuth return-path stash) is written at `frontend/src/pages/recover.js:241-253` and `frontend/src/pages/orcid-callback.js:251-252` and remains in localStorage. Two concurrent recover flows in different tabs corrupt each other's return path: tab A starts a recover, writes localStorage `pevo_orcid_return_to='/recover-step-2'`; tab B starts a recover, overwrites localStorage `pevo_orcid_return_to='/recover-step-3'`; tab A's ORCID callback reads the wrong return path.

The round-2 migration comment at `recover.js:242-244` overstates the migration as "all `pevo_orcid_mode` writers migrated together" — strictly true for `pevo_orcid_mode`, but the very next code line writes `pevo_orcid_return_to` to localStorage, which can mislead future readers.

## Goal

Migrate `pevo_orcid_return_to` from localStorage to sessionStorage across all writers and readers. Bring the comment at `recover.js:242-244` in line with the actual migration scope after this task lands.

## Acceptance

1. All writers of `pevo_orcid_return_to` use `sessionStorage.setItem(...)`. Audit via `grep -rn "pevo_orcid_return_to" frontend/src/`.
2. All readers use `sessionStorage.getItem(...)`. Same grep audit.
3. The migration is atomic — no transition-period dual-write. Stale localStorage values are silently ignored by the new bundle (acceptable degradation; the user lands at `/` on a stale-tab ORCID callback).
4. Narrow or remove the comment at `recover.js:242-244` so it accurately describes the union of `pevo_orcid_mode` + `pevo_orcid_return_to` migration.
5. Update the sister unit tests (pages-recover, pages-orcid-callback) that assert localStorage interactions for this key.

## Out of scope

- Adding cleanup logic for stale localStorage values from pre-deploy bundles. The keys are inert under the new bundle (no read path touches them); leaving them to expire naturally is acceptable.
- Migrating other localStorage keys in the SPA — those are bounded to their own flows and either share a tab (per-tab is correct) or share across tabs by design (e.g., the auth session).

## Cross-references

- `agents/docs/tasks/review/ui-non-consent-broadcast-fresh-auth-wiring.md` — round-2 hold item #7 (the `pevo_orcid_mode` migration); round-3 hold carry-forward note.
- `frontend/src/pages/recover.js`, `frontend/src/pages/orcid-callback.js` — current writers/readers.

## UI implementation signal (2026-05-17, working tree)

Migration landed. Grep `pevo_orcid_return_to` shows zero localStorage usages remain in `frontend/src/`. Atomic migration — no dual-write transition.

**Changes:**
- `frontend/src/pages/recover.js:245,253` — write + error-path cleanup moved from localStorage to sessionStorage. Comment narrowed to cover the union of `pevo_orcid_mode` + `pevo_orcid_return_to`.
- `frontend/src/pages/orcid-callback.js:249-251` — read + removal moved to sessionStorage. Comment added stating the per-tab rationale.

**Test updates:**
- `frontend/tests/unit/pages-recover.test.js:323,377` — assertions switched from `localStorage.setItem`/`removeItem` to `sessionStorage.*`.
- `frontend/tests/unit/pages-orcid-callback.test.js:220,547,585` — seed key + post-teardown assertions switched to sessionStorage.

**Tests:** `pages-recover` + `pages-orcid-callback` 76/76 pass. Full frontend suite verified in the sister non-consent-broadcast commit immediately preceding this one (1190/1190).
