# BACKEND-CITATION-EXPORT-FORMAT-ESCAPE — escape BibTeX / RIS metacharacters in paper-export endpoints

**Owner:** Backend Agent
**Created:** 2026-05-30 (security audit follow-up workflow)
**Priority:** P2 (file-format corruption / citation-manager confusion; not classical XSS)

## Problem

The paper-citation export endpoints in `backend/src/routes/papers.ts` interpolate paper title and author names into BibTeX and RIS file formats without format-escaping:

- BibTeX export builder — paper title, author list, and any other free-form chain field embedded in `@article{...}` shape. A title containing `}` or `\` corrupts the entry; an author containing newline corrupts the author list.
- RIS export builder — `TI`, `AU`, `AB`, etc. lines. The RIS format is line-oriented with two-character tag prefixes and `  - ` separator; any embedded CR/LF, or an attacker-crafted line starting with `AU  -` / `ER  -` inside a title or abstract, ends or rewrites the citation record.

Not XSS (these files are not HTML-rendered by the browser; consumers are reference managers like Zotero, Mendeley, JabRef). The exploit class is **file-format injection**: corrupting another author's exported citation, inserting fake co-authors into the AU list, or smuggling additional records into the export. Severity is medium because impact is bounded to the citation-manager output, but the fix is mechanical.

## Goal

Escape format metacharacters per the actual citation format rules:

- **BibTeX:** wrap values in `{...}`, escape `\`, `{`, `}`, and special TeX chars (`#`, `$`, `%`, `&`, `_`, `^`, `~`) per BibTeX's quoting rules. At minimum: escape `\`, `{`, `}`, and strip CR/LF.
- **RIS:** strip CR/LF from all values (the format is strictly line-oriented; a CR/LF inside a value breaks the file regardless of subsequent escaping). RIS does not have a quoting mechanism, so stripping is the only safe option.

## Fix sketch

Add per-format escape helpers, e.g.

```ts
function bibtexEscape(s: string): string {
  return s
    .replace(/\\/g, '\\textbackslash{}')
    .replace(/[{}]/g, (c) => `\\${c}`)
    .replace(/[#$%&_^~]/g, (c) => `\\${c}`)
    .replace(/[\r\n]+/g, ' ');
}

function risEscape(s: string): string {
  // RIS has no escape mechanism; strip line terminators and tag-like sequences at line start.
  return s.replace(/[\r\n]+/g, ' ').trim();
}
```

Apply at every interpolation site in the BibTeX and RIS builders. Audit for any other free-form field beyond title/author (journal name, abstract, keywords, DOI placeholder).

## Acceptance

1. **BibTeX corruption defeated.** Test: paper with title `Hello } extra-entry @article{evil, author={attacker}` exports to BibTeX where the export contains exactly ONE `@article{...}` entry. Test parses the export with a BibTeX parser (or a regex count of `@article{`) and asserts cardinality.
2. **BibTeX special chars escaped.** Test: paper with title `100% awesome & cheap` exports with `\%` and `\&` rather than literal `%` / `&`. Round-trip through a BibTeX parser yields the original string.
3. **RIS line injection defeated.** Test: paper with title `Innocent\r\nAU  - Fake Author\r\nER  -` exports to a RIS record containing exactly the expected number of `AU  -` and `ER  -` lines (not the attacker's smuggled ones). Test counts lines and asserts.
4. **Legitimate titles round-trip.** Test: paper with title `Some Paper Title` exports normally and re-parses correctly via a real BibTeX / RIS consumer (mock or real library).
5. **Author list specifically.** Both formats: an author name containing a separator character (`{` in BibTeX, CR/LF in RIS) is escaped/stripped without corrupting the author-list structure.
6. **Mutation-kill:** revert each escape helper → corresponding test goes RED.

## Out of scope

- A broader citation-format audit (the audit confirmed BibTeX/RIS are the only export formats; if CSL-JSON or other formats are added later, the same discipline must extend).
- Frontend changes to the export UI.
- Validating paper titles on broadcast (the chain is the source of truth; defense lives at export).

## References

- `backend/src/routes/papers.ts` — `/papers/:permlink/export.bib` and `/papers/:permlink/export.ris` handlers (or whichever route paths are current; the audit pointed at the BibTeX and RIS builder functions).
- BibTeX format spec — quoting and escape rules; TeX special chars.
- RIS format spec (Research Information Systems) — line-oriented two-letter tag format, no escape mechanism.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>

## Architect re-review (2026-05-30) — HELD PENDING FIXES:

`/ce-code-review` confirmed the BibTeX `@`-breakout is defeated (the brace escape neutralizes it), the single-pass `bibtexEscape` does not double-escape its own `\textbackslash{}`, and the implementation went beyond scope to cover APA too. Two items before archive:

1. **Line-terminator class is too narrow.** `risEscape`, `singleLine`, and `bibtexEscape`'s CR/LF flatten strip only `[\r\n]`. Form-feed (U+000C), vertical-tab (U+000B), NEL (U+0085), U+2028, and U+2029 survive — a crafted title smuggles a forged RIS record (`TY`/`TI`/`AU`/`ER` lines) into lenient importers and splits the one-line APA citation. This is the same file-format-injection class the task exists to close, reached through a wider separator alphabet. Broaden all three helpers to a shared line-terminator class, e.g. `/[\r\n\u000b\u000c\u0085\u2028\u2029]+/g` (single shared constant so they can't drift). Add tests asserting a U+000C / U+2028 title cannot emit more than one `ER  -`/`TY  -` line and the APA stays one line.
2. **`as string` casts now crash-reachable.** `detail.title`/`author`/`created` are cast `as string` and fed straight into the `.replace()`-calling helpers; an absent chain field would 500. Unreachable today via Hive's empty-string-title convention, but coerce defensively (`s == null ? '' : s` at the helper entry, or guard at the call site).

While fixing item 1, also cover the currently-untested empty-`pevo.authors` fallback branch and the RIS `DO  -` (doi) branch. Two notes, low priority: `detail.doi` is never populated on the live `/cite` path (DOI lives at `pevo.source.doi`), so the doi-escape branch is effectively dead — decide whether to wire `detail.doi = pevo.source.doi` (so citations carry the DOI and the escape applies) or remove the dead branch. The `year = NaN` edge on a malformed `created` is unreachable (chain timestamp) — no action.

## Backend re-review signal (2026-06-02, working tree):

Both hold items landed plus the requested extra coverage. Implementation in
`backend/src/routes/papers.ts`, tests in
`backend/tests/routes/papers-cite-escape.test.ts`.

- **Item 1 (line-terminator class too narrow):** added a single shared
  `LINE_TERMINATORS` constant (covering CR, LF, U+000B, U+000C, U+0085, U+2028,
  U+2029) that `bibtexEscape`, `risEscape`, and `singleLine` all flatten
  against, so they cannot drift. New "extended line-terminator alphabet" tests
  assert each separator flattens in all three helpers; a form-feed/line-
  separator-smuggled RIS title cannot emit extra TY/ER/AU lines; the APA stays
  one line with no surviving raw separators; and a line-separator-smuggled
  BibTeX header cannot create a second entry. (Separators are built via
  String.fromCharCode so the test source stays pure ASCII.)
- **Item 2 (`as string` casts crash-reachable):** each escape helper coerces
  any NON-STRING input to '' at entry (`typeof s === 'string' ? s : ''`), and
  the generators coerce `detail.title`/`detail.author` the same way (the
  `created`->NaN edge left per the hold note). The stronger `typeof` guard
  (rather than `s == null`) is load-bearing: `pevo.authors[].name` is
  broadcaster-controlled with no per-element type check, so a numeric name
  reaches `risEscape(a.name)` / `singleLine(a.name)` directly — `42 == null` is
  false, so a null-only guard would still `(42).replace(...)` and 500. New
  "defensive coercion" tests assert the helpers return '' on null/undefined AND
  on numbers/objects/arrays, and that the generators do not throw on an absent
  title/author or a wrong-typed author name.
- **Extra coverage:** "empty-authors fallback" tests pin the BibTeX/RIS/APA
  author fallback to the post account when `pevo.authors` is empty. The
  "DOI branch (detail.doi)" tests pin the RIS `DO` escape and the no-DOI case
  via the field the generators actually read.
- **DOI decision (architect's wire-or-remove question):** investigated wiring
  the DOI from `pevo.source.doi` and found it would be INEFFECTIVE — the
  generators read `detail.json_metadata.pevo`, but live chain metadata stores
  the PEvO object under `meta[config.appTag]` (`pevotest`), accessed elsewhere
  via `safePevoMeta`. On the live `/cite` path `detail.json_metadata.pevo` is
  `undefined`, so `pevo.source.doi` would never resolve. I therefore REVERTED
  the `pevo.source.doi` wiring and left the DOI branch reading the original
  `detail.doi` (unchanged from before this task). This avoids shipping dead/
  misleading code. Properly wiring the DOI requires the keying fix below, which
  is out of this escaping task's scope.
  - **[Surfaced finding — recommend a SEPARATE task, architect to triage]** The
    same keying issue is a pre-existing correctness bug with wider impact: the
    citation generators read `detail.json_metadata.pevo.authors`, which is also
    `undefined` on the live path, so **exported citations always fall back to
    the posting account and never list co-author names** (and never carry a
    DOI). `buildPaperDetail` already exposes the correctly-keyed `detail.authors`
    (via `safePevoMeta`); the fix is to read `detail.authors` for the author
    list and `safePevoMeta(detail.json_metadata).source.doi` for the DOI, but
    the `detail.authors` shape varies across the continuation/supersession paths
    (it is overridden with `authors_with_supersession` / `cumulativeAuthors`),
    so this needs its own task + tests, not a drive-by here. Not in `cite.test.ts`
    coverage (it only exercises the 400/404 paths). This is NOT introduced by
    this task; surfaced for triage per the Code Review Findings rule.

`npm run typecheck` + `npm run lint` clean (lone lint warning is a pre-existing
unused-directive in `author-supersession.ts`, not in scope).

## Architect note (2026-06-05) — singleLine dedup now actionable at this task's review

The digest task (email-digest-title-line-injection) has archived; its `singleLine`
in `digest.ts` strips CR/LF plus NEL/LS/PS (U+0085, U+2028, U+2029) in pass 1 and rides a `\s+`
second pass for VT/FF, while this task's `papers.ts` `LINE_TERMINATORS` enumerates
VT/FF explicitly and has no second pass. Behaviorally equivalent for
line-flattening today, but the two near-duplicate helpers can drift. The
digest-side deferral ("whoever lands last dedups") now points here: when this
task is reviewed/landed, weigh extracting a shared line-terminator constant
consumed by both `digest.ts` and `papers.ts`, or record why the two surfaces
intentionally stay self-contained.

## Architect re-review (2026-06-06) — HELD PENDING FIXES:

Round-2 verified: both 2026-05-30 hold items are FIXED (the shared LINE_TERMINATORS class — commits 4065e8e6 + 428ef752 — was security-reviewed as exactly the Unicode line-terminator alphabet, sufficient; the non-string coercion verified at helpers and generator call sites). The 2026-06-05 singleLine-dedup note above is RESOLVED by `lib/line-terminators.ts` (digest + papers consume one constant; the tests keep independent `String.fromCharCode` value-pins, complying with the dedup-value-pin convention). The DOI revert decision was correct; the keying bug is owned by `backend-cite-export-pevo-metadata-key-mismatch`. Two final items before archive:

1. **Honest escape-helper signatures.** `bibtexEscape` / `risEscape` / `singleLine` are typed `(s: string)` but intentionally coerce any non-string input; the tests need `undefined as unknown as string` double-casts to compile. Widen the three signatures to `(s: unknown): string` and drop the double-casts in `papers-cite-escape.test.ts`.
2. **Digest docblock overclaim.** `digest.ts`'s `singleLine` docblock says the shared constant is "what stops a form-feed or vertical-tab in a paper title from surviving into the digest"; VT and FF are `\s` members in V8 and were already collapsed by the second `\s+` pass pre-change. Reword: the shared constant's value is single-source-of-truth against alphabet drift, and NEL (U+0085) is the member a `\s`-based pass would miss.

Dismissed at triage: SEP test-table duplication across the two escape test files (self-contained suites double as independent value-pins); a jsonb_array_length cap proposal that belonged to the sibling listing tasks.

## Backend re-review signal (2026-06-06, working tree):

Both round-3 hold items landed. `npm run typecheck` + `npm run lint` clean (lone lint warning is the pre-existing unused-directive in `author-supersession.ts`, not in scope); `papers-cite-escape.test.ts` green.

- **Item 1 (honest escape-helper signatures):** widened `bibtexEscape` / `risEscape` / `singleLine` in `routes/papers.ts` from `(s: string)` to `(s: unknown): string` (the internal `typeof s === 'string' ? s : ''` coercion was already there). Dropped the `undefined as unknown as string` double-casts in `papers-cite-escape.test.ts`'s "defensive coercion" test — the non-string inputs (`undefined`, `null`, `42`, `{}`, `['x']`) now pass without casts. The `42 as unknown as string` on `authors[].name` in the wrong-typed-author-name test stays: that cast targets the `name: string` field type, not the helper signature.
- **Item 2 (digest docblock overclaim):** reworded `digest.ts`'s `singleLine` docblock. Removed the claim that the shared constant is "what stops a form-feed or vertical-tab from surviving" — VT and FF ARE `\s` members in V8 and were already collapsed by the second `\s+` pass. The docblock now states the explicit first pass earns its keep on NEL (U+0085) / LS / PS (the non-`\s` members), and what the SHARED constant buys is single-source-of-truth against separator-alphabet drift between the digest and cite-export paths.

## Architect re-review (2026-06-08) — HELD PENDING FIXES:

Round-4 review of the citation cluster (commits c4dc9f0c + 428ef752) by a 9-reviewer `/ce-code-review`. The round-3 fixes are confirmed FIXED: the `(s: unknown): string` widening is honest, the double-casts are dropped (the lone `42 as unknown as string` targets the `name: string` field type, not the helper signature — correct to keep), and the shared `LINE_TERMINATORS` consumption is correct. But the round-3 item-2 deliverable — the reworded `digest.ts` `singleLine` docblock — introduced a NEW factual error of the very `\s`-membership class it was meant to fix (a `convention-enforcing-fix-must-audit-its-own-new-code` recurrence). Two items before archive. **Coordinate with the sibling `backend-digest-share-line-terminators` hold so the docblock + char-class edits land in ONE backend commit** — that task owns the `lib/line-terminators.ts` docblock + the constant widening + the `digest-title-strip.test.ts` mirror.

1. **`digest.ts` `singleLine` docblock LS/PS `\s` claim is wrong (two reviewers, conf 100; verified `/\s/.test()` on Node 20).** The round-3 reword states "NEL (U+0085), LS (U+2028), and PS (U+2029) are NOT `\s` members in V8." Only NEL is a non-`\s` member; LS and PS ARE `\s` members — and the same docblock already correctly says VT/FF are `\s` members, so it is internally inconsistent. Reword so the explicit first pass is justified ONLY by NEL (U+0085): VT/FF/LS/PS are all `\s` members the second `\s+` collapse pass would catch; NEL is the sole genuine survivor the explicit `LINE_TERMINATORS` pass earns its keep on. Comment-only, no behavior change.

2. **Mirror the C0-separator widening in `papers-cite-escape.test.ts`'s extended-line-terminator-alphabet block.** `LINE_TERMINATORS` is being widened to add FS/GS/RS (U+001C–U+001E) under the sibling `backend-digest-share-line-terminators` hold (adversarial reproduced an RIS record-forgery via these C0 separators for `splitlines()`-class importers). Extend this task's cite-export extended-alphabet suite to assert FS/GS/RS flatten in `bibtexEscape` / `risEscape` / `singleLine` and cannot emit a second `@article{` / `TY` / `ER` / `AU` record, mirroring the existing VT/FF/NEL/LS/PS assertions (build the separators via `String.fromCharCode` to keep the source ASCII).
