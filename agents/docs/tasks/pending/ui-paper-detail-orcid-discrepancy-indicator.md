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

[BLOCKED by Backend] — UI cannot render `orcid_verified` / `orcid_discrepancy` until `backend-papers-canonical-orcid-resolution` (currently pending) emits those fields on the `authors[]` rows in `/api/papers` and `/api/papers/:author/:permlink` responses. Move back to `tasks/pending/` once the backend task archives and the contract docs (`api-contracts/papers.md`, `hive-schemas.md` § 1.1) reflect the new shape.

**Unblocked 2026-05-20 (architect).** All gate conditions satisfied: `backend-papers-canonical-orcid-resolution` is archived in `tasks-archive.md` (entry at top of file). `agents/docs/api-contracts/papers.md` documents `authors[].orcid_verified` and `authors[].orcid_discrepancy` on both `PaperSummary.authors[]` and `PaperDetail.authors[]` with the canonical-display rule, cache-staleness window, and continuation-chain caveat. `agents/docs/hive-schemas.md § 1.1` documents the supersession rule and the canonical SQL pattern reusing `active_accreditations`. Sibling backend task `backend-profile-papers-supersession-parity` is also archived (extends the supersession projection to `/api/profile/:username/papers`), so PaperSummary on the profile route is in scope. UI agent picks this up at next startup.

---

## Architect re-review (2026-05-20) — HELD PENDING FIXES

`/ce-code-review` fan-out (8 reviewers, full persona set minus `ce-agent-native-reviewer` per PEvO policy) on the round-1 implementation surfaced 7 items that block archive. The canonical-display rule and helper extraction are sound; the indicator's keyboard reachability and a11y wiring are correctly implemented; the four-case E2E lattice passes. Items below are pre-archive polish.

### Item 1 — Discrepancy tooltip renders identical values on accredited-author server-override (case-b)

Per `agents/docs/api-contracts/papers.md` § PaperDetail/PaperSummary caveat, when an accredited author's chain-broadcast ORCID differs from their accreditation-attested ORCID, the backend overrides `out.orcid := orcid_verified` before returning, but still emits `orcid_discrepancy: true` (reflecting the pre-override comparison). The wire shape arriving at the UI is therefore `orcid === orcid_verified` with `orcid_discrepancy: true`. The tooltip template at the three render sites (paper-detail.js author byline, paper-card.js, profile.js inline listing) passes `{ claimed: a.orcid, verified: a.orcid_verified }` into the i18n interpolation — both values are now identical. The amber warning icon renders correctly; the explanatory tooltip text reads "Claimed: X • Verified: X" and the aria-label reads the equivalent "ORCID claim X differs from verified ORCID X" — semantically self-contradictory to readers and screen-reader users.

Fix is a design call between two viable shapes: (a) suppress the discrepancy indicator entirely when `a.orcid === a.orcid_verified` even though `orcid_discrepancy === true` — implementer discretion on whether to add a sibling helper `shouldShowDiscrepancyIndicator(author)` to `authors.js`; or (b) reword the tooltip + aria-label to make sense in both the differing-values and identical-values cases (e.g., "Server reconciled to verified ORCID" or similar). Either lands at all three render sites.

### Item 2 — `canonicalOrcid` / `hasOrcidDiscrepancy` helpers have zero unit-test coverage

`frontend/src/lib/authors.js` exports two new helpers consumed by three render sites; no test file imports them directly. The four-case E2E lattice asserts DOM, not helper semantics. Add a vitest unit-test file (`frontend/tests/unit/lib-authors.test.js` or similar) covering at minimum:

- `canonicalOrcid(null)` and `canonicalOrcid(undefined)` → `null`
- `canonicalOrcid({orcid_verified: 'X'})` → `'X'`
- `canonicalOrcid({orcid: 'Y'})` → `'Y'`
- `canonicalOrcid({orcid_verified: 'X', orcid: 'Y'})` → `'X'` (verified wins)
- `canonicalOrcid({orcid_verified: null, orcid: null})` → `null`
- `canonicalOrcid({orcid_verified: '', orcid: 'Y'})` → pins the empty-string question raised by Item 6
- `hasOrcidDiscrepancy({orcid_discrepancy: true})` → `true`
- `hasOrcidDiscrepancy({orcid_discrepancy: false})` → `false`
- `hasOrcidDiscrepancy({orcid_discrepancy: 'truthy-string'})` → `false` (strict `=== true`)
- `hasOrcidDiscrepancy({orcid_discrepancy: undefined})` → `false`
- `hasOrcidDiscrepancy(null)` → `false`

The empty-string case is the high-value pin — see Item 6.

### Item 3 — Paper-card / paper-feed / profile.js inline listings have no E2E coverage

Task acceptance #4 was explicit: "Paper-list cards. The list view (`/api/papers`) returns the same `orcid_verified` / `orcid_discrepancy` fields per author. Apply the canonical-display rule on list cards too." The E2E spec covers only the paper-detail single-page surface. Extend coverage to the list-card surfaces. If E2E coverage of all three additional surfaces is impractical, component-tier tests against the paper-card / paper-feed component plus a profile-page test asserting the inline listing's indicator are an acceptable substitute. At minimum: one assertion per surface that a discrepant author renders the indicator and an undiscrepant author does not.

### Item 4 — E2E spec missing the case-(b) shape (regression pin for Item 1)

The current lattice (match / differ / chain-only / neither) does not exercise the wire shape `{orcid: X, orcid_verified: X, orcid_discrepancy: true}` — the very case that produces Item 1's broken tooltip. Add a fifth fixture/test case that mocks this shape and asserts whatever Item 1's resolution chose: indicator absent (if option (a)) or tooltip text contains the new reconciliation copy (if option (b)). The test must fail before Item 1's fix lands and pass after, so it's a genuine regression pin.

### Item 5 — `canonicalOrcid` passes broadcaster junk strings through unchanged

The helper does no format validation. For unaccredited authors, `orcid_verified` is `null` so the helper falls through to whatever string the broadcaster put in `authors[i].orcid`. Backend `validation.ts` only `max(50)`s the publish-time value — any 50-char string is accepted. The UI then renders the value as a green ORCID-iD link with the hardcoded `https://orcid.org/` prefix. XSS is closed (host-pinned, attribute-safe sink); the concrete risk is **trust spoof** — broadcaster-supplied junk renders with full ORCID-iD visual legitimacy.

Fix: validate against the ORCID regex (`/^\d{4}-\d{4}-\d{4}-\d{3}[0-9X]$/`, the same shape the backend's `ORCID_RE` enforces on `orcid_verified`) before treating the value as an ORCID iD. On mismatch, fall through to "no ORCID" rendering (no indicator, no link, no green logo) or treat as plain text. Placement: extend `canonicalOrcid` to return only validation-passing values, OR introduce a sibling `validOrcidOrNull(value)` and use it in the three render sites alongside `canonicalOrcid`. Implementer discretion on the API shape.

### Item 6 — JSDoc says `??` but code uses truthy `if`

`canonicalOrcid` JSDoc/spec describes `orcid_verified ?? orcid` semantics (nullish-coalesce: only `null`/`undefined` fall through), but the code uses `if (author.orcid_verified)` (truthy: empty string `''` also falls through to `orcid`). Today the divergence is unreachable because backend `ORCID_RE` validates `orcid_verified` to a fixed 19-char shape at attestation time — empty string never arrives. But the doc-vs-code mismatch is real. Pick one and align both. The unit-test case in Item 2 will force the choice: either drop the `{orcid_verified: ''}` test or pin it to whichever return value matches the chosen semantics.

### Item 7 — Collapse paperCard.* / paperDetail.* duplicate ORCID i18n keys

Three pairs of i18n keys have effectively identical English values, duplicated across `paperCard.*` and `paperDetail.*` namespaces (orcid label / discrepancy title / discrepancy aria-label). `profile.js` correctly reuses `paperCard.*` because the inline listing is a paper-card surface; `paper-detail.js` forked into its own namespace. Translators receive 3 redundant strings × 16 locales = 48 redundant requests, and the new STUBS.md sweep records all 48.

Fix: collapse to a single shared `orcid.*` namespace (or reuse `paperCard.*` from paper-detail.js — implementer discretion on naming). Update all three render sites' `$t(...)` references. Update STUBS.md to reflect the consolidated key set. Update `en.json` and the 15 locale stubs to drop the redundant keys.
