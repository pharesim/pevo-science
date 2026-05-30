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
