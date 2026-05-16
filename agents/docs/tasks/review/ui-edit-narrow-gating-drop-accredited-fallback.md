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

## Architect re-review (2026-05-16) — HELD PENDING FIXES:

Reviewed via `/ce-code-review` against commit `00d3f97` with 7 personas (correctness, testing, maintainability, project-standards, security, adversarial, learnings-researcher; `ce-agent-native-reviewer` skipped per PEvO CLAUDE.md). 4 items must land before re-review:

1. **P1 — `howToEditClaim` locale string still says "or you are an accredited researcher publishing a revision" in all 16 locale files (`frontend/public/messages/*.json`).** Cross-reviewer agreement: correctness (P1/100), adversarial (P1), learnings-echo. Task §2 listed `signInHint` and `howToEditIntro` for update but missed the third bullet rendered as the gating-panel item (`edit.js:87` → `howToEditClaim`). An accredited non-author lands on the gating panel and reads bullet #3 telling them editing is possible — directly contradicting the new `isAuthorized`. Fix direction: trim the trailing clause in all 16 locales:
   - English (en.json:205): `"howToEditClaim": "You file an authorship claim from the paper page and the author approves it."`
   - Parallel trims in `ar.json`, `cs.json`, `da.json`, `de.json`, `es.json`, `fa.json`, `fr.json`, `he.json`, `it.json`, `nl.json`, `pl.json`, `pt.json`, `sv.json`, `tr.json`, `zh.json`. STUBS.md stub status unchanged.

2. **P2 — Dead getters `isAccredited` (`edit.js:418`) and `accreditation` (`edit.js:420`).** maintainability (M3/M4 P2/100). After the narrowing, both getters are unused on this page (template no longer references them; no method body reads them). Verified by `grep -n 'isAccredited' frontend/src/pages/edit.js` matching only the declaration line. Delete both getters (4-line deletion).

3. **P3 — Task §3 acceptance gap: zero unit-test coverage for `isAuthorized` paths.** Cross-reviewer agreement: correctness (P3/75), testing (high), adversarial (P2). Task §3 explicitly required (a) audit and flip pre-existing `isAuthorized === true` assertions for accredited non-authors (the audit-half is vacuously satisfied — file has zero references), and (b) **add a positive unit test for the three authorized paths**. Half (b) was not landed. Add a `describe('isAuthorized', ...)` block to `frontend/tests/unit/pages-edit.test.js` with 4 cases:
   - Original author: `comp.paper.author = 'alice'; comp.username = 'alice';` → `isAuthorized === true`
   - Named co-author: `comp.paper.authors = [{hive: 'bob'}]; comp.username = 'bob';` → `true`
   - Accepted claimer: `comp.paper.authorship_claims = [{claimer: 'carol', status: 'accepted'}]; comp.username = 'carol';` → `true`
   - Accredited non-author (regression-kill for the dropped fallback): `comp.isAccredited = true; comp.username = 'dave';` → `false`
   ~15-line `describe` addition. Mutation-kill: restoring `|| this.isAccredited` to `isAuthorized` makes the last assertion fail.

4. **P3 — Dead i18n keys `edit.notAuthorized` and `edit.accreditationRequired` in all 16 locale files.** Cross-reviewer agreement: correctness (P3/100) + maintainability (M1/M2 P1/100, severity downgraded by synthesis). Both were rendered only by the deleted second template branch / dropped `accreditationBannerTemplate` call. Zero callsites in `frontend/src/`. Task §2 explicitly gave implementer discretion to leave them, but cross-reviewer agreement leans cleanup. Delete both keys from all 16 locale files (32 line deletions) AND trim the corresponding STUBS.md entries (search for `edit.accreditationRequired` and `edit.notAuthorized` and drop their rows).

When all 4 items are landed, `git mv` this file back to `tasks/review/`.

Dismissed at user triage (audit, not blocking): (P2 adversarial) `handleSubmit` has no `isAuthorized` guard — template-only gate; any Hive account can broadcast directly via Keychain/dhive regardless of the UI, backend is authoritative (security reviewer concurred). (P3 adversarial) `paper.authors[]` self-asserted, symmetric FE+BE trust model — out of scope; pre-existing data model. (P3 testing) Stale comment in accepted-claimer e2e test at `edit-paper.spec.js:472` referencing the now-deleted "Test 2 via isAccredited route" — routed to the e2e re-review task's hold block, not this one.

Cross-references: `frontend/src/pages/edit.js:435-447` (narrowed `isAuthorized`); `frontend/src/pages/edit.js:80-92` (collapsed template); `agents/docs/solutions/conventions/defense-in-depth-canary-must-pin-each-layer-2026-05-07.md` (learnings-researcher cited as relevant — the UI-side gate removal is correctly paired with a surviving E2E gating-panel assertion, so the canary discipline is satisfied).

## UI re-review signal (2026-05-16, commit `e9adf2b`)

All 4 round-1 hold items landed in a single commit.

- **Item 1 (P1 `howToEditClaim` trailing clause)** — Python script rewrote all 16 locale files (`frontend/public/messages/*.json`) trimming the trailing "or you are an accredited researcher publishing a revision" clause. en.json now reads `"You file an authorship claim from the paper page and the author approves it."`; the 15 non-en locales hold the same English stub (status unchanged per `STUBS.md` `### Added 2026-04-28 (UI-GATING-COHERENCE-PUBLISH-REVIEW-EDIT)` sweep).
- **Item 2 (P2 dead getters)** — deleted `get isAccredited()` and `get accreditation()` from `frontend/src/pages/edit.js:417-420` (4-line deletion). `grep -n 'isAccredited' frontend/src/pages/edit.js` now matches only a code comment at line 19 and an unrelated comment about ORCID accreditation records at line 782 (no production-code references remain). `accreditation` likewise only appears in comments.
- **Item 3 (P3 isAuthorized unit tests)** — added a `describe('isAuthorized', ...)` block to `frontend/tests/unit/pages-edit.test.js` with the 4 cases the architect specified: original author, named co-author, accepted authorship-claimer, accredited non-author with no claim (mutation-kill). The mutation-kill assertion (`returns false for an accredited non-author with no claim`) relies on `mockStores.auth.isAccredited` defaulting to true; restoring `|| this.isAccredited` to the getter makes the assertion fail. 41/41 tests green in `pages-edit.test.js`.
- **Item 4 (P3 dead i18n keys)** — same Python script also deleted `edit.notAuthorized` and `edit.accreditationRequired` from all 16 locale files (32-line deletion). `STUBS.md` trim removed the 15 `<locale>: edit.accreditationRequired` rows under the `### Added 2026-04-28` heading; `edit.notAuthorized` had no STUBS rows so nothing to trim there. The `edit.howToEditClaim` rows remain (the trimmed English still needs translation in non-en locales).

Diff is `frontend/src/pages/edit.js` (−4), `frontend/tests/unit/pages-edit.test.js` (+44), `frontend/public/messages/*.json` (16 files, −3 each = −48), `frontend/public/messages/STUBS.md` (−15). E2E run deferred per task §5 ("this task moves to review/ without an e2e run; architect can decide whether to run e2e before archive or rely on the next CI cycle") and per the parent's serialized-Playwright protocol across the three UI re-review tasks; concurrent backend agent has uncommitted backend changes in the working tree which also disfavors running `./deploy.sh restart` from this seat.
