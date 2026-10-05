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

## Backend implementation signal (2026-10-01, commit 930820cc)

Decision: a hybrid of the two candidate directions. Two designs were
measured on isolated copies, and the two judges split:
- A confusable set for every script loses recall against today's rule.
  Lisu and Coptic carry exact Latin capitals (`U+A4E3` reads as R,
  `U+2CA2` as P).
- An allowlist of notation shapes needs a slash rule and line-wrap token
  logic, and it still refuses `µs/op`.

The hybrid narrows only Greek, the one script where honest notation lives.
Every other script keeps the whole-script rule.

Trigger set (`mixedScriptWords`): a word holding a Latin letter plus either
(a) any letter outside Latin and Greek, or (b) a Greek letter whose base
letter, accents stripped, is in `GREEK_LOOKALIKES`.
- `GREEK_LOOKALIKES` holds the 30 Greek letters whose UTS #39 prototype is
  one ASCII letter, keyed by NFKC image. An independent derivation from
  `confusables.txt` matched it exactly.
- Capital sigma is included because the lunate capital sigma, which renders
  as C, folds to it. So `Σi` glued to Latin is refused, a recorded cost.
- Widening to non-ASCII Latin prototypes was measured and declined. It
  would refuse delta, epsilon, phi, beta and capital lambda, and their
  Latin twins (small-capital T, open e) already pass at HEAD.

Adversarial verify (three lenses: neuters, escape hunt, docblock truth),
with findings fixed:
- Accented Greek (tonos, breathing) escaped by passing as a non-member.
  Closed by the base-letter lookup. With `baseOf` neutered to identity the
  accent probe goes red.
- The residual sentence was wrong. It now names four residuals: a
  single-script word; Latin-script look-alikes NFKC does not fold; Greek
  letters with a non-ASCII Latin confusable (pinned as passing beside their
  Latin twins); and non-letter symbols, which split the word.
- Reworded the `auditSources` docblock and the failure message, the
  "basic (ASCII) Latin letter" wording, and "every Greek letter" instead of
  "every Greek entry".

AC 1: `250µs`, `250μs`, `Δt`, `10 kΩ` and `πr` pass, by direct probe and
end to end in the synthetic `auditSources` source (`mixed` stays 1).

AC 2: the Cyrillic probes, `Müller` and `Петров` are unchanged. Greek
omicron in `companion`, alpha in `Real` and upsilon in a filename are
refused.

AC 3: each run below was alone on an isolated copy.

| Mutant | Result |
|---|---|
| alpha removed from the table | red |
| final sigma removed from the table | red |
| capital Sigma removed from the table | red |
| Greek exemption removed | red, 2 failed, incl. the synthetic `mixed` count |
| other-script arm removed | red, 2 failed |
| Latin test removed | red, 2 failed |
| member added to the table | red via the set-equality pin |
| `baseOf` neutered to identity | red |

AC 4: the header normalisation paragraph, `normalizeCommentText`,
`GREEK_LOOKALIKES` and `mixedScriptWords` docblocks were checked against
measured behaviour.

AC 5: canary green (12/12, exit 0) and `typecheck:tests` clean.
`LANDING_*`, the deferred maps and `LANDING_DIGEST` are untouched. The
non-self census is identical to HEAD.

## Architect re-review (2026-10-05) — HELD PENDING FIXES:

Reviewed `930820cc` via `/ce-code-review` (focused: orchestrator correctness, standards and
requirements read plus one independent in-process adversarial read). Verified on isolated
copies: canary 12/12, exit 0, at `930820cc` and at its parent. All eight mutants in your table
reproduce. Four extra mutants are red as well: `baseOf` keeping marks, upsilon removed, small
iota removed, and NFKC dropped from the normaliser. The 30-letter `GREEK_LOOKALIKES` equals an
independent derivation from `confusables.txt` v18.0.0 under the table's stated rule, and the
"Of the ones it folds" sentence is exact. AC 1, 2, 3 and 5 are met. Two items remain under
AC 4, both in `backend/tests/eslint/no-unresolvable-carve-out-companion-citation.test.ts`.

1. **Eta and theta hide the label, and no residual names them.** `confusables.txt` maps eta
   (U+03B7) to `n` followed by U+0329 COMBINING VERTICAL LINE BELOW. It maps small theta
   (U+03B8), capital theta (U+0398), the theta symbol (U+03D1) and the capital theta symbol
   (U+03F4) to `O` followed by U+0335 COMBINING SHORT STROKE OVERLAY. The table's rule, a
   prototype that is one ASCII letter, leaves all of them out. `normalizeCommentText` drops
   combining marks, so their Latin twins (`n` + U+0329, `O` + U+0335) reach the patterns as
   plain `n` and `O` and are caught, while the Greek letter passes. Measured in review:
   `// Real-path companioη: settings.test.ts covers the rest of the gate.` and
   `// REAL-PATH CΘMPANION: settings.test.ts ...`, planted under `tests/routes/`, are green at
   `930820cc` and red at its parent. The same two plants spelt in ASCII, and spelt with the
   Latin twin, are red at `930820cc`. So the header's list of four residuals is incomplete, and
   the `normalizeCommentText` docblock's claim that the header's normalisation paragraph lists
   the residual is false.
   Fix: derive the table the way the check reads text. The rule becomes a Greek letter whose
   prototype, with combining marks removed, is one ASCII letter. Re-derived in review from the
   same `confusables.txt`, that rule yields exactly the current 30 plus eta (under `n`) and
   small and capital theta (under `O`). The two theta symbols fold to those two under NFKC, and
   an accented eta reaches eta through `baseOf`. Add the three letters to `GREEK_LOOKALIKES` and
   to the probe's independent copy, so the per-member loop and the set-equality pin cover them.
   Add the eta and capital-theta label spellings above as refused probes. Reword the table
   docblock and the header's normalisation paragraph to the rule with marks removed. The cost:
   a theta glued to a Latin letter as notation (for example `cosθ`) is now refused, as rho and
   sigma glued to Latin already are. Name it beside them in the `mixedScriptWords` docblock's
   cost sentence.

2. **"none of which a comment in this corpus has a reason to contain" measures false.** The
   first residual, a confusable that is a single-script word of its own, is in the corpus
   today: a standalone Greek alpha (U+03B1, a `GREEK_LOOKALIKES` member) names review clusters
   in `lib/logger-redact.test.ts` and `startup-checks.test.ts`. Neither hides anything. The
   parent commit's header carried the same claim in shorter words, and this diff restates it
   over four residuals. Fix: replace the clause with a statement you have measured against the
   corpus, or drop it.

Keep AC 5 as it stands, and re-measure the non-self census after item 1, since the corpus
holds standalone and hyphen-split Greek (α, δ, Φυσική). Anchor any new comment on stable
symbols only. The reverse-declaration task is also held on this file; land the two one at a
time.
