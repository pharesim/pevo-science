# UI-PAPER-DETAIL-ORCID-DISCREPANCY-INDICATOR — render the typed-vs-verified ORCID discrepancy on paper-detail and paper-list views

**Owner:** UI Agent
**Created:** 2026-05-16
**Priority:** P2
**Blocked on:** `backend-papers-canonical-orcid-resolution` (the backend must emit `orcid_verified` and `orcid_discrepancy` before the UI can render them).

## Problem

PEvO's paper-detail and paper-list views currently render `authors[i].orcid` as-is from the chain. After the backend ORCID-supersession landing, each `authors[i]` row will also carry `orcid_verified` (the accreditation-attested ORCID, or null) and `orcid_discrepancy` (true when both values are present and differ).

The frontend needs to:
1. Default to displaying the canonical ORCID (`orcid_verified` when non-null, else fall back to chain `orcid`).
2. When `orcid_discrepancy` is true, show a discrepancy indicator so readers can see both values.

This is purely a display-layer change; the chain post is immutable.

## Acceptance

1. **Canonical display.** Wherever the frontend renders `authors[i].orcid` (paper-detail view, paper-list cards, author byline, citation export hooks if they show ORCID), the display value is `orcid_verified ?? orcid`. Add a small helper (e.g., `frontend/src/lib/authors.js:canonicalOrcid(author)`) so the rule is encoded in one place.

2. **Discrepancy indicator.** When `orcid_discrepancy === true`, render a small visual affordance next to the displayed ORCID that exposes both values on hover/click. Suggested shapes (UI agent picks the one that fits the existing style; this list is illustrative, not prescriptive):
   - A small "info" icon (e.g., `ⓘ`) with a tooltip: "Claimed: 0000-0001-XXX • Verified: 0000-0002-YYY (via PEvO accreditation)".
   - A two-line stack: "ORCID 0000-0002-YYY" on the primary line, "(publisher claimed 0000-0001-XXX)" in a muted secondary line.
   - An audit-log style "Claimed ↔ Verified" inline disclosure.

3. **Empty / non-accredited cases.** When `orcid_verified` is null, just render `orcid` as today (no indicator). When both `orcid` and `orcid_verified` are present and equal, no indicator (the supersession is a no-op there).

4. **Paper-list cards.** The list view (`/api/papers`) returns the same `orcid_verified` / `orcid_discrepancy` fields per author. Apply the canonical-display rule on list cards too; the discrepancy indicator may be condensed on list cards (less screen real estate) but the canonical display value MUST be used.

5. **E2E coverage.** Add a Playwright fixture / test case that:
   - Publishes (or mocks) a paper with `authors[0] = { hive: 'alice', orcid: 'X' }` where alice's accreditation has `orcid: 'Y'`.
   - Asserts the paper-detail view renders `Y` as the primary ORCID and exposes the discrepancy indicator.
   - Asserts an undiscrepant case (matching orcids) shows no indicator.

6. **Accessibility.** The indicator MUST be screen-reader friendly. A `title=` attribute on the icon, an `aria-label`, or a visually-hidden text alternative is required. Keyboard users must be able to reach the disclosure via Tab.

## Implementation notes

- Helper placement: `frontend/src/lib/authors.js` or wherever `authors[]` is already rendered. Encode the canonical-display rule once and import everywhere.
- Suggested helper signature:
  ```js
  // Returns the canonical display ORCID for an author row, or null if neither is set.
  export function canonicalOrcid(author) {
    if (!author) return null;
    if (author.orcid_verified) return author.orcid_verified;
    return author.orcid || null;
  }
  ```
- The discrepancy indicator should NOT block the paper-detail render if the field is missing or stale (older backend response: gracefully fall back to chain `orcid`, no indicator).
- The publish/edit form is already correct (per the spec § 2: ORCID input editable when hive is empty or non-accredited, disabled+prefilled when hive is accredited). This task does NOT change the publish/edit form.

## Out of scope

- Backend-side computation of `orcid_verified` / `orcid_discrepancy` (see `backend-papers-canonical-orcid-resolution`).
- Reputation algorithm changes.
- Changing the chain-write path for ORCID values on publish (the chain receives whatever the publisher broadcast; immutable forever).
- Backfilling or rewriting historical papers.

## Cross-references

- `agents/docs/hive-schemas.md` § 1.1 — supersession rule.
- `agents/docs/api-contracts/papers.md` — PaperSummary / PaperDetail field documentation including `orcid_verified` and `orcid_discrepancy`.
- `frontend/src/lib/accredited-directory.js` — existing prefill helpers (`applyHiveChangePrefill`, `applyAccreditedPrefill`); the publish/edit form-time behavior matches spec § 2.
- Parent spec: archived as `architect-orcid-typed-vs-accredited-supersession-spec` on 2026-05-16 in `agents/docs/tasks-archive.md`.
