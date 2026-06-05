# BACKEND-CITE-EXPORT-COAUTHOR-DOI-KEYING — cite-export reads `detail.json_metadata.pevo`, undefined on the live path, so exports never list co-authors or DOI

**Owner:** backend
**Created:** 2026-06-05 (surfaced by backend during `backend-citation-export-format-escape`, confirmed by architect review)
**Priority:** P2 (silent wrong output on the live `/cite` path; not a crash)

## Problem

The citation generators (`generateBibtex` / `generateRis` / `generateApa`) read the PEvO object via `detail.json_metadata.pevo` (e.g. `pevo.authors`, `pevo.source.doi`). But live chain metadata stores the PEvO object under `meta[config.appTag]` (`pevotest`), accessed elsewhere via `safePevoMeta`. On the live `/cite` path `detail.json_metadata.pevo` is therefore `undefined`, so:

- the **author list always falls back to the posting account** and never lists co-author names, and
- the **DOI is never emitted** (the `pevo.source.doi` wiring was reverted as ineffective for exactly this reason).

`buildPaperDetail` already exposes the correctly-keyed `detail.authors` (resolved via `safePevoMeta`), so the data exists; the generators just read the wrong key.

## Goal

Make the citation generators read the correctly-keyed, supersession-resolved author list and DOI, so exported citations list the real co-authors and carry the DOI.

### Suggested approach

- Author list: read `detail.authors` (the resolved field `buildPaperDetail` exposes) rather than `detail.json_metadata.pevo.authors`. **Caveat:** `detail.authors` shape varies across the continuation / supersession paths (it is overridden with `authors_with_supersession` / `cumulativeAuthors`), so the generators must consume whichever shape is canonical there — verify against the paper-detail construction, do not assume the head-metadata shape.
- DOI: read `safePevoMeta(detail.json_metadata).source.doi` (the appTag-keyed path), not `detail.doi`.
- Coordinate with the held `backend-co-author-claim-zero-score` list-final decision: exported authorship should reflect the same canonical author set the rest of the app shows.

## Acceptance

- A live-path test (real `/cite`, not a hand-built `detail.json_metadata.pevo`) asserts a multi-author paper's export lists all co-authors, and a paper with a DOI emits it in BibTeX/RIS.
- Existing escape behavior is preserved (the new field reads still pass through `bibtexEscape`/`risEscape`/`singleLine`).
- `cite.test.ts` extended beyond the 400/404 paths it covers today.
- Comment anchors on stable symbols. `npm run typecheck` + `npm run lint` clean.

## Notes

- NOT introduced by the escaping task; pre-existing keying bug surfaced during it. The escaping task correctly reverted an ineffective `pevo.source.doi` wiring and surfaced this for separate triage.

## Cross-references

- `backend/src/routes/papers.ts` — `generateBibtex`/`generateRis`/`generateApa`, `buildPaperDetail` (`detail.authors`), `safePevoMeta`.

## Backend signal (2026-06-05) — already resolved by sibling task

This task is a DUPLICATE of `backend-cite-export-pevo-metadata-key-mismatch` (landed this session, now in `review/`), which describes and fixes the same keying bug. The fix is already on `main`:

- `backend/src/routes/papers.ts` now reads the author list via a `citeAuthorNames(detail)` helper off `detail.authors` (with a docblock explaining `detail.json_metadata.pevo` is never populated because chain metadata keys the PEvO object under `meta[config.appTag]` via `safePevoMeta`), and the DOI via `citeDoi(detail)` reading `safePevoMeta(detail.json_metadata).source.doi`. `generateBibtex` / `generateRis` / `generateApa` use both. The previous escaping (`bibtexEscape` / `risEscape` / `singleLine`) is preserved.
- The continuation/supersession caveat is handled: `detail.authors[].name` is total on both the single-link path (`{name,hive,orcid}`) and the continuation path (`cumulativeAuthors` / `authors_with_supersession`).
- Live-path coverage added in `cite.test.ts` (co-author names + DOI line appear) and `papers-cite-escape.test.ts` (real detail shape + a mutation-kill test that goes red if a generator reverts to reading `detail.json_metadata.pevo`).

No further backend code change is needed. Moving to `review/` so the architect can dedupe / archive this against `backend-cite-export-pevo-metadata-key-mismatch`. (If the architect wants the `co-author-claim-zero-score` list-final coordination tracked separately, that is a distinct task; the keying bug this file describes is closed.)
