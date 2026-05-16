# UI-AUTHOR-INPUT-ACCREDITED-PREFILL — prefill ORCID and deactivate input when author's hive is accredited

**Owner:** UI Agent
**Created:** 2026-05-06 (filed at archive of `backend-continuation-post-author-consent-gate.md`, A7; surfaced during round-3 triage finding #3 split-call)
**Priority:** P3

## Problem

The publish form's authors-list input asks the user to enter `{name, hive, orcid, affiliation}` per author. When the author's `hive` field is set to an accredited Hive account, ORCID is already known on the platform (it's part of the accreditation record). Forcing the user to type it again creates two failure modes:

1. **Typo divergence.** The user's hand-typed ORCID differs from the accreditation's bound ORCID; the `pevo.authors[].orcid` field on chain mismatches the accredited identity. Downstream surfaces that key on the chain ORCID diverge from the accredited identity surface.

2. **UX friction.** The user is asked to re-enter information the platform already knows.

## Goal

When the user enters a hive account in the authors list and that account is currently accredited, prefill the ORCID field from the accreditation record and deactivate (read-only or visually-locked) the ORCID input. Surface an "(accredited)" indicator on the entry so the user can see why the field is locked.

Provide a click affordance on the username input to find/select an accredited Hive account (autocomplete from `GET /api/accreditations` or equivalent), reducing the chance of a typo silently locking out the legitimate accredited author.

## Acceptance

1. **ORCID prefill.** When the `hive` field on an authors-list entry is set to an accredited account, the entry's `orcid` field is prefilled from the accreditation record and the input is deactivated. If the user clears the `hive` field (or types one that is not accredited), the ORCID field becomes editable again.

2. **Click affordance.** The username input on each authors-list entry exposes an autocomplete or selector listing accredited accounts the user can pick from (per the user's reading: keeps publishers within the accredited set rather than guessing handles).

3. **Backend-data dependency.** The lookup is read-only (no broadcast). Requires either an existing accreditation lookup endpoint or a thin one if not yet present. Confirm with the architect what surface to read from (probably already exists via `GET /api/accreditations`).

4. **Visual signal.** The deactivated ORCID input has a clear visual marker (e.g. greyed-out + lock icon + "(accredited)" badge) so the user understands why it can't be edited.

5. **Native publish form + edit form.** Apply to both `frontend/src/pages/publish.js` (or wherever the new-paper authors-list editor lives) and `frontend/src/pages/edit.js` (or the edit-paper variant). Continuation-post creation surface, when it ships, follows the same rule.

## Cross-references

- `agents/docs/tasks/blocked/ui-multi-author-consent-affordances.md` — adjacent task covering `author_accept` / `author_resign` affordances; this prefill task is independent but lives in the same general code surface.
- `backend-continuation-post-author-consent-gate.md` round-3 triage finding #3 (archived 2026-05-06) — original surfacing of the split-call rationale.

## Architect re-review (2026-05-11) — HELD PENDING FIXES:

Reviewed via `/ce-code-review` against commit `d1d8935 ui(authors): prefill+lock co-author ORCID for accredited Hive accounts` with 6 personas (correctness, testing, maintainability, project-standards, julik-frontend-races, learnings-researcher; `ce-agent-native-reviewer` skipped per project CLAUDE.md).

The new `frontend/src/lib/accredited-directory.js` lib + its unit tests are well-shaped (caching, in-flight coalescing, normalization, failure-path tested). The integration into `publish.js` / `edit.js` has correctness gaps around state-transition semantics and zero page-integration coverage. Address before re-review:

1. **P2 — `updateCoAuthor` doesn't clear ORCID on accredited→non-accredited hive transition (publish.js:607-612; same shape at edit.js:765-770).** Trace: user enters `hive='alice'` (accredited) → ORCID prefilled to alice's ORCID and locked. User changes `hive='bob'` (not accredited) → `acc` is null, no mutation; ORCID input re-enables but RETAINS alice's value. If the user does not notice and submits, the Hive post carries bob's row with alice's ORCID — incorrect on-chain author metadata. This is exactly the failure mode the task's "Problem" section item 1 (typo divergence) warns about. Fix direction: when `field === 'hive'`, write `ca.orcid = acc ? (acc.orcid || '') : ''` so the transition out of accredited clears the field. Apply equivalently in both pages.

2. **P2 — `_loadAccreditedDirectory` reapplication loop clobbers user-typed ORCID (publish.js:639-642; edit.js:770-773).** When the directory resolves, the loop unconditionally writes `acc.orcid` over any existing `coAuthors[i].orcid` if the row's hive is accredited. A user who typed an ORCID before the fetch returned (or supplemented a generic prefill) has their input silently replaced. Fix direction: only write when `ca.orcid` is blank or already equals a prior accreditation value; alternatively, track a per-row `orcidLocked` flag flipped when the inline `updateCoAuthor` prefill fired, and only reapply for rows where the user has not interacted with the field.

3. **P2 — Page-integration of prefill has zero test coverage (`frontend/tests/unit/pages-publish.test.js` and `pages-edit.test.js`).** The new methods (`updateCoAuthor` hive-prefill branch, `isCoAuthorAccredited`/`isNewCoAuthorAccredited`, `_loadAccreditedDirectory` including the reapplication loop) are exercised only at the function level via the lib unit tests. Mount the page component in a unit harness (matching the existing pages-publish/edit test patterns), seed `accreditedDirectory` with a fixture row, and verify: (a) typing an accredited hive prefills ORCID and locks the input, (b) typing a non-accredited hive leaves ORCID editable AND clears any stale prefill (per item 1), (c) reapplication-loop semantics after the fix from item 2, (d) edit.js's `existingCoAuthors` stay disabled regardless of accreditation state (the publish/edit asymmetry the task calls out).

4. **P2 — `frontend/tests/unit/lib-accredited-directory.test.js` lacks file-header carve-out justification.** The test mocks `../../src/api.js`. Root CLAUDE.md "Carve-out for deterministic edge-case coverage" clause (a) requires the test file header to document the justification explicitly. Add a short comment block at the top of the file naming the impractical real path (live HAF accreditation set could change mid-test and break shape-conversion assertions) and the real-path companion or follow-up task covering the integrated `fetchAccreditations → loadAccreditedDirectory → publish-form-prefill` flow. If no companion exists, file a follow-up task per the carve-out's clause (c).

5. **P2 — `accreditedCoAuthor(index)` is defined-but-unused (publish.js:626).** No template binding or other call site references it. Either wire it (e.g., surface the accredited author's institution as a tooltip on the locked ORCID row) or remove. Note `edit.js` does not define an analogue — the asymmetry suggests publish.js's definition was speculative.

6. **P2 — `_loadAccreditedDirectory` body duplicated verbatim across publish.js and edit.js.** Publish.js:632-644 and edit.js:789-801 are structurally identical, differing only on `coAuthors` vs `newCoAuthors`. The next maintainer who tweaks the mounted-guard, the prefill loop, or the reapplication logic will edit one site and forget the other. Extract a shared helper — either an Alpine-mixin object exported from `accredited-directory.js`, or an `applyAccreditedPrefill(rows, directory)` helper invoked from each page's lightweight `_loadAccreditedDirectory`.

7. **P3 — `if (this._mounted === false) return` (publish.js:634; edit.js:763) inconsistent with the file's own `!this._mounted` idiom used at all other guard sites in both files.** Mechanically equivalent today because `createTimerGuard()` always initializes `_mounted: true`. The codebase-wide idiom `!this._mounted` survives an accidental omission of the timer-guard mixin where the strict-equality form silently degrades. Unify to `!this._mounted`.

8. **P3 — Concurrent-rejection coalescing untested (lib-accredited-directory.test.js).** Existing concurrent-coalescing test covers the success path (3 concurrent callers, 1 fetch). The rejection path is tested only for a single call. Add a test that mocks `fetchAccreditations` to reject after 3 concurrent `loadAccreditedDirectory()` calls in flight, and assert all three resolve to `{}` (not throw).

9. **P3 — `acc.orcid` undefined-in-directory not tested (lib-accredited-directory.test.js).** Current impl writes `acc.orcid || ''` when prefilling, which writes empty string if a directory row exists without an `orcid` field. After landing item 1 (clear-on-transition-out), this corner becomes load-bearing: a malformed accreditation row could blank the user's ORCID. Add a test mocking `fetchAccreditations` to return `{ username: 'alice', name: 'Alice' }` with no `orcid`, then assert `lookupAccredited` returns the row but `acc.orcid` is undefined — and decide+document the desired semantic for the prefill code path in this case (recommended: skip prefill, don't write `''`).

When all 9 items are landed, `git mv` this file back to `tasks/review/`.

Dismissed (audit, not blocking): P3 fetch-failure no-retry/backoff (accepted UX tradeoff — single-instance PEvO, future hardening if accreditation churn grows); P3 `DIRECTORY_LIMIT=200` sync marker (judgment call); P3 raw-English i18n stubs (pre-existing project pattern beyond this task's scope).

## UI re-review signal (2026-05-11, commits ae7e853, 820a710, eb1416b)

All 9 hold items landed across 3 commits. Worker rebased onto main before applying.

- Item 1 (P2, clear ORCID on accredited→non-accredited transition) — `ae7e853`. Replaced inline `if (acc) ca.orcid = acc.orcid || ''` in `updateCoAuthor` (publish.js) and `updateNewCoAuthor` (edit.js) with shared `applyHiveChangePrefill(row, dir)` helper that clears `row.orcid` when the new hive is non-accredited.
- Item 2 (P2, reapplication-loop clobbering user-typed ORCID) — `ae7e853`. `_loadAccreditedDirectory` (both pages) delegates to shared `applyAccreditedPrefill(rows, dir)` which only writes when `row.orcid` is blank.
- Item 3 (P2, page-integration test coverage) — `820a710`. Added `co-author ORCID prefill (page integration)` describe block: 8 tests in `pages-publish.test.js`, 8 in `pages-edit.test.js`. Cover accredited prefill+lock, non-accredited free input, transition-out clearing, transition-between-accredited, reapplication-preserves-user-typed, reapplication-fills-blank, item-9 semantic, post-teardown bail. Edit page also pins existingCoAuthors-stay-disabled asymmetry.
- Item 4 (P2, carve-out justification block) — `820a710`. Carve-out block added at top of `lib-accredited-directory.test.js` per root CLAUDE.md clauses (a)/(b)/(c). Filed `ui-e2e-coauthor-accredited-prefill.md` as the clause-(c) follow-up real-path companion (commit `eb1416b`).
- Item 5 (P2, remove unused `accreditedCoAuthor`) — `ae7e853`. Deleted speculative method from publish.js.
- Item 6 (P2, deduplicate `_loadAccreditedDirectory` body) — `ae7e853`. Both pages now invoke shared helpers from `frontend/src/lib/accredited-directory.js`. Page-side `_loadAccreditedDirectory` is a 4-line shell.
- Item 7 (P3, `!this._mounted` idiom unification) — `ae7e853`. Replaced `if (this._mounted === false) return` with `if (!this._mounted) return` at both sites.
- Item 8 (P3, concurrent-rejection coalescing test) — `820a710`. Added test mocking `fetchAccreditations` to reject with 3 concurrent `loadAccreditedDirectory()` calls in flight; asserts all three resolve to `{}` with one fetch.
- Item 9 (P3, undefined-orcid-in-directory test) — `820a710`. Added: (a) `loadAccreditedDirectory` keeps a row without `orcid` indexable; (b) `applyHiveChangePrefill` and `applyAccreditedPrefill` leave a typed orcid intact when the matched directory row has no orcid (documented semantic: don't blank user input).

Worker ran 109 tests across the three target unit files; all pass. No Playwright run for this task (no E2E scope).

## Architect re-review (2026-05-16, round-2) — HELD PENDING FIXES:

`/ce-code-review` ran on commits `ae7e853`, `820a710`, `eb1416b`. 7 personas dispatched: correctness, testing, maintainability, project-standards, learnings, previous-comments, julik-frontend-races (`ce-agent-native-reviewer` skipped per PEvO conventions). All 9 round-1 hold items VERIFIED-FIXED by the previous-comments reviewer; round-2 hold items below are surfaced by re-review of the round-2 diff itself, not unaddressed prior feedback.

3 items block archive.

### Items to address

**1. (P2) `pages-edit.test.js` integration block missing the "stay-accredited rewrites ORCID" transition test.** The architect's round-1 hold item 3 enumerated 8 cases for each page's integration block. `pages-publish.test.js` covers all 8 (line 563 has the alice→bob stay-accredited transition asserting ORCID rewrites). `pages-edit.test.js` covers 7 of the 8 — it has (a) accredited prefill+lock, (b) non-accredited free input, (item-1) transition-out clearing, (item-9) no-orcid-in-record, (item-2) reapplication preserves typed, (fill-blank) reapplication fills blank, (teardown) bail, (existing-disabled) edit-only asymmetry pin — but no `comp.updateNewCoAuthor(0, 'hive', 'bob')` after an initial `'alice'` to verify the stay-accredited rewrite. Bob is in the directory fixture (line 780) but never used in a transition assertion. Cross-surface parity break: a regression in `applyHiveChangePrefill`'s case-3 logic (stay-accredited rewrites) would be caught by `pages-publish.test.js` but pass silently in `pages-edit.test.js`. (testing, conf 95)

   Fix: add a `'updateNewCoAuthor: stay-accredited hive change rewrites ORCID'` test in `frontend/tests/unit/pages-edit.test.js` mirroring the publish-side test at line 563. ~10 lines.

**2. (P2) `filterAccreditedByPrefix` exported from `frontend/src/lib/accredited-directory.js:57` but has zero consumers.** Grep across all of `frontend/src/` confirms no file imports `filterAccreditedByPrefix`. Both pages drive their `<datalist>` element directly from `Object.values(accreditedDirectory)` in the Alpine template — no JS-side prefix filter is wired or planned. Speculative API surface in a brand-new shared module, contra root CLAUDE.md "Don't add features, refactor, or introduce abstractions beyond what the task requires." (maintainability, conf 75)

   Fix: delete `filterAccreditedByPrefix` from `accredited-directory.js`. If a future custom autocomplete dropdown beyond the native datalist needs prefix filtering, add it then with a real call site.

**3. (P2) `loadAccreditedDirectory` post-rejection retry semantic is undocumented and untested.** `frontend/src/lib/accredited-directory.js:26-43`. The `finally` block unconditionally sets `inFlight = null`; on the rejection path, `cache` is never assigned. Concurrent callers coalesce correctly (item 8 test covers this) — but a caller arriving immediately after the rejection resolves sees `inFlight === null` and `cache === null` and fires a fresh fetch. The module silently implements "always retry after failure." Probably intentional (one-time network blip should not poison the directory permanently), but undocumented and untested. A future maintainer could misread "no cache write on reject" as a bug and "fix" it by assigning `cache = {}` on rejection, converting the silent retry into permanent poisoning until reload. (julik-frontend-races, conf 80)

   Fix: (a) add an inline comment in the catch block documenting that omitting `cache` assignment is intentional (allows retry after transient failure); (b) add one test to `lib-accredited-directory.test.js` that, after the rejection resolves, calls `loadAccreditedDirectory()` again and asserts `fetchAccreditations` was called twice total.

### Items dismissed during architect triage

- **Carve-out header at `frontend/tests/unit/lib-accredited-directory.test.js:20` cites `publish.spec.ts` (wrong extension) + false coverage claim (testing + correctness + project-standards, conf 65-100).** Clause-c IS substantively met (the round-2 work landed `coauthor-accredited-prefill.spec.js` as the real-path companion via the filed follow-up task). The pointer in the comment is wrong, but the convention is satisfied. Accepted as cosmetic.
- **`applyAccreditedPrefill` item-9 test asserts empty-to-empty (testing, conf 90).** Dismissed via design pushback during architect triage: the user clarified the supersession rule (typed-ORCID-valid-for-non-hive co-authors; on-chain accredited ORCID supersedes typed when hive is bound). Hardening test coverage on the empty-to-empty path that is downstream of an unsettled spec is preemptive. The supersession spec is captured in a separate new task at `tasks/pending/architect-orcid-typed-vs-accredited-supersession-spec.md`.
- **Alpine reactivity gap on in-place `applyAccreditedPrefill` mutation (julik-frontend-races, conf 75).** Spawned as a separate investigation task at `tasks/pending/ui-applyaccreditedprefill-reactivity-verify.md` — needs empirical verification (throttle `/api/accreditations`, observe UI) before applying a `.slice()` workaround. Not bundled into this hold round because the right move depends on the investigation outcome.

### Architect signal

After landing items 1-3, `git mv` this file back to `tasks/review/`. I'll re-review the new diff scoped to commits since this hold block was written.

Anchor: items 1, 2, 3 are independent small fixes; they can land in one commit or three. Item 2 (delete dead export) is trivial; item 1 (mirror test) is mechanical; item 3 (comment + test) closes a documentation gap on the new shared lib.

## UI re-review signal (2026-05-16, round-2, commits 4a28f79, b0bc48c)

All 3 round-2 P2 hold items landed across 2 commits.

- Item 1 (P2, stay-accredited hive change rewrites ORCID test for `updateNewCoAuthor`) — `4a28f79`. Added `updateNewCoAuthor: stay-accredited hive change rewrites ORCID to the new accreditation` test in `frontend/tests/unit/pages-edit.test.js`, mirroring the publish-side test at `pages-publish.test.js:563`. Bob was already in the page-integration fixture directory but never asserted in a transition; the new test now exercises the alice→bob (both accredited) path and asserts the prefilled ORCID is rewritten to bob's value.
- Item 2 (P2, delete unused `filterAccreditedByPrefix` export) — `b0bc48c`. Removed the export from `frontend/src/lib/accredited-directory.js`. Grep across `frontend/src/` confirmed zero consumers; the export, its 4 unit tests, and its named import in the test file were introduced speculatively for an autocomplete affordance that did not land in `publish.js` / `edit.js`. Test block and named import removed alongside.
- Item 3 (P2, document + test no-negative-cache retry semantic) — `b0bc48c`. Added an inline comment in the catch block of `loadAccreditedDirectory` (`frontend/src/lib/accredited-directory.js`) documenting that `cache` is intentionally NOT assigned on rejection so a transient failure can recover on the next call. Added a unit test in `lib-accredited-directory.test.js` that mocks `fetchAccreditations` to reject once, asserts the result is `{}` and `fetchAccreditations` was called 1×, then mocks a success on the second call and asserts the result fetches fresh (`fetchAccreditations` called 2× total), pinning the no-negative-caching behavior.

Worker ran the two target unit files: `pages-edit.test.js` 36 tests pass (was 35; +1 stay-accredited test), `lib-accredited-directory.test.js` 25 tests pass (was 28; −4 filter tests, +1 retry-after-failure test). No Playwright run for this task (no E2E scope).

NOT in scope per parent triage (dismissed at architect triage): carve-out header cosmetic typo, item-9 empty-to-empty test, alpine reactivity (separate task at `tasks/pending/ui-applyaccreditedprefill-reactivity-verify.md`).
