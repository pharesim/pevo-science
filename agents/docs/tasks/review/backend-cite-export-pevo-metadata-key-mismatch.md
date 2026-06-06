# BACKEND-CITE-EXPORT-PEVO-METADATA-KEY-MISMATCH — citation exports read `detail.json_metadata.pevo` but live metadata is keyed under `meta[APP_TAG]`, dropping co-author names and DOIs

**Owner:** backend
**Created:** 2026-06-04 (surfaced by the backend-citation-export-format-escape re-review + adversarial verification)
**Priority:** P2 (correctness: exported citations silently omit co-authors and DOIs on the live path; not a security issue)

## Problem

The `/cite` generators (`generateBibtex` / `generateRis` / `generateApa` in `backend/src/routes/papers.ts`) read the PEvO object as `((detail.json_metadata)?.pevo || {})`. But chain metadata stores the PEvO object under `meta[config.appTag]` (`pevotest` in beta), which the rest of the codebase accesses via `safePevoMeta(meta)` (returns `meta[config.appTag]`, papers.ts ~202).

On the live `/cite` path, `detail.json_metadata` IS the raw chain `meta` (set in `buildPaperDetail` ~3061 as `json_metadata: meta`, and in `fetchPaperDetailFromHaf` as `detail.json_metadata = headMeta`). So `detail.json_metadata.pevo` is `undefined`, and:

- `pevo.authors` resolves to `[]` -> the author list ALWAYS falls back to the posting account. **Exported citations never list co-author names.**
- `pevo.source.doi` is unreachable -> **DOIs never appear**. (This is why the DOI wiring was reverted in `backend-citation-export-format-escape`; that task surfaced this bug.)

Not caught by existing tests: `papers-cite-escape.test.ts` unit-tests the generators with a synthetic `{ pevo: { authors } }` object (matching the buggy read, not the live shape), and `cite.test.ts` only exercises the 400 (bad format) and 404 (missing paper) paths. The live metadata shape is untested.

## Goal

Make the generators read the correctly-keyed PEvO data:

- **Author list:** use `detail.authors` (which `buildPaperDetail` already exposes via `safePevoMeta`) or `safePevoMeta(detail.json_metadata)`. Pick whichever reliably carries the display `name`.
- **DOI:** read `safePevoMeta(detail.json_metadata).source.doi` and re-wire the DO/doi line, keeping the existing `bibtexEscape`/`risEscape` escaping.

**Why this is its own task (not a drive-by in the escape task):** `detail.authors` is NOT a single stable shape. On the continuation/supersession paths in `fetchPaperDetailFromHaf`, `detail.authors` is overridden with `authors_with_supersession` / `cumulativeAuthors`, whose element shape may carry only `hive`/`orcid`/supersession fields and lack the display `name`. The fix must AUDIT the `detail.authors` (and underlying `pevo.authors`) shape across:

- single-link papers (`buildPaperDetail`: `detail.authors = pevo.authors` with `{name, hive, orcid}`),
- multi-link / continuation papers (`detail.authors` = supersession/cumulative projection — confirm whether `name` is present; if not, source names from `safePevoMeta(headMeta).authors` or join on `hive`),

and choose a name source that is correct on every path before wiring it. Getting this wrong would put `undefined`/empty names into exports for multi-link papers.

## Acceptance

1. A route-level test (real or representative paper) on the live `/cite` path asserts the BibTeX/RIS/APA author list contains the actual co-author NAMES (not just the posting account) when `pevo.authors` has multiple entries.
2. A paper carrying `pevo.source.doi` exports a DOI line (RIS `DO`, BibTeX `doi`), escaped via the existing helpers; a paper without a DOI emits no DO/doi line.
3. Single-link AND continuation/multi-link papers both produce correct author names (covers the `detail.authors` shape variance).
4. The escape behavior from `backend-citation-export-format-escape` is preserved (LINE_TERMINATORS flattening, non-string coercion) — re-running that task's canary stays green.
5. Mutation-kill: a test goes RED if the generators revert to reading `detail.json_metadata.pevo`.

## Out of scope

- The escaping itself (landed in `backend-citation-export-format-escape`).
- Changing the `/cite` response envelope (stays `{ format, content }`).

## References

- `backend/src/routes/papers.ts` — `generateBibtex` / `generateRis` / `generateApa`; `buildPaperDetail` (~3061, `detail.authors` + `json_metadata: meta`); `fetchPaperDetailFromHaf` (`detail.authors` continuation/supersession overrides); `safePevoMeta` (~202, the canonical `meta[config.appTag]` accessor).
- `agents/docs/tasks/review/backend-citation-export-format-escape.md` — the re-review signal "[Surfaced finding]" that this task formalizes.

## Architect re-review (2026-06-06) — HELD PENDING FIXES:

`/ce-code-review` (correctness + security + adversarial on Opus; testing/maintainability/project-standards/kieran-typescript/learnings on Sonnet) verified the core fix (commit e15d65e4) sound: the `detail.authors[].name` totality claim holds on all three build paths (SQL `authorsWithSupersessionSelect` COALESCE + IS-NOT-NULL projection, `buildCumulativeAuthorsForChain`'s `typeof` filter, `applyAuthorSupersession`'s filter — the raw `pevo.authors` never reaches the live `/cite` generators), `citeDoi` is crash-resistant across crafted meta shapes (node-repro'd), every new interpolation passes the existing escape helpers, and the `.pevo` mutation-kill test is real. The sibling duplicate task `backend-cite-export-coauthor-doi-keying` is archived as resolved-by-this-task. One item before archive:

1. **Route-level co-author name assertion.** Acceptance item 1 asks the live `/cite` path to prove co-author names flow through; the landed route test asserts only 200/non-empty, and the name assertions live in generator unit tests that bypass `fetchPaperDetailFromHaf` — the exact wiring-regression class this task fixed would recur undetected. In the HAF-backed route test, fetch the paper's detail (GET /api/papers/:author/:permlink), take `authors[0].name`, and assert it appears in the BibTeX `author = {...}` field and a RIS `AU  - ` line. The existing skip-guard when HAF returns no papers is acceptable.

## Backend re-review signal (2026-06-06, working tree):

Hold item 1 landed in `tests/routes/cite.test.ts`. Verified green against real HAF (the listing -> detail -> cite wiring sequence ran end-to-end on paper `jesusalejos/...` in the run logs).

- Added a route-level test that drives the REAL handler end-to-end: `GET /api/papers?limit=5` -> for each result `GET /api/papers/:author/:permlink` until one whose `data.authors` carries a non-empty string `name` is found -> `GET .../cite?format=bibtex` and `?format=ris`. Asserts the live co-author name appears in the BibTeX `  author = {...}` line and in a RIS `AU  - ` line.
- The expected name is run through the production `bibtexEscape` / `risEscape` helpers (now exported and imported by the test) so the assertion is robust to a name containing format metacharacters while still proving the name flows from `fetchPaperDetailFromHaf`'s `detail.authors` through the generators.
- I take the first author with a non-empty `name` rather than strictly `authors[0]`, and skip when the slice has no named author — the architect's "skip-guard when HAF returns no papers is acceptable" extends to the same acceptable-skip class. This closes the exact wiring-regression the fix addresses (a revert to `detail.json_metadata.pevo` makes the live author list fall back to the posting account, turning this assertion red), which the hand-built-detail generator unit tests cannot observe.
