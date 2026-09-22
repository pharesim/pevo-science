---
title: "A reader that takes per-line facts from the TypeScript parser re-indexes them into its own line array, because the parser's line is not the reader's line unless both come from the same split"
date: 2026-09-22
last_updated: 2026-09-22
category: conventions
module: backend/tests/eslint + code-review process
problem_type: convention
component: testing_framework
severity: high
related_components:
  - development_workflow
  - code-review
applies_when:
  - "A hand-written reader or scanner delegates a per-line lexical fact to a real parser, and the parser exposes its own line-of-position API (such as TypeScript's getLineAndCharacterOfPosition)"
  - "A code-review finding proposes replacing a hand-rolled position-to-line map with the parser's own line helper, citing a sibling file's use of that helper as precedent"
  - "The reader's line array comes from splitting source text on a narrower newline definition than the parser treats as a line break (split on LF only, while the parser also breaks on a lone CR, U+2028 or U+2029)"
  - "Deciding whether such a substitution is safe, which takes executing both implementations against inputs the current tree does not contain, not reading the code or trusting a green suite"
  - "Writing the comment that belongs beside a hand-rolled parser-position-to-line conversion, saying why it is not built from the parser's own line API"
symptoms:
  - "A maintainability review flags a hand-rolled per-line position map as a duplicate of a parser's own line-of-position helper and proposes replacing it, citing a sibling file that already uses that helper"
  - "The sibling cited as precedent stays entirely inside the parser's own coordinate system and never indexes an external line array, so the precedent does not transfer"
  - "The proposed substitution is behaviour-preserving on the current tree and passes every existing test, because neither tree spells the rare line-breaking characters the two coordinate systems disagree on"
  - "Nothing in the code says why the per-line map is built from the reader's own split array instead of the parser's line API, so a reviewer has no signal that the two are not interchangeable"
root_cause: wrong_api
resolution_type: workflow_improvement
tags:
  - canary-tests
  - source-discipline
  - typescript-compiler-api
  - parser-oracle
  - coordinate-system
  - line-mapping
  - code-review
  - review-triage
---

# A reader that takes per-line facts from the TypeScript parser re-indexes them into its own line array, because the parser's line is not the reader's line unless both come from the same split

## Context

`backend/tests/eslint/no-accounts-updated-at-write-outside-signup-finalize.test.ts` is a source-discipline canary. Its text reader (`blankLine`, driven by `blankAll`) walks a file as a `lines: string[]` array produced by `split('\n')` in `sourcesUnder` (`backend/tests/support/enclosing-symbol.ts`). The reader delegates three TypeScript lexical facts to the real parser through `typescriptView(lines)`: for each line, where a `${` interpolation closes (or -1 when the close is on a later line), whether the line ends inside template text, and whether it ends inside a block comment. `typescriptView` calls `ts.createSourceFile` on `lines.join('\n')` and converts every parser position back to a `(line, column)` pair with its own `starts` array and `lineOf` binary search, both built purely from `lines[i].length + 1`. It deliberately does not call `sf.getLineAndCharacterOfPosition`.

A maintainability review lens flagged the hand-rolled `starts`/`lineOf` pair as a duplicate of a canonical library helper and proposed replacing it with `sf.getLineAndCharacterOfPosition`, citing the sibling canary `no-unresolvable-carve-out-companion-citation.test.ts` as precedent (that file's `commentBlocks` does call `sf.getLineAndCharacterOfPosition`). The precedent does not transfer: the sibling never indexes an external `split('\n')` array with the result. Its `lineOf` is used only to compare `startLine`/`endLine` against each other and to feed `lineStart` (`sf.getPositionOfLineAndCharacter`), which in turn slices the parser's own joined `text`/`code` strings. Every read in that file stays inside the parser's coordinate system. `typescriptView` is different in exactly the way that matters: its `closes`, `templateAtEnd` and `blockAtEnd` are indexed by position in the reader's own `lines` array, and `blankAll` looks them up by that same index (`view.closes[lineIndex]` inside `lines.forEach((_line, i) => ... blankLine(lines, i, state, sql, code, view.closes))`). Substituting `sf.getLineAndCharacterOfPosition` would have swapped the array's index space out from under every consumer while leaving the code compiling and, on the current tree, passing.

## Guidance

When a hand-written reader that keeps its own `lines: string[]` delegates a lexical fact to a real parser, every per-line answer the parser returns must be re-indexed into the READER's line numbering (the same `split('\n')` the reader itself walks), never left in the parser's own line numbering. The two only coincide when both are built from an identical split, and a parser's line-break rule and `split('\n')`'s line-break rule are not identical.

Before (the rejected simplification, sketched):

```ts
// WRONG: sf's line numbering is not lines' line numbering.
const lineOf = (pos: number): number => sf.getLineAndCharacterOfPosition(pos).line;
```

After (what `typescriptView` actually does):

```ts
const starts: number[] = [];
let offset = 0;
for (const line of lines) {
  starts.push(offset);
  offset += line.length + 1; // lines.join('\n')'s own break, nothing else
}
const lineOf = (pos: number): number => {
  // binary search over starts: returns an index into `lines`, not into sf's line table
  ...
};
```

The code should carry a one-line comment at `typescriptView`'s `starts`/`lineOf` pair saying why the map is built from `lines` rather than from `sf.getLineAndCharacterOfPosition`. That comment is pending as of this writing.

## Why This Matters

TypeScript's scanner and `String.prototype.split('\n')` disagree on what ends a line. The scanner's line-break set is `\n`, a lone `\r` (not followed by `\n`), U+2028 LINE SEPARATOR and U+2029 PARAGRAPH SEPARATOR; `\r\n` counts as a single break. `split('\n')` only ever breaks on `\n`, so a lone `\r`, a U+2028 or a U+2029 anywhere in the file becomes a break the parser counts and the split array does not.

Once such a character appears before the delegated fact's position, `sf.getLineAndCharacterOfPosition(pos).line` and the index of that same position in `lines` diverge by however many of those characters precede it, and they never re-converge for the rest of the file. Every `closes[line]`, `templateAtEnd[i]`, `blockAtEnd[i]` lookup that `blankAll` performs by indexing into the reader's own `lines`-shaped arrays would then read the map built for a different line. This is exactly the "two readers silently disagree" failure class `typescriptView`'s agreement arm (see `canary-reader-takes-typescript-facts-from-the-parser-not-a-hand-written-lexer.md`) exists to make loud: the arm compares the hand-written reader's carried state against the parser's view at each line end. But here the misalignment would live inside the conversion FEEDING both sides of that comparison, not between them, so both the reader and the view it is checked against would be shifted by the same amount at the same lines. An agreement arm cannot catch two readers that are wrong together.

Neither tree spells a lone `\r`, a U+2028 or a U+2029 today, so on the current tree the substitution is behaviour-preserving. No test exercises it, and the suite would stay green after the change, which is why the finding needed execution rather than a read of the diff to refute: the validator ran the parser against planted fixtures instead of accepting the "duplicate helper" framing on its face.

## When to Apply

- Any reader that keeps its own `lines: string[]` (or equivalent per-line array) built from a fixed split, and takes a per-line fact from a parser or library that has its own, independently defined notion of "line" (a lexer, an AST, a source-map library, a diff or patch library).
- Any review finding of the shape "simplify to the library's line helper, some sibling file already uses it." Check first whether the sibling's use ever leaves the library's own coordinate system to index an external array. If it does not, the precedent does not transfer.
- Any place a `(line, column)` pair crosses from one component's numbering into another's, even briefly, without an explicit re-index step next to the crossing.

## Examples

Reproduced by executing `typescript`'s `createSourceFile` against four fixtures, comparing `sf.getLineAndCharacterOfPosition` against a `lineOf` built the same way `typescriptView` builds it, both over the same `lines = text.split('\n')` (escapes below spell the characters; the fixtures held the real code points):

- Lone `\r` inside a template on `lines` index 1 (`const a = 1;\nconst x = \`a\rb\`;\nconst y = 2;\n`): the following `const y` is at `sf.getLineAndCharacterOfPosition(idx).line === 3` but at `lines` index `2`. Mismatch.
- `\u2028` inside a template on `lines` index 1 (`const a = 1;\nconst x = \`a\u2028b\`;\nconst y = 2;\n`): same shape, `3` versus `2`. Mismatch.
- `\u2029` inside a `//` comment on `lines` index 0 (`// note\u2029 \nconst y = 2;\n`): `sf.getLineAndCharacterOfPosition(idx).line === 2` versus `lines` index `1`. Mismatch.
- `\r\n` throughout (`const a = 1;\r\nconst x = 1;\r\nconst y = 2;\r\n`): both report `2`. Match. `\r\n` is safe because the scanner counts it as one break and the trailing `\r` stays attached to the end of the `split('\n')`-produced line, so the two numberings stay in lockstep.

The sibling canary `no-unresolvable-carve-out-companion-citation.test.ts`'s `commentBlocks` is the case where calling `sf.getLineAndCharacterOfPosition` IS correct, because it never crosses into an externally split array: its `lineOf` and `lineStart` (`sf.getPositionOfLineAndCharacter`) are used only against each other and against the parser's own `text`/`code`, so a lone `\r`, U+2028 or U+2029 shifts both sides of every comparison identically and produces no divergence at all.

## Related

- `canary-reader-takes-typescript-facts-from-the-parser-not-a-hand-written-lexer.md`: same file, same move of taking TypeScript facts from `ts.createSourceFile` via `typescriptView` instead of a hand-written lexer. That entry establishes why the parser is the oracle and how the agreement arm checks the reader against it; this entry is the narrower rule that the CONVERSION between the parser's coordinates and the reader's own must itself be correct, because the agreement arm cannot see a misalignment shared by both sides it compares.
- `differential-fuzz-regressions-after-removing-a-compensating-misread-are-triaged-by-trigger.md`: same file and reader. That entry is about triaging regressions once a compensating misread is removed; this one is about a substitution that was never applied, caught before landing because it would have introduced a new, differently shaped misalignment invisible to the same agreement machinery.
- `line-terminator-flattening-alphabet-and-regex-s-membership-2026-06-08.md`: the same code points (a lone CR, U+2028, U+2029) defeating a naive line-handling assumption in an unrelated subsystem, settled the same way, by running the real implementation rather than reasoning about it.
- `sql-grammar-questions-are-settled-against-a-nonexistent-relation-2026-09-16.md`: same canary; a language fact settled by executing the real implementation rather than by a sibling file's precedent, which is how the "duplicate helper" framing here was refuted.
- `docblock-anchor-stable-symbols-not-line-numbers-2026-05-15.md`: the constraint this entry itself writes under (symbol anchors, no line numbers, no task or round citations) and the same underlying concern one layer up: a citation's coordinate system must match its reader's, here generalised from prose comments to runtime line-number arithmetic.
