# The carve-out canary's mixed-script check refuses honest unit and math symbols

**Owner:** backend
**Created:** 2026-10-01

## Why

`mixedScriptWords` in
`backend/tests/eslint/no-unresolvable-carve-out-companion-citation.test.ts`
flags every word that mixes Latin letters with letters of any other script. It
runs on every comment under `backend/tests`, not only on labelled clause-(c)
blocks. It exists to catch a look-alike letter that hides the label or a
filename from the regexes, such as a Cyrillic `а` inside `Real-path`.

Its reach is wider than that purpose. `normalizeCommentText` applies NFKC
first, and NFKC folds the micro sign U+00B5 to Greek mu U+03BC. So `250µs`,
the SI spelling of microseconds, becomes a Latin-plus-Greek word, and so does
`Δt`. Neither is a look-alike for any Latin letter.

Measured on 2026-10-01 against an isolated copy of HEAD:
`mixedScriptWords(normalizeCommentText('waits 250µs, then Δt elapses; 250μs too; plain 250us'))`
returns `["μs","Δt","μs"]`.

The verdict cannot be waived. `auditSources` collects mixed-script words
before any block is classified, so the ALLOW_MARKER does not exempt them, and
no backlog map covers them. The only remedy available to an author is the
ASCII spelling. No file trips this today, since the canary is green. A
symbol-carrying comment in a timing-sensitive suite is the shape that will. A
guard that accuses honest text is the guard that gets marked or deleted.

The `mixedScriptWords` docblock already records this as a deliberate deferral:
"which scripts are confusable is a decision worth taking deliberately". This
task takes that decision.

## Scope

1. Decide which characters the check refuses. Measure each candidate against
   the corpus and the existing look-alike probes before choosing. Candidate
   directions, not a prescription:
   - Refuse only letters whose glyphs are confusable with Latin letters, such
     as the Cyrillic and Greek letters that render like `a`, `e`, `o`, `p`,
     `c`, `x`.
   - Keep the script rule, but exempt a named set of unit and math symbols
     (the micro sign and its NFKC image, `Δ`), either before NFKC or as an
     allowlist after it.

   Do NOT restrict the check to labelled blocks. A look-alike letter inside
   the label is what makes a block read as unlabelled in the first place, so
   that restriction reopens exactly the escape the check exists to close.
2. Implement the decision.
3. Record the reasoning in the `mixedScriptWords` docblock and in the
   header's normalisation paragraph, replacing the "blunt instrument"
   paragraph with a description of the trigger set the code now has.

## Acceptance criteria

1. A comment under `backend/tests` containing `250µs` or `Δt` no longer fails
   the canary, pinned by direct probes.
2. Look-alike letters are still refused. The existing probes stay green: a
   Cyrillic `а` in `Real-path`, a Cyrillic `е` in `settings.tеst.ts`, and the
   negative cases `Müller` and `Петров`. Add at least one Greek look-alike
   case (for example a Greek omicron in `companion`) that must still be
   refused.
3. Each member or rule of the chosen confusable set has a probe that goes red
   when that member alone is removed.
4. Every docblock and header sentence about this check describes the trigger
   set the code has, verified against measured behaviour.
5. The canary is green. `LANDING_FREE_PROSE`, `LANDING_FILELESS`, both
   deferred maps and `LANDING_DIGEST` are untouched.

## Notes

This task and two sibling tasks edit the same canary file:
`backend-carve-out-canary-reverse-declaration-in-mocking-file` and
`backend-carve-out-canary-loose-claim-accuses-docblock-example`. Land them one
at a time. Anchor any comment you write on stable symbols, never on line
numbers, task slugs or round numbers.

Reproduce the measurement on a probe copy, never the shared checkout: build
it per the backend probe recipe (`git archive HEAD backend`, symlinked
`node_modules` and `.env`, `tests/setup.ts` replaced by `export {};`). Then
append an `it()` to the copied canary that writes `mixedScriptWords(...)`
output to a file with the already-imported `writeFileSync`. Console output is
silenced in this suite.
