# Synchronize unaccredited-access UX across publish / review / edit

**Owner:** UI Agent
**Created:** 2026-04-28

## Problem

The product direction for unaccredited / unauthenticated users hitting the gated authoring routes is **banner on the page, not redirect** (PEvO is a filter, not a gate; root `CLAUDE.md` design principle 3). The current implementation across the three pages is inconsistent (verified 2026-04-28):

- **`frontend/src/pages/publish.js`** — matches the pattern. Connected+unaccredited → red accreditation banner (`publish.js:78`); form still renders; submit handler no-ops via `@submit.prevent="isAccredited ? handleSubmit() : null"` (`publish.js:100`); submit-button slot swaps to a "Get accredited" CTA (`publish.js:314-323`).
- **`frontend/src/pages/review.js`** — partial. Connected+unaccredited → notice with "Get accredited" link (`review.js:36`), but the rating form is wrapped in `template x-if="isAccredited && !isOwnPaper"` (`review.js:68`) and does NOT render. Users see a notice with no preview of what they would be submitting.
- **`frontend/src/pages/edit.js`** — no accreditation banner at all. `isAuthorized` getter falls back to `this.isAccredited` for non-authors (`edit.js:368`); when that's false, the page renders with no explanatory state. Unaccredited non-authors get a blank/broken page.

There are no router-level guards on `/publish`, `/edit/:author/:permlink`, `/review/:author/:permlink`. All gating is in-template per page, which is why drift happened.

## Acceptance criteria

Bring `review.js` and `edit.js` to the `publish.js` pattern:

1. **`review.js`** — when connected+unaccredited (and not own paper), render the rating form in a disabled / read-only state alongside the existing accreditation notice, OR keep the form gated but make the notice visually equivalent to publish.js's red banner. Decide which shape — disabled-form vs banner-only — best fits the academic aesthetic. Submit must be impossible without accreditation regardless of which shape is chosen.

2. **`edit.js`** — add an unaccredited-non-author state. Either a banner+disabled-form (matching `publish.js`) or a clear "you need to be accredited / be a co-author / file a claim" panel with the appropriate CTAs. Today's blank page is not acceptable.

3. **Shared helper if useful** — if the three pages converge on the same banner shape, extract a small Alpine component / template partial under `frontend/src/components/`. Don't force this if pages legitimately need different shapes; this is a "do it if it falls out naturally" item, not a requirement.

4. **i18n** — any new copy strings go through the standard stub flow (`frontend/public/messages/en.json` source of truth, English stubs into the other 15 locale files, append entries to `STUBS.md` under a fresh `### Added 2026-04-28 (UI-GATING-COHERENCE-PUBLISH-REVIEW-EDIT)` heading).

5. **Verify** — manual check in dev server with three sessions: (a) unauthenticated, (b) connected+unaccredited, (c) accredited. Each of `/publish`, `/edit/:a/:p` (non-own paper), `/review/:a/:p` (non-own paper) should show coherent affordance UX in all three states.

## Out of scope

- Adding router-level guards. Gating stays in-template; this task is about consistency, not architecture change.
- E2E coverage for these states. Once the behavior is coherent, file a follow-up `ui-e2e-gating-affordances.md` to lock it in. Doing E2E first would freeze today's inconsistency.
- Backend-side accreditation enforcement. The custody-broadcast refusal path is a separate backend concern.

## Reference

Session 2026-04-28 (this task brainstormed during the E2E coverage audit). Memory: `project_unaccredited_banner_not_redirect.md`.
