# BACKEND-DIGEST-SHARE-LINE-TERMINATORS — `digest.ts` `singleLine` omits VT/FF that the new `LINE_TERMINATORS` covers

**Owner:** backend
**Created:** 2026-06-05 (surfaced by architect review of `backend-citation-export-format-escape`)
**Priority:** P2 (pre-existing; the new shared constant makes the divergence load-bearing)

## Problem

The citation-export hold-fix introduced a single shared `LINE_TERMINATORS` constant in `routes/papers.ts` covering CR, LF, U+000B (VT), U+000C (FF), U+0085 (NEL), U+2028 (LS), U+2029 (PS), used by `bibtexEscape`, `risEscape`, and `singleLine` so they cannot drift. Its stated rationale is "single shared constant so the helpers cannot drift to different separator alphabets."

But `digest.ts` has its own `singleLine` helper whose regex omits U+000B and U+000C. The two helpers share the name `singleLine` with **different** separator alphabets — the exact drift pattern `LINE_TERMINATORS` was introduced to prevent. The email-digest path therefore strips a narrower set than the citation-export path.

## Goal

Make `digest.ts`'s line-flattening reuse the same separator alphabet as `routes/papers.ts`, so a form-feed / vertical-tab in a broadcaster-controlled field (paper title, author name) cannot survive into the email digest where the cite-export path would strip it.

### Suggested approach

Extract `LINE_TERMINATORS` (and possibly the `singleLine` helper) to a shared escape-utils module that both `routes/papers.ts` and `digest.ts` import, OR import the constant from one into the other. Whichever keeps a single source of truth. If `digest.ts`'s `singleLine` intentionally handles only display line-breaks (not format-injection), document that distinction explicitly instead of widening — but the default is to unify.

## Acceptance

- `digest.ts` flattens the same 7-character line-terminator class as `routes/papers.ts`, sourced from one shared constant (no second literal regex).
- A test asserts a U+000B / U+000C in a digest field is flattened (mirrors the cite-export "extended line-terminator alphabet" tests).
- Comment anchors on stable symbols. `npm run typecheck` + `npm run lint` clean.

## Cross-references

- `backend/src/routes/papers.ts` — `LINE_TERMINATORS` constant (single source of truth).
- `backend/src/digest.ts` — `singleLine` helper with the narrower alphabet.
- Surfaced by the architect re-review of `backend-citation-export-format-escape` (maintainability lens).
