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

## Backend signal (2026-06-05, commit on main)

Extracted `LINE_TERMINATORS` (the 7-char CR/LF/VT/FF/NEL/LS/PS class) to a new shared module `backend/src/lib/line-terminators.ts`, imported by BOTH `routes/papers.ts` (replacing the local const) and `digest.ts` (`singleLine` now uses it, fixing the prior VT/FF omission). Added an extended-line-terminator-alphabet test block in `digest-title-strip.test.ts` (FF/VT-forged titles collapse to one line). Note: the implementer corrected the docblock claim about `\s` — in V8 `\s` already matches VT/FF/LS/PS, so only NEL (U+0085) is the genuine `\s`-collapse survivor. `npm run typecheck` + `npm run lint` clean; digest + papers cite tests green.

## Architect re-review (2026-06-08) — HELD PENDING FIXES:

First review (commit 428ef752) by a 9-reviewer `/ce-code-review` (correctness/security/adversarial on Opus; testing/maintainability/project-standards/performance/kieran-typescript/learnings on Sonnet). The extraction is sound: `LINE_TERMINATORS` is the single source of truth for both `routes/papers.ts` and `digest.ts`'s `singleLine`, closing the prior VT/FF omission; the regex is a flat char-class (no ReDoS) and all consumers use `.replace` (the `g`-flag `lastIndex` caution is moot for `.replace`). Two items before archive. **Coordinate with the sibling `backend-citation-export-format-escape` hold so the docblock + char-class edits land in ONE backend commit** — the `digest.ts` docblock twin and the `papers-cite-escape.test.ts` mirror are held there.

1. **Docblock LS/PS `\s`-membership claim is factually wrong (two reviewers, conf 100; verified `/\s/.test()` on Node 20 — VT/FF/LS/PS all match, only NEL does not).** The `LINE_TERMINATORS` docblock states "NEL, LS, and PS are also not `\s` members in V8." Only NEL (U+0085) is a non-`\s` member; LS (U+2028) and PS (U+2029) ARE `\s` members (as are VT and FF). The regex still catches all seven regardless, so this is a documentation-accuracy defect, not a behavior bug — but it is the canonical shared-constant docblock, and the `\s` fact has now been stated wrong across two review rounds, so fix it to match what THIS task's own Backend signal already states correctly ("only NEL is the genuine `\s`-collapse survivor"): only NEL would survive a downstream `\s+` collapse; VT/FF/LS/PS would all be caught by it. Mirror the same correction in `digest-title-strip.test.ts`'s `it('strips Unicode line terminators that are not \s members in V8 (NEL, LS, PS)', ...)` label and its inline comment — the assertions are correct; only the "(NEL, LS, PS)" non-`\s` framing is wrong (NEL is the only non-`\s` member of the three).

2. **Widen `LINE_TERMINATORS` to the C0 information separators FS/GS/RS (U+001C–U+001E).** Adversarial reproduced an RIS record-forgery through the real `generateRis` for importers that tokenize with a `splitlines()`-class splitter (which breaks on U+001C/1D/1E): a crafted title fractures one `TI  - ` line into a forged `ER  - ` plus a phantom record with an attacker-chosen `AU  - `. The current class is drawn at UAX#14 mandatory-break and omits these; widening makes the docblock's "complete set a downstream importer treats as a break" claim actually true at negligible cost (C0 controls have no legitimate place in a paper title/author). Add `\u001c\u001d\u001e` to the constant, update the docblock enumeration (7-char → 10-char class, naming FS/GS/RS), and extend the `digest-title-strip.test.ts` extended-alphabet block to assert FS/GS/RS flatten and cannot emit a second forged line (build the separators via `String.fromCharCode` to keep the source ASCII). The sibling `papers-cite-escape.test.ts` mirror is held on `backend-citation-export-format-escape`.

Dismissed at triage (no action): a `citeAuthorNames` 500 on a null `authors[]` element (pre-existing; `detail.authors[].name` totality keeps the live `/cite` path null-free — defense-in-depth only).

## Backend re-review signal (2026-06-08, working tree):

Both round-1 hold items landed (coordinated with `backend-citation-export-format-escape` in ONE commit, per the hold's instruction):
1. `lib/line-terminators.ts` docblock and `digest-title-strip.test.ts` `\s`-members label/comment corrected. Verified empirically on Node 20: only NEL (U+0085) and FS/GS/RS (U+001C-U+001E) are non-`\s` members; VT/FF/LS/PS ARE `\s` members a downstream `\s+` collapse catches. The test label is now "strips Unicode line terminators NEL (the non-`\s` survivor), LS, PS" with a comment noting LS/PS are `\s` members asserted for completeness.
2. `LINE_TERMINATORS` widened to the C0 information separators FS/GS/RS (U+001C-U+001E): the 10-char class is now CR, LF, VT, FF, FS, GS, RS, NEL, LS, PS (clean backslash-u escapes; verified the compiled regex matches exactly those 10 code points and nothing else). Docblock enumeration updated (7 to 10, naming FS/GS/RS and the `splitlines()`-class record-forgery rationale). `digest.ts` `singleLine` now flattens the full 10-char class via the shared constant. Added a record-separator-forged-title test to the digest extended-alphabet block; the sibling `papers-cite-escape.test.ts` mirror landed under `backend-citation-export-format-escape`.

`npm run typecheck` + `npm run lint` clean; `digest-title-strip.test.ts` + `papers-cite-escape.test.ts` green (79/79).
