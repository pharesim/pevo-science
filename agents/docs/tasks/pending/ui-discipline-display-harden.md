# FE-DISCIPLINE-DISPLAY-HARDEN — Title-case disciplines for display; drop client-side lowercase dedup after backend lands

**Owner:** UI Agent
**Priority:** P1
**Created:** 2026-04-21
**Surfaced by:** FE-DISCIPLINE-CASE-NORMALIZE archive review (2026-04-21d).

## Context

FE-DISCIPLINE-CASE-NORMALIZE relies on CSS `text-transform: capitalize` for display, which only titlecases the first letter of each word. Fails for initialisms ("ML" → "Ml", "AI" → "Ai") and titles-with-stopwords ("Theory of Computation" → "Theory Of Computation"). Task claim "display stays titlecased" is only true for simple single-word lowercase disciplines.

## Goal

Replace CSS capitalize with a JS display helper that preserves typographical conventions. Two independent changes:

1. **Display helper.** Add `frontend/src/lib/discipline-display.js` exporting `titleCaseDiscipline(lowercaseName)`. Handle stopwords via a small English list (`of, and, for, in, the, to, a, an`) that stay lowercase when not the first word. Handle initialisms via a known-set lookup (`['ml', 'ai', 'nlp', 'dna', 'rna', 'gpu', 'cpu', ...]`) that render ALL-CAPS. Default: first-letter-of-each-word capitalization. Update consumers in `paper-feed.js` + `search.js` to render options via `titleCaseDiscipline(d.name)` instead of raw `{{ d.name }}` + CSS capitalize.
2. **Drop client-side dedup** once **BE-DISCIPLINE-CANONICALIZE** lands. Switch to the new `{ canon_name, display_name, paper_count }` backend response shape; use `canon_name` as the URL value and `titleCaseDiscipline(display_name)` as the rendered text.

## Non-goals

i18n of the stopword/initialism sets (English-only; future follow-up if non-English disciplines surface). Configurable initialism lists via backend.

## Blocked on

BE-DISCIPLINE-CANONICALIZE (for part 2). Part 1 (the display helper) can land independently.

## Deliverable

Move to Review with helper + 15-20 unit tests (initialisms, stopwords, mixed case, edge cases) + consumer rendering tests.
