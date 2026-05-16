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
