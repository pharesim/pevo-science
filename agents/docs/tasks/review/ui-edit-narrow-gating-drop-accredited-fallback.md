# UI-EDIT-NARROW-GATING-DROP-ACCREDITED-FALLBACK — restrict edit-page access to authors + named co-authors + accepted claimers

**Owner:** UI Agent
**Created:** 2026-05-11 (surfaced during `ui-bridge-register-lock-held-ux` implementation when reviewing `edit.signInHint` copy; user decision: gating should be narrow)
**Priority:** P1 (live UI inconsistency with backend chain reconstruction)

## Problem

`frontend/src/pages/edit.js:435-447` `isAuthorized` returns `true` for any accredited user, even non-authors:

```js
get isAuthorized() {
  if (username === this.paper.author) return true;           // original author
  if (authors.some(a => a.hive === username)) return true;   // named co-author
  if (claims.some(...accepted)) return true;                 // accepted claim
  return this.isAccredited;                                  // BROAD FALLBACK
}
```

This contradicts the design memo for the edit flow (2026-04-12 `project_edit_flow_decisions`: "Who can edit: Author and co-authors listed in `pevo.authors`") and the recently-archived `ui-coauthor-continuation-publishing` task (scoped continuation publishing to named co-authors only).

The fallback is also operationally broken: the backend `extractAuthorizedContinuationAuthors` helper (shipped via the archived `backend-continuation-post-author-consent-gate`) filters non-co-author continuations out of the displayed version chain at chain reconstruction time. So today, an accredited non-author can broadcast a continuation but the post never appears in the paper's chain. The UI exposes an affordance that silently fails.

User-facing copy strings reinforce the broad read and need updating in tandem:
- `edit.signInHint`: "You also need to be the original author, a co-author, **or an accredited researcher** to edit."
- `edit.howToEditIntro`: "Editing is restricted to the people responsible for the work **and accredited researchers continuing it**. You can edit if any of these apply:"

## Decision (user, 2026-05-11): narrow gating

`isAuthorized` is authoritative on this page; the accredited-non-author fallback is dropped. Continuation publishing is scoped to named co-authors and accepted authorship-claimers, matching the design memo and the already-shipped backend filter.

## Acceptance

### 1. Code — `frontend/src/pages/edit.js`

- `isAuthorized` getter at `edit.js:435-447`: drop the `return this.isAccredited` fallback; return `false` after the three positive checks.
- Templates at `edit.js:78-102`: collapse the two `!isAuthorized && isConnected` branches (the `!isAccredited` and `isAccredited` variants) into a single branch that renders the `howToEditTitle` panel listing the three legitimate paths plus a back-to-paper CTA. The accreditation banner (`accreditationBannerTemplate('edit.accreditationRequired')` call) is dropped — accreditation is not the gate on this page.
- Drop the `accreditationBannerTemplate` import at `edit.js:7` (not used by edit.js after this change; still used by `publish.js` and `review.js`).

### 2. i18n — all 16 locales

Update `edit.signInHint` and `edit.howToEditIntro` in `en.json` + 15 non-English locales:

- `edit.signInHint` (new English): "You also need to be the original author or a named co-author to edit."
- `edit.howToEditIntro` (new English): "Editing is restricted to the people responsible for the work. You can edit if any of these apply:"

Both keys are already tracked as English stubs in STUBS.md (lines 642-656 for `signInHint`, similar range for `howToEditTitle`/`howToEditIntro`); the stub content is changing but the stub status is not. STUBS.md entries stay as-is (no new sweep needed).

`edit.accreditationRequired` is no longer referenced from `edit.js` after the template collapse; the i18n key can be left in the locale files (small dead weight, low priority follow-up to delete) or removed in this task. Implementer's call.

### 3. Unit tests — `frontend/tests/unit/pages-edit.test.js`

- Audit tests asserting `isAuthorized === true` for accredited non-authors and flip them to assert `isAuthorized === false`.
- Add a positive test for the three authorized paths (original author, named co-author, accepted claimer).

### 4. E2E tests — `frontend/tests/e2e/edit-paper.spec.js`

- Test at line 276 ("continuation edit by another accredited user broadcasts a NEW permlink with continues link, discipline disabled, banner visible"): REWRITE. Under the new gating, an accredited non-author should land on the gating panel, not the edit form. Assert: `[x-data="editPage"]` renders, edit form is NOT visible, `text=Who can edit this paper?` panel is visible. Remove all broadcast-side assertions.
- Test at line 374 ("unaccredited non-author cannot reach the edit form; gating panel and back-to-paper CTA render instead"): UPDATE. Remove the assertion `text=You need to be accredited to edit this paper.` (line 396) — the accreditation banner no longer renders on this page. Other assertions (the panel, the three bullet points, the back-to-paper CTA) stay.
- Test at line 509 ("accepted-claimer (accredited, not author, not co-author) reaches the edit form"): UNCHANGED. Accepted claimers remain authorized.

### 5. Verify

`npx vitest run` from `frontend/` — unit tests green. E2E tests require `./deploy.sh test-up`; defer to architect re-review (this task moves to `review/` without an e2e run; architect can decide whether to run e2e before archive or rely on the next CI cycle).

## Overlap

`tasks/review/ui-gating-coherence-publish-review-edit.md` references `edit.js:isAuthorized` falling back to `isAccredited` as the **current state being preserved** (line 12). With this task landing, that task's scope contracts: the `edit.js` template no longer needs the accreditation-banner + howToEdit panel split. The gating-coherence task can still close on banner-shape parity for `review.js`, but the edit.js delta it describes is partially obsoleted. Architect can decide whether to reshape the coherence task on archive or let it close with whatever's left.

## Out of scope

- Backend gating — already in place via `extractAuthorizedContinuationAuthors` (archived).
- `paper-detail.js` Edit-button gate (`edit.js:295` `isOwnPaper && !paper.is_retracted && !isBridgePaper`) — already restricts the affordance to author + named co-authors; no UI button leads accredited non-authors here, only direct URL access.
- Removing `edit.accreditationRequired` from all 16 locales — leave or remove based on cleanliness preference; not load-bearing either way.

## Priority rationale

P1 because the live UI affordance is broken (broadcasts silently filtered) and the copy strings actively misinform users about who can edit. The fix is small (one line of code + template collapse + 32 i18n string updates + test alignment) and the operational gate is already in place server-side.
