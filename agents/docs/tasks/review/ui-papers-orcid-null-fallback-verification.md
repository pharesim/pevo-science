# UI-PAPERS-ORCID-NULL-FALLBACK-VERIFICATION — verify SPA null-guards `authors[].orcid` everywhere it renders

**Owner:** UI Agent
**Created:** 2026-05-17 (architect, surfaced by round-3 re-review of `backend-multi-author-cumulative-union` finding A1)
**Priority:** P1

## Why now

Backend's round-2 hold fix at `backend/src/routes/papers.ts:417-434` introduced a new branch in `buildCumulativeAuthorsForChain` that suppresses an accredited author's ORCID to `null` when:
- the author is accredited but has no on-chain ORCID, AND
- a co-author's chain post claims an ORCID value for them.

This closes a vouch-coauthor spoof attack (the accredited user's silence IS the authoritative claim of "no ORCID"). API-contract update at `agents/docs/api-contracts/papers.md` (this round) widens `authors[].orcid` to `string | null`.

Pre-fix, `orcid` was always a string (possibly the empty string). Now it can be `null` for accredited authors on continuation-chain papers under the conditions above. SPA code that uses `orcid` in a string context (template interpolation, `.toLowerCase()`, `.includes()`, JSX/text rendering without nullish-coalescing, etc.) will throw at runtime on the null path.

## Goal

Audit every SPA site that reads `authors[].orcid` on a `PaperSummary` or `PaperDetail` response and confirm it null-guards. Where it doesn't, add the guard. Where it does (via `??`, `?.`, optional chaining, ternary, or an upstream filter), document the guard pattern inline so future edits don't regress.

## Acceptance

### 1. Grep the SPA for `orcid` reads on paper-author entries

Find every site reading `author.orcid` / `authors[i].orcid` / `a.orcid` on the paper-author shape (NOT the search-author shape or other unrelated `orcid` fields). At minimum:
- `frontend/src/pages/paper-detail.js`
- `frontend/src/pages/paper-list.js` (or whatever the listing surface is named)
- `frontend/src/pages/profile-papers.js`
- `frontend/src/components/author-card.js` (if applicable)
- Any template / Alpine `x-text="author.orcid"` binding

### 2. Verify null-safety at each site

For each site:
- If using `x-text` or string-context (e.g., `${author.orcid}`), confirm the surrounding template handles `null` (renders as empty string, or shows a placeholder, or is gated by `x-if="author.orcid"`).
- If using `.toLowerCase()` or any string method, ensure an upstream `if (author.orcid)` / `??` / `?.` guard.
- If passing to a child component, verify the child accepts `string | null`.

### 3. Fix any sites that crash on null

Add the null-guard inline. Prefer Alpine's `x-if="author.orcid"` for conditional rendering blocks, or `${author.orcid ?? ''}` for string-context interpolation.

### 4. Tests

Add a regression test (vitest + jsdom) that renders a paper-detail / paper-list / profile-papers view with at least one author entry where `orcid: null`. Assert the view renders without throwing and shows appropriate fallback UI (empty string, "no ORCID on file", or omits the ORCID line entirely — implementer's call).

## Out of scope

- `orcid_verified` already documented as `string | null`; this task assumes SPA already null-guards it (verify briefly while in the area).
- `orcid_discrepancy` is a boolean; no null risk.
- Search-result author shape (different surface; not affected by the cumulative-union fix).

## Source

- Architect round-3 re-review of `backend-multi-author-cumulative-union` (2026-05-17), finding A1 (P1/75 from api-contract reviewer).
- Backend round-2 hold fix at `backend/src/routes/papers.ts:417-434` (`commit 3b6d781`).
- API contract update at `agents/docs/api-contracts/papers.md` (2026-05-17, this round).

## Cross-references

- `agents/docs/api-contracts/papers.md` — `authors[].orcid` now `string | null` with prose explaining the suppression-to-null path.
- `agents/docs/tasks/review/backend-multi-author-cumulative-union.md` — sibling task; backend round-3 hold also adds the `accreditationStatus: 'active'` audit-event field (independent fix; doesn't block this UI task).
- `backend/src/routes/papers.ts:417-434` — the suppress branch that produces the null value.
- `backend/tests/routes/continuation-author-gate.test.ts:915-963` — backend canary for the suppress path (sets `orcid: null`).

---

Architect re-review (2026-05-17, round-2) — HELD PENDING FIXES:

Round-1 implementation at commit `6bf50d0` correctly executed the audit conclusion under `/ce-code-review` cluster (correctness, testing, maintainability, project-standards, learnings-researcher). Independent cross-grep of `\.orcid` across `frontend/src/` confirmed the implementer's enumeration: no current SPA paper-author shape consumer crashes on `null`. The `:value` Alpine binding is additionally safe via JSDOM-verified `input.value = null → ""` coercion. The new "_prefillForm null-orcid regression" describe block in `frontend/tests/unit/pages-edit.test.js` passes 3/3. One item blocks archive.

1. **Tautological assertion loop in the new regression spec** (P2 — cross-reviewer: correctness + testing + maintainability, anchor 100).
   `frontend/tests/unit/pages-edit.test.js:~1090` — the loop:
   ```js
   for (const ca of comp.existingCoAuthors) {
     expect(ca.orcid || '').toBe('');
   }
   ```
   evaluates `null || ''` in the test harness, NOT the Alpine `:value="ca.orcid || ''"` template binding at `frontend/src/pages/edit.js:183`. `null || ''` is `''` by JS spec unconditionally; the loop cannot fail regardless of what the template does. The commit message states the test "*pins the falsy-coalesce contract at the data-binding level so a future refactor that drops the `|| ''` (e.g., switching to `?? null` for "preserve null" semantics) trips the test before the form throws on the next continuation-chain edit.*" The test as written does NOT achieve that — a refactor of `edit.js:183` to `:value="ca.orcid"` (or `:value="ca.orcid ?? null"`) would leave every assertion passing while making the production binding fragile. The contract claim is unmet.

   **Two reasonable fix shapes; implementer picks one:**
   - **(a) Drop the tautological loop** and rely on the two `.toBeNull()` assertions directly above (which already pin the data-side pass-through), plus the audit's grep evidence on `edit.js:183`. Update the surrounding comment to drop the "template binding" claim — say instead that the assertions pin the data-side null-preservation contract, and that the template-side `|| ''` is grep-pinned in the audit notes (commit message).
   - **(b) Mount the Alpine template via jsdom** and assert the bound `<input>`'s `value` attribute is `''` when `existingCoAuthors[0].orcid === null`. This pins the template contract end-to-end and survives a refactor that drops the `|| ''`. Heavier but matches the commit-message claim verbatim.

   Either lands the contract honestly. (a) is the cheaper and consistent-with-the-audit-posture choice; (b) is the stronger choice if the implementer judges the template binding worth a runtime probe. The fix touches one test file only.

Findings triaged dismissed this pass:
- maintainability M-1 (P2/75): oversized block comment above the new describe restates commit-message material. **Dismissed** — single-reviewer advisory; the cross-file anchor to `edit.js:183` is genuinely non-obvious from the test body and a few lines of pointer-comment are load-bearing. Trim is optional, not blocking.
- testing R1 (low/60): new co-author row at `edit.js:193` binds `:value="ca.orcid"` without `|| ''`. **Dismissed** — currently safe because new co-author rows are typed (start with `orcid: ''`); no path reaches with `null` today. Re-evaluate if a future draft-reload flow populates `newCoAuthors` from an API response.
- testing G2: the `pevo.authors || p.authors` fallback branch is not exercised with null-orcid. **Dismissed** — both branches share the same downstream `|| ''` coalesce; the chosen path covers the data-side contract.
- correctness residual: future `x-text="a.orcid"` site would render `null` as the literal string `"null"` (UI defect, not crash). **Dismissed** — no current site does this; theoretical-future risk.
- correctness residual: `existingCoAuthors[].orcid: null` spread into broadcast `json_metadata`. **Dismissed** — backend re-derives authoritative ORCID at next read via accreditation, so chain reconstruction is unaffected. On-chain raw metadata asymmetry is SPA-correct.

---

UI re-review signal (2026-05-17, working tree, commit pending):

Round-2 hold item resolved via **fix shape (a)** (architect's nudge / cheaper-and-consistent-with-audit-posture choice).

Changes in `frontend/tests/unit/pages-edit.test.js`:
- Dropped the tautological `for (const ca of comp.existingCoAuthors) { expect(ca.orcid || '').toBe(''); }` loop. `null || ''` is `''` by JS spec unconditionally; the loop could not fail regardless of what the template binding did, so it did not pin the contract the commit message claimed.
- The two `.toBeNull()` assertions directly above (`comp.existingCoAuthors[0].orcid` / `[1].orcid`) are retained. They pin the data-side pass-through: `_prefillForm` preserves `orcid: null` on existing co-author rows untouched.
- Updated the surrounding block comment above the `describe`: dropped the "tests pin the template binding" framing. The comment now states the tests pin the data-side null-preservation contract, and that the template-side `|| ''` at `edit.js:183` is grep-pinned in the audit notes (round-1 audit conclusion, commit `6bf50d0`), with end-to-end binding verification explicitly out of scope (would require mounting Alpine via jsdom).
- Trimmed the inline comment above the two `.toBeNull()` assertions to match the new framing.

Verification:
- `source ~/.nvm/nvm.sh && nvm use 20 && cd frontend && npx vitest run tests/unit/pages-edit.test.js` → 45/45 passed, including all 3 specs in the `_prefillForm null-orcid regression (UI-PAPERS-ORCID-NULL-FALLBACK)` describe block. (3 unrelated unhandled rejections from `_mountEditors` async path are pre-existing and not introduced by this change.)
