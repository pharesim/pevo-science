# E2E spec — co-author ORCID prefill on accredited Hive accounts

**Owner:** UI Agent
**Created:** 2026-05-11 (filed as the carve-out clause-c real-path companion for `frontend/tests/unit/lib-accredited-directory.test.js`)
**Priority:** P3

## Problem

`frontend/tests/unit/lib-accredited-directory.test.js` mocks `fetchAccreditations` to deterministically pin the directory's shape, the concurrent-rejection coalescing semantics, and the malformed-row (missing `orcid`) handling. Per root CLAUDE.md "Carve-out for deterministic edge-case coverage" clause (c), the same risk class must be covered by a real-path test elsewhere.

The risk class the unit file pins: "the integrated `fetchAccreditations → loadAccreditedDirectory → applyHiveChangePrefill → publish/edit form prefill` flow does not silently divorce the on-chain `pevo.authors[].orcid` from the accreditation record". A real-path test must exercise the same flow against the live backend so a mutation in `frontend/src/api.js` `fetchAccreditations`, the `/api/accreditations` route shape, or the page's `_loadAccreditedDirectory` call would be caught by a different mutation class than the unit file already catches.

Today there is no E2E coverage of this flow. `frontend/tests/e2e/publish.spec.*` exercises the publish form but does not seed multiple accredited co-authors or assert the locked-input semantic.

## Acceptance criteria

Add `frontend/tests/e2e/coauthor-accredited-prefill.spec.ts` covering:

1. **Accredited co-author prefill** — Accredited fixture user A opens `/publish`. The user enters a second co-author with hive=`<accredited fixture user B>`. The `orcid` input on that row becomes prefilled to B's ORCID and is `disabled`. The "(accredited)" hint badge renders.

2. **Non-accredited co-author free input** — A enters a third co-author with `hive=<non-accredited-handle>`. The `orcid` input on that row remains editable; the badge does not render.

3. **Accredited→non-accredited transition clears ORCID** (item 1 from the held re-review) — On the same publish session, A changes the second co-author's `hive` from B's accredited handle to a non-accredited handle. The `orcid` input becomes editable and is cleared (does not retain B's ORCID).

4. **Published `authors[]` matches the accredited identity** — A submits. The `comment` op's `json_metadata.pevotest.authors[]` row for B carries `orcid: <B's accredited ORCID>` (verified by reading the broadcast op the keychain mock intercepts).

5. **Edit form follow-up** — Repeat (1) and (3) against `/edit/<paper>/permlink` using the `newCoAuthors` rows. Existing co-authors stay disabled regardless of accreditation state (the publish/edit asymmetry called out in the original task).

Follow the existing E2E pattern (`publish.spec.ts`, `review-submit.spec.ts`): intercept the broadcast at the Hive Keychain / dhive layer; do not hit a real chain. Seed two accredited fixture accounts (A, B) in the E2E fixture set if not already present.

## Cross-references

- `frontend/tests/unit/lib-accredited-directory.test.js` — the mocked unit coverage this task companions per the carve-out clause (c).
- `agents/docs/tasks-archive.md` — UI-AUTHOR-INPUT-ACCREDITED-PREFILL once archived will hold the full hold-block history.
- Root CLAUDE.md "Carve-out for deterministic edge-case coverage" — the convention requiring this companion.

## Architect re-review (2026-05-16) — HELD PENDING FIXES:

`/ce-code-review` ran on commit `42b522e` (the round-1 E2E spec landing). 7 personas dispatched: correctness, testing, maintainability, project-standards, learnings, api-contract, julik-frontend-races (`ce-agent-native-reviewer` skipped per PEvO conventions; security/adversarial not selected — test-only diff with no auth surface).

Round-1 spec successfully exercises all 5 acceptance scenarios with load-bearing assertions. The clause-(c) wiring-axis coverage is real: a regression in `frontend/src/api.js#fetchAccreditations`, in the `/api/accreditations` route shape, or in `_loadAccreditedDirectory` call-site wiring would fail this spec while the unit file at `frontend/tests/unit/lib-accredited-directory.test.js` (which substitutes `fetchAccreditations` at module-resolution time) stayed green. That's exactly the risk-class split per `test-mock-carve-out-clause-c-2026-05-04.md`.

7 items block archive. All are scoped to this spec file or its supporting helpers — none require fixes outside `frontend/tests/`.

### Items to address

**1. (P2) `div.opacity-75` selector for the existing-coauthor row is brittle to fixture diversification.** `frontend/tests/e2e/coauthor-accredited-prefill.spec.js:410` uses `page.locator('div.opacity-75').first()` to target the existing-coauthor row. The same `opacity-75` class is also applied to existing supplementary-file rows at `frontend/src/pages/edit.js:232`. Today the paper fixture has 1 existing co-author and 0 supplementary files, so `.first()` hits the correct element. The moment any fixture adds a supplementary file without a corresponding existing co-author, `.first()` silently retargets to the supplementary-file row, and the disabled-state + value assertions pass against the wrong element. Cross-reviewer convergence (correctness + testing + julik-frontend-races, conf 100).

   Fix: add `data-testid="existing-coauthor-row"` to the existing-author row container in `frontend/src/pages/edit.js:180` and replace the locator with `page.getByTestId('existing-coauthor-row').first()`.

**2. (P2) `orcidInputForRow` XPath helper encodes an undocumented DOM-layout assumption.** The helper at `coauthor-accredited-prefill.spec.js:109` uses `xpath=following-sibling::input[1]` to find the ORCID input relative to the hive input. It works today because the affiliation input is wrapped in a `<div>` (not a direct sibling input). No comment documents this. If the grid is refactored to unwrap the affiliation div, the XPath silently retargets affiliation, and `toHaveValue(B.orcid)` becomes a false-pass when affiliation is empty (or a misleading failure otherwise). Cross-reviewer (testing + julik-frontend-races, conf 100).

   Fix: add `data-testid="coauthor-orcid-input"` to the ORCID inputs in `frontend/src/pages/publish.js:184` and `frontend/src/pages/edit.js:193`, and replace the XPath helper with `page.getByTestId('coauthor-orcid-input').nth(rowIdx)` or equivalent.

**3. (P2) `installPaperMocks` duplicated verbatim from `edit-paper.spec.js` AND the non-obvious LIFO dispatch-order comment is dropped.** `coauthor-accredited-prefill.spec.js:297-327` is a byte-for-byte copy of `frontend/tests/e2e/edit-paper.spec.js:93-136`, minus the 6-line comment at `edit-paper.spec.js:96-102` explaining why specific handlers must register before the bare wildcard (Playwright's LIFO route-dispatch order; otherwise `route.fallback()` in the wildcard runs out of earlier handlers and the spec routes break silently). The inline acknowledgment at line 295 cites a weak rationale ("that file does not export its helpers"); the fix is to make it export them. Cross-reviewer (maintainability + testing + julik-frontend-races, conf 100).

   Fix: extract `installPaperMocks` and the `envelope` helper (both currently duplicated) to a new shared `frontend/tests/e2e/fixtures/paper-mocks.js`. Export both. Import in `edit-paper.spec.js` and `coauthor-accredited-prefill.spec.js`. The dispatch-order comment lives once on the shared helper.

**4. (P2) `waitForAccreditedDirectoryLoaded` has no explicit timeout, hangs 30s on empty directory.** `coauthor-accredited-prefill.spec.js:88-97` calls `page.waitForFunction(...)` without a `{ timeout }` option. Its predicate is `Object.keys(data.accreditedDirectory || {}).length > 0`. In `frontend/src/lib/accredited-directory.js`, the catch in `_loadAccreditedDirectory` returns `{}` (empty map), and the page assigns it unconditionally. So when `/api/accreditations` errors during the test, `accreditedDirectory` is `{}` permanently and the predicate never resolves true. Playwright then runs to its global 30s default and emits `waitForFunction timed out` rather than the much clearer "expected at least two accredited researchers" message from the fixture picker. (julik-frontend-races, conf 80)

   Fix: add `{ timeout: 10_000 }` to the `waitForFunction` call. Optionally wrap with a `.catch()` that re-throws with a clearer "accredited directory never loaded — check /api/accreditations" message.

**5. (P2) `pickTwoAccreditedResearchersWithOrcid` reimplements the 4-attempt retry shell from `fixtures/auth.js#pickAccreditedResearcher`.** `coauthor-accredited-prefill.spec.js:44-76` manually duplicates the `attempts=4`, `500*(attempt+1)` delay loop. The only novel logic is the "pick two with non-empty ORCID" selection predicate; the retry skeleton is forked. A future change to retry parameters requires editing two files in lockstep. (maintainability, conf 85)

   Fix: factor `frontend/tests/e2e/fixtures/auth.js` to expose either `pickAccreditedResearchers({ request, count, predicate })` directly, or `pickAccreditedResearcherOnce(request)` so callers can compose their own retry. The new spec consumes the shared helper.

**6. (P2) `GET /api/accreditations` list response shape never asserted; regression surfaces as ambiguous fixture-setup error.** `coauthor-accredited-prefill.spec.js:50,53` reads `r.orcid` and `r.username` directly from the response. If the backend renames `orcid` (e.g., to `orcid_id` or nests under `accreditation.orcid`), `r.orcid` becomes `undefined`, the `!r.orcid` filter drops every researcher, and the test throws *"expected at least two accredited researchers with non-empty ORCIDs in HAF"*. Operator reads that as a HAF data complaint; the real issue is a contract regression. (api-contract, conf 75)

   Fix: add `expect(list[0]).toHaveProperty('orcid')` and `expect(list[0]).toHaveProperty('username')` immediately after the response unpacks at line 49. A field rename then produces a clear contract-level failure with a usable message.

**7. (P2) Broadcast envelope `json_metadata` serialization form not asserted before `JSON.parse`.** `coauthor-accredited-prefill.spec.js:270-283` calls `JSON.parse(commentOp[1].json_metadata)` without first verifying it's a string. Per Hive's wire format, `json_metadata` must be a JSON-encoded string. If `publish.js` ever passes the metadata object unparsed, `JSON.parse` throws a cryptic `TypeError` rather than a contract-level failure. (api-contract, conf 75, narrowed scope per architect triage — full per-field `authors[i]` shape assertions are not required, the existing `authors.find(a => a.hive === B.username)` already exercises `hive`.)

   Fix: add `expect(typeof commentOp[1].json_metadata).toBe('string')` before the `JSON.parse` call at line 272.

### Items dismissed during architect triage

- **Per-user `accreditation.orcid` endpoint never read (api-contract, conf 75).** The prefill flow goes through the list endpoint; the per-user endpoint at `GET /api/accreditations/:username` is a different surface with its own coverage story. Adding a per-user assertion to this spec would relitigate the settled clause-(c) convention per `test-mock-carve-out-clause-c-2026-05-04.md` — the carve-out is for risk-class equivalence on the path the unit file pinned, not literal-mirror coverage of every accreditation surface.
- **Carve-out header in `frontend/tests/unit/lib-accredited-directory.test.js:20` cites `publish.spec.ts` (wrong extension) + false coverage claim (project-standards / testing / correctness, conf 65-100).** Clause-c IS substantively met (this E2E spec exists and exercises the prefill wiring axis). The pointer in the comment is wrong, but the convention is satisfied. Accepted as cosmetic.
- **`applyAccreditedPrefill` item-9 test asserts empty-to-empty (testing, conf 90).** Dismissed via design pushback: the user clarified the supersession rule (typed-ORCID-valid-for-non-hive co-authors; on-chain accredited ORCID supersedes typed when hive is bound), and the empty-to-empty case is downstream of a spec clarification filed as `architect-orcid-typed-vs-accredited-supersession-spec.md`. Hardening test coverage on a code path slated for spec-driven evolution is preemptive.

### Architect signal

After landing items 1-7, `git mv` this file back to `tasks/review/`. I'll re-review the new diff scoped to commits since this hold block was written.

Anchor: items 1-3 share the same goal (durable selectors + shared fixtures); land them in one commit. Item 5 (retry helper factor) is logically related to items 1-3 (shared E2E fixture surface) and can ride in the same commit. Items 4, 6, 7 are independent small additions to the spec; one commit covers them.

## UI re-review signal (2026-05-16, round-2, commits 80ca559, 3243583)

All 7 P2 hold items landed across the architect's anchored 2 commits.

- Item 1 (P2, durable existing-coauthor-row selector) — `80ca559`. Added `data-testid="existing-coauthor-row"` to the existing-author row container in `frontend/src/pages/edit.js`. Replaced the spec's `page.locator('div.opacity-75').first()` with `page.getByTestId('existing-coauthor-row').first()`. The previous selector silently retargeted the first supplementary-file row (which shares the `opacity-75` class) the moment a fixture added a supplementary file without a corresponding existing co-author.
- Item 2 (P2, durable coauthor-orcid-input selector) — `80ca559`. Added `data-testid="coauthor-orcid-input"` to the ORCID input on the new-co-author row template in `frontend/src/pages/publish.js` and `frontend/src/pages/edit.js`. The testid is on the new-row template only, so `.nth(rowIdx)` continues to address only new co-author rows. Replaced the XPath `following-sibling::input[1]` helper with `page.getByTestId('coauthor-orcid-input').nth(rowIdx)`.
- Item 3 (P2, extract shared installPaperMocks fixture) — `80ca559`. New file `frontend/tests/e2e/fixtures/paper-mocks.js` exports `installPaperMocks` and `envelope`. The LIFO route-dispatch comment lives once on the shared helper. Imported in `frontend/tests/e2e/edit-paper.spec.js` and `frontend/tests/e2e/coauthor-accredited-prefill.spec.js`; the duplicated local copies were removed from both specs.
- Item 5 (P2, factor pickAccreditedResearchers retry shell) — `80ca559`. Refactored `frontend/tests/e2e/fixtures/auth.js` to expose `pickAccreditedResearchers({ count, predicate, limit, attempts })` plus `pickAccreditedResearchersOnce()`. The single-pick `pickAccreditedResearcher(request)` was preserved as a backwards-compatible wrapper. The spec's hand-rolled 4-attempt retry collapsed to a one-line call into the shared helper with a non-empty-ORCID predicate.
- Item 4 (P2, bounded waitForAccreditedDirectoryLoaded) — `3243583`. Added `{ timeout: 10_000 }` to the `waitForFunction` call. Wrapped with try/catch that re-throws "accredited directory never loaded. Check /api/accreditations for HAF availability and response shape." Message uses periods (no emdashes) per project CLAUDE.md.
- Item 6 (P2, contract assertion on /api/accreditations list shape) — `3243583`. Added `assertAccreditationsListContract(request)` helper invoked at the start of each test (and ahead of the picker), asserting `list[0]` has both `username` and `orcid` properties via `toHaveProperty`. A field rename surfaces as a contract-level failure with a usable message rather than the misleading "no accredited researchers with non-empty ORCIDs" message.
- Item 7 (P2, assert json_metadata is a string before JSON.parse) — `3243583`. Added `expect(typeof commentOp[1].json_metadata).toBe('string')` immediately before the `JSON.parse(commentOp[1].json_metadata)` call. Surfaces a publish-side regression that passes the metadata object unparsed as a contract-level failure rather than a cryptic `TypeError`.

New file: `frontend/tests/e2e/fixtures/paper-mocks.js` (shared installPaperMocks + envelope helpers).

Test status: Playwright deferred to parent agent per UI agent CLAUDE.md (E2E specs share the dev backend port; concurrent runs collide).

NOT in scope (dismissed at architect triage): per-user `accreditation/:username` endpoint coverage, carve-out header cosmetic typo, item-9 empty-to-empty test.
