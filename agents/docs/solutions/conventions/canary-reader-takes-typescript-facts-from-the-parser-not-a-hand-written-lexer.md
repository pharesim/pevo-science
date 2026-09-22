---
title: "A source-scan canary's reader takes its TypeScript facts from the TypeScript parser, not a hand-written lexer, and answers to the parser at every line end"
date: 2026-09-22
category: conventions
module: backend/tests/eslint
problem_type: convention
component: testing_framework
severity: high
related_components:
  - development_workflow
applies_when:
  - "A source-scanning canary's reader must decide a TypeScript lexical fact (where a template interpolation closes, whether a line ends inside template text or a block comment) before its patterns can match"
  - "A hand-written lexer rule is being added or patched for regex-versus-division, nested templates, or quotes and dollar spans inside an interpolation"
  - "Successive review passes each find the previous reader fix incomplete, every hand-written rule trading one ordinary spelling for another"
  - "A canary reader keeps its own state machine for an embedded language (SQL inside templates) that the TypeScript parser does not read, so it cannot simply be replaced by the parser"
  - "Deciding how to verify a hand-written reader's carried state: against an oracle at every line end, not against enumerated spellings or a terminal-state check alone"
symptoms:
  - "A planted ordinary writer (`await q('UPDATE accounts SET updated_at = NOW() WHERE id = $1', [id])`) leaves a merge-blocking canary green"
  - "A nested template's opening backtick inside a quoted value within an interpolation ends the outer template and leaves the reader's template flag inverted at the line end"
  - "Once the flag is inverted a `//` stops being a comment and a route glob opens a block comment over the next writer, while a later template flips the flag back so the end-state assertion stays clean"
  - "A division after an operand spelling the hand-written lexer does not carry (`x!!`, `1.`, `f<string>`) is judged a regex that runs to the next slash and swallows the template's closing backtick"
  - "Four adversarial passes each found the previous hand-written fix incomplete"
root_cause: incomplete_enumeration
resolution_type: code_fix
tags:
  - canary-tests
  - source-discipline
  - typescript
  - typescript-compiler-api
  - template-literal
  - comment-normalization
  - silently-disarmed-guards
  - parser-oracle
---

# A source-scan canary's reader takes its TypeScript facts from the parser, and answers to the parser at every line end

## Context

`backend/tests/eslint/no-accounts-updated-at-write-outside-signup-finalize.test.ts` is a source-discipline canary asserting that `accounts.updated_at` is written only by two allowed statements. It scans `backend/src` (`.ts`) and `backend/migrations` (`.sql`) through one hand-written reader (`blankLine`, driven per file by `blankAll`). The reader blanks comments and carries state across lines: template text, quoted SQL values, dollar-quoted spans, SQL block comments and `${...}` interpolations. Every writer scan then pattern-matches the blanked text. SQL lives inside TypeScript templates, so the reader speaks both dialects at once, and a wrong boundary is a silent pass: a planted ordinary writer (`await q('UPDATE accounts SET updated_at = NOW() WHERE id = $1', [id])`) leaves the suite green.

The shape behind most silent passes: the reader misjudged where a TypeScript construct ended and left its template flag inverted at the end of that line. From there a `//` stopped being a comment, a path glob in the comment's prose (`// ... /api/admin/* routes`) opened a block comment over the writer, and a later URL template flipped the flag back, so the file's end state looked clean. The end-state arm ('the reader finishes every file it reads with no span left open') cannot see a misread that a later line undoes.

The earlier rounds chased this one entry point at a time (session history):
- a re-read of any line that ended inside a quoted value
- regex-literal modelling from the preceding code (`OPERAND_END_RE`, `PATTERN_KEYWORD_RE`), then a wider operand list
- a gate that let a backtick count only where the reader believed a template was open, which made one wrong flag stick for the rest of the line instead of flipping back at the next backtick
- a hand-written interpolation copy (`interpolationEnd`, brace depth and a quote stack)

Each held for its own shapes, and each round's adversarial pass found the next one. Four further adversarial passes (about 52 agents) ran against successive hand-written fixes for the interpolation close, and each again found the previous fix incomplete. What converged is what the canary now does.

## Guidance

1. **Treat non-convergence as the signal to stop hand-lexing.** Finding where `${...}` closes needs brace depth, quoting with escapes, nested templates at every depth, comments, and the regex-or-division judgement. That last one needs a parser. What was tried:
   - A quote stack plus brace depth, on the main path only. It was bypassed when the interpolation sat inside a quoted value or a dollar span.
   - A recursive single-line lexer reusing the main path's regex judgement. A division after an operand the rule did not list read as a regex, ran to the next slash and swallowed the template's closing backtick. That regressed shapes the simpler reader had closed correctly by accident.
   - A "dual reading", once with the judgement and once with every slash as a character, refusing when the two disagreed. It leaked when one reading found no close and when both agreed on a wrong close. It also added false reds on ordinary code (`/}/g`).
   When each fix closes the reported shapes and a fresh pass finds new ones in the same class, the class is a grammar question, not a rule question.

2. **Take the TypeScript facts from `ts.createSourceFile`.** `typescriptView` parses the file with `ScriptTarget.Latest` and `ScriptKind.TS`. TS, not TSX, so `<number>x` is an assertion. It returns a `TypeScriptView` holding three per-line facts:
   - `closes`: each `${` column of a `TemplateExpression` or `TemplateLiteralTypeNode`, mapped to the exclusive end of its `}` on the same line, or to -1 when the close is on a later line.
   - `templateAtEnd`: whether the line ends inside template text, from the template literal tokens' extents.
   - `blockAtEnd`: whether the line ends inside a TypeScript block comment.

   The reader's interpolation arm becomes a lookup, `if (closes.has(i))`. It is tested ahead of the quoted-value and dollar-span branches, because TypeScript interpolates wherever template text holds a `${`. A close on a later line is refused rather than copied: it is recorded in `BlankedCode.unclosed` and reported by 'every interpolation closes on the line it opens'.

3. **Find comments by scanning the trivia gaps between leaf tokens.** Asked at each node, the comment-range API missed two kinds of comment: one before a token that is no node (a closing `}`, `)` or `;`), and one trailing code on its line. So:
   - Walk the leaves via `getChildren(sf)` and scan the gap before each one.
   - Skip JSDoc nodes, or a doc comment's text is a child node rather than trivia.
   - Scan trivia once more to `text.length` at the end. A doc comment trailing the file is a child of the end-of-file token, so that token is no leaf.

4. **Keep the hand-written reader's own state, and assert it agrees with the parser at every line end.** The reader still reads the SQL inside template text, which no TypeScript parser does, so it is not replaced. `templateDisagreements` compares at each line end:
   - Where TypeScript is in template text, the reader's template flag must be true.
   - Elsewhere the flag must be false, and the reader's block flag must equal `blockAtEnd`.

   Inside template text the reader's block flag means a SQL comment, which TypeScript does not see, so it is not compared there. The tree arm 'the reader agrees with TypeScript at every line end on template text and block comments' reports the first disagreeing line of each file. The parser is the oracle and the comparison is the detector. The comparison is also a loud detector rather than a silencing net: it reds and masks nothing. That is the distinction from the guard in `belt-and-braces-guard-absorbs-upstream-mutation-pins-2026-09-18.md`.

5. **Pin fixtures on agreement, not on a hider.** Each writer fixture asserts the writer scans and also that `disagreementIn(fixture)` is `[]`.

### Costs and limits

- **Same-line misreads are invisible to the agreement arm.** It compares state at line ends only, so a misread whose damage ends on its own line stays silent, for example `if (retries[id]-- > 0) await q('UPDATE accounts SET updated_at = NOW() ...')`. Record such a misread as a residual. The remaining lever is to move more of the reader's TypeScript layer onto the same view: the main-path template flag, the regex judgement, TypeScript comments and strings.
- **The parser's answers are only as good as the parse.** `createSourceFile` does not throw on a syntax error; it recovers and returns a tree, so on text that does not parse the view's answers are recovery guesses. The scanned tree is held to `npm run typecheck`, which is what makes the parser authoritative there. A fixture line that does not parse gets the recovery, not an answer.
- **Only TypeScript files get a view.** SQL has no interpolation, so `blankAll` gives a `.sql` file an empty view, and the agreement arm skips it.
- **The refusal costs a red on any future wrapped interpolation**, harmless or not. Neither tree wraps one today; about 100 dependency files do.
- **A pin that relied on a specific hider can stop discriminating when the reader changes.** The writer fixtures were hidden by a route-comment glob closed by a later `/** */`. Once SQL block comments nested as PostgreSQL's do, that `/**` counted one level deeper, so the hider failed and the writer surfaced for a reason unrelated to the fix under test. Asserting agreement pins the misread itself, whichever hider is used.

## Why This Matters

Nearly every silent pass the adversarial passes built exploited one class: a flag left wrong past the line that misled it. The agreement arm turns that class into a red bar naming the line, independent of what later construct hides the writer or restores the flag. It also made two pre-existing main-path misreads loud where they cross a line, which no fix to the interpolation arm would have found:
- `budget[k]--` read as a SQL comment
- a phantom regex after `n!!` eating a `//`

The one silent pass it does not reach is documented as a narrowing: a comment in a token gap of a write spelled inside an interpolation.

The parser-backed view was verified, not assumed:
- **TypeScript oracle, 1,112 real files:** 0 template-flag mismatches at about 298,000 line ends, and 0 misjudged interpolation closes. The hand-written close had 2, both the `frontend/src/editor.js` shape `"${latex.replace(/"/g, '&quot;')}"`.
- **The agreement arm:** 0 disagreements in backend/src, backend/tests and frontend. Over 13,912 dependency files it reds 110, all explained: 99 wrapped interpolations, 5 known main-path misreads, and 6 from a view gap that was then fixed.
- **No behaviour change:** the blanked output stayed byte-identical on all 119 scanned files.
- **Mutation:** a 73-mutant corpus over the added code went red, 72 by assertion and 1 by hanging.

The choice follows a precedent the canary already had (session history). When a second reader re-judged span boundaries on its own and disagreed with the first, the fix was to have one component decide and every other reader replay that decision (`SpanEvent`). Taking TypeScript's boundaries from TypeScript is the same move one level down. `typescript` is already a backend devDependency, and the sibling canary `no-unresolvable-carve-out-companion-citation.test.ts` already parsed its sources this way, so the parser added no dependency.

## When to Apply

- A test or lint-like scanner reads TypeScript or JavaScript as text and must decide template, string, comment, regex or interpolation boundaries.
- You are about to add a regex-versus-division rule, an operand-ending pattern, a brace-depth counter or a quote stack for TypeScript text.
- Adversarial review keeps finding new silent shapes in the same class after each heuristic fix.
- The scanner carries state across lines, where a wrong value past one line silences the lines below it.
- This is not a reason to add a canary. PEvO's bar is a canary only where the code cannot be tested and review would likely miss the violation; this is how to make a justified canary's reader sound.

## Examples

Before, the hand-written close (main path only):

```ts
if (char === '$' && next === '{' && !sql && template) {
  const end = interpolationEnd(line, i); // brace depth, quote stack, backslash skip
  if (end !== -1) { out += line.slice(i, end); i = end; continue; }
}
```

After, the parser supplies the close (in `typescriptView`), and the reader looks it up (in `blankLine`, ahead of the value and dollar branches):

```ts
if (ts.isTemplateExpression(node) || ts.isTemplateLiteralTypeNode(node)) {
  let before: ts.Node = node.head;
  for (const span of node.templateSpans) {
    const open = before.getEnd() - 2;        // the `${`
    const close = span.literal.getStart(sf); // its `}`
    const line = lineOf(open);
    closes[line].set(open - starts[line], lineOf(close) === line ? close - starts[line] + 1 : -1);
    before = span.literal;
  }
}

if (closes.has(i)) {
  const end = closes.get(i) ?? -1;
  if (end !== -1) { out += line.slice(i, end); i = end; continue; }
  unclosed.push(i);
}
```

The agreement assertion, in `templateDisagreements`:

```ts
const at = lines.findIndex((_line, i) =>
  view.templateAtEnd[i]
    ? code.template?.[i] !== true
    : code.template?.[i] !== false || code.block?.[i] !== view.blockAtEnd[i],
);
if (at !== -1) found.push(occurrenceAt(rel, lines, at));
```

Spellings that defeated a hand-written rule:

- `` const msg = `unknown user '${who ? `${who}'s alias` : null}'`; ``: the interpolation sits inside a quoted value. The nested template's opening backtick ended the outer template, the apostrophe opened a phantom value, and the line ended with the flag inverted. The next line's `// rate-limited like the other /api/admin/* routes` then opened a block comment over the writer.
- `const half = n!! / 2; // like the /api/admin/* routes`: `!!` was not in the operand-ending set, so the slash opened a regex that ran to the `//`, and the comment's prose became code. Now pinned: the agreement arm reds the line.
- A trailing-dot number (`1. / 2`) inside an interpolation: the same misread, a regex that swallows the template's closing backtick.
- `if (ready) /x/.test(v)`: after a control-flow `)` the pattern reads as a division, and a quote inside it opens a value.

## Related

- `source-discipline-canary-comment-normalization-and-lens-vs-probe-coverage-2026-09-08.md`: the same canary and reader. It introduced the terminal-state assertion. This learning adds the per-line-end comparison for a misread that a later line undoes, which the terminal state cannot show.
- `belt-and-braces-guard-absorbs-upstream-mutation-pins-2026-09-18.md`: the same canary's regex-or-division rule and its residuals. Its assumption of a complete operand list did not hold (`x!!`, `1.`, a combining-mark identifier, `f<string>`). The agreement arm is a detector, not the kind of silencing net that doc warns against.
- `source-discipline-canary-detection-must-survive-ordinary-authoring-shapes-2026-08-31.md`: resolving ambiguous openers toward code. A wrong boundary call on carried state can still blank code downstream, which the agreement arm catches where it crosses a line.
- `new-fail-closed-outcome-must-not-reuse-an-existing-sentinel-2026-09-15.md`: its re-enumerate-the-reporting-arms rule is what the wrapped-interpolation refusal applies.
- `sql-grammar-questions-are-settled-against-a-nonexistent-relation-2026-09-16.md`: the SQL form of the same principle. A grammar fact a canary depends on comes from the language's real implementation, not from reasoning.
- `final-state-assertions-cannot-discriminate-dispatch-from-confirmation-2026-09-01.md`: the general form. An end-state check cannot see a transient wrong state that converges.
