---
title: "A docblock illustrating a comment close with literal characters truncates itself and silently reopens a second comment"
date: 2026-09-22
category: conventions
module: frontend/tests/unit/eslint/enclosing-symbol.js
problem_type: convention
component: testing_framework
severity: high
applies_when:
  - "Writing a docblock or comment in a file whose comments discuss comment syntax itself, such as a comment scanner, lexer, tokenizer, lint rule about comments, or a source-discipline canary"
  - "Illustrating a region-boundary or re-entry rule, such as a comment close followed immediately by a new opener, with a written example"
  - "Reviewing such a docblock, where a green test suite and a passing `node --check` give no signal that the example changed what the comment actually spans"
  - "Deciding whether a literal comment-syntax example may stay as characters (safe inside a `//` line comment, which has no close to steal) or must be described in words (required inside a `/* */` block comment or docblock)"
symptoms:
  - "A real parser counts one more block comment in the module than the author believes was written"
  - "The accidental second comment opens with a plain opener, so anything keyed on the docblock's double-star form reads the docblock as ending mid-sentence, with a whole named trailing paragraph outside it"
  - "`node --check` and the test suite both stay green, because the accidental second block comment is syntactically valid"
  - "A comment close added later inside the accidental span turns the remainder of the module into live code"
tags:
  - docblock
  - comment-syntax
  - self-reference
  - block-comment
  - jsdoc
  - source-discipline-canary
  - comment-anchor
---

# A docblock illustrating comment syntax must describe a literal comment close, never write it

## Context

`frontend/tests/unit/eslint/enclosing-symbol.js` is scan machinery for a source-discipline canary: it resolves the declaration enclosing a matched line and reads comment regions so a scan does not mistake prose for live code. Because of that job, its own comments routinely have to talk ABOUT comment syntax, not just use it. The docblock over the exported function `blockCommentInterior` (a per-line block-comment-region reader that feeds `isCommentLine`, the predicate deciding whether a given line is comment prose) illustrated a region re-entry rule by writing the actual characters of a comment close, a space, and a second opener, wrapped in backticks as an example.

Those characters are not inert inside a `/** ... */` docblock. The close ended the docblock right there. The file still parsed, because the example's own second opener started a new, ordinary block comment, and that ran forward until it hit the docblock's real terminator. Comments do not nest, so nothing overtly broke: `node --check` passed and the test suite stayed green, because the accidental second comment is itself valid syntax. But roughly the last half of the intended docblock, including a whole named residual paragraph, was sitting inside that accidental second comment rather than the one the author believed they were writing. A real parser counted 13 block comments in the file where the author believed 12, and because the accidental comment opens with a plain opener rather than the docblock's double-star form, anything that keys on that form reads the docblock as ending mid-sentence at the illustration. It survived two review passes this way (session history): the checks people usually trust, tests and `node --check`, are blind to a comment boundary landing in the wrong place as long as the result is still legal, and what exposed it was the parser's comment count, not a failing check.

## Guidance

Never write the literal characters of a block-comment close inside a block comment, even as a worked example of comment syntax. Describe the shape in words instead. The fix that landed changes the docblock over `blockCommentInterior` to read `(a close, a space, then a second opener)`, in prose, with no delimiter characters in it.

The same literal example is safe inside a `//` line comment, and the module keeps one there on purpose: the brace-walk comment inside `enclosingSymbol`, in the paragraph beginning "Leaving the region, the code after the first close on that line is live", spells out the same close-space-opener shape as backtick-quoted characters. A line comment has no close of its own for the example to steal. A line comment runs to the end of the line whatever characters follow the `//`, so a close or an opener inside one cannot terminate or reopen anything. That is the dividing line: a `//` comment cannot be closed early by its own contents, a `/* */` comment can, and once it is closed early by its own example, the "second opener" in the same example silently starts a new one.

This generalizes past this one file. Any file whose comments discuss comment syntax is exposed: comment scanners, lexers, tokenizers, lint rules that talk about comments, canaries built over comments, code that strips comments, and any docblock anywhere that quotes a comment close as a worked example. `isCommentLine`'s own docblock in the same module spends dozens of lines reasoning about the `//`, opener and close shapes precisely because it is the predicate the region reader feeds, and it stays clear of the trap by naming the closing delimiter rather than spelling it out.

## Why This Matters

A green test suite and a passing `node --check` are not evidence this class of defect is absent, because the accidental second comment is fully valid JavaScript. It does not fail to parse; it parses with the boundary in the wrong place. A human reading the prose for sense will not notice either, because the visual text still reads as one continuous paragraph.

The risk compounds beyond documentation hygiene. Once part of a docblock is unknowingly living inside a second, accidental comment, any later edit that adds a comment-close sequence inside that hidden span (a plausible edit in a file whose whole job is discussing comment syntax) turns the remainder of what the author still believes is a comment into live code. That failure is loud: `node --check` fails, and both consuming suites fail at import. But it fails loud only when someone happens to make that edit, arbitrarily far downstream of the original mistake: quiet when introduced, unpredictable when it finally detonates.

## When to Apply

- Writing or editing any docblock, comment, or piece of prose that needs a literal example of comment-opening or comment-closing characters.
- Especially inside comment scanners, lexers, tokenizers, lint rule sources, source-discipline canaries, and any code that classifies or strips comments, where narrating comment syntax from inside a comment is routine.
- Choosing which comment form should host a hazardous literal: a `//` line comment can safely hold the characters, because it has no close to steal; a `/** ... */` block comment cannot, and gets a words-only description instead.
- Reviewing such a docblock: do not rely on it reading sensibly end to end. Run it through a real parser, or through the module's own comment reader, to confirm the region ends where the reviewer thinks it does.

## Examples

**Before (hazardous, described rather than reproduced):** the original wording illustrated the region re-entry rule by writing out, character for character inside the docblock's own backticks, the two-character comment close, a space, and the two-character comment opener that follows it. Written live inside a `/** ... */` docblock, that sequence ends the docblock at the close and opens an unrelated new comment at the opener, which is exactly the shape the prose was trying to describe, only now happening to the prose itself.

**After (the fix, quotable because it is words, not delimiters):** the docblock over `blockCommentInterior` now reads `(a close, a space, then a second opener)`. Same rule conveyed, no delimiter characters anywhere in the sentence.

**Cheap detection recipe.** Two checks catch this class without eyeballing delimiter balance by hand:

1. Count block comments with a real parser and compare against the number of docblock openers in the text. Parsing the current file with `@babel/parser` (`attachComment: true`) reports 12 block comments against 12 lines beginning with `/**`, and the comment nearest `export function blockCommentInterior` ends with nothing but a newline between its close and the `export` keyword, so the docblock is read as one comment running all the way to the declaration. Before the fix the same count read 13 against 12.
2. Run the module's own region reader over its own source lines. `blockCommentInterior(lines)` marks a line true when it sits inside a block comment opened on an earlier line, so over a healthy docblock the opener line reads false and every line after it, through the closing line, reads true. Feeding the module its own lines shows exactly that for both the `blockCommentInterior` docblock and the `isCommentLine` docblock: no line inside either span drops to false. A drop inside the span is the hidden second comment's boundary.

**Verification the fix used.** `node --check` on the file passes. A real parser reads the docblock over `blockCommentInterior` as a single block comment, opening at its own `/**` and closing immediately before the `export function blockCommentInterior` declaration, with no earlier stray close splitting it. The module's own `blockCommentInterior`, run over the module's own lines, reports that docblock, and separately `isCommentLine`'s docblock, as one continuous region each.

## Related

- `composite-mutation-probe-does-not-cover-its-constituent-branches-2026-09-06.md` is an earlier finding in this same file, on the block-comment tracking inside `enclosingSymbol`'s brace walk: a different layer (probe coverage of the region logic rather than the docblock prose describing it), but the same lesson that ordinary review and a green suite do not surface defects in code whose comments discuss comment syntax.
- `source-discipline-canary-comment-normalization-and-lens-vs-probe-coverage-2026-09-08.md` documents the same class one layer up, a scanner misreading comment boundaries in the code it scans; this entry is the same class turned inward, on the scanner's own illustrative docblock. Both converge on the same check: run the reader itself over the text in question.
- `fail-closed-does-not-transfer-from-set-equality-to-pairing-canaries-2026-08-31.md` is a sibling-module precedent (the backend dialect this module was hand-ported from) for a docblock claim in this resolver family going unnoticed until specifically re-derived.
- `comment-anchor-rot-precommit-diff-gate-2026-06-14.md` describes the mechanized pre-commit gate over new comment lines; its detection classes do not include a literal comment close inside a block comment, so that gate would not have caught this and is the natural place to extend if the shape recurs.
