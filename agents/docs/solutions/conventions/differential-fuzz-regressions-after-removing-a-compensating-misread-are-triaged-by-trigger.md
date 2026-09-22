---
title: "When a fix removes a compensating misread, a base-versus-head differential's regressions are triaged by their trigger, and the chase stops once every remaining one needs a documented misread"
date: 2026-09-22
category: conventions
module: backend/tests/eslint + code-review process
problem_type: convention
component: testing_framework
severity: high
related_components:
  - development_workflow
  - code-review
applies_when:
  - "A fix removes a misread in a scanner, parser or canary reader, and a base-versus-head differential fuzz reports cases the base tree caught and the head tree now misses"
  - "Deciding whether a reported regression is the fix's own fault or a pre-existing gap that the removed misread had been catching by accident"
  - "Each fix of a reported regression exposes the next shape, and the review loop needs a stopping rule before it reopens again"
  - "Writing a KNOWN LIMITS entry or a re-review signal that must justify leaving some base-caught, head-missed cases unfixed"
  - "Designing a differential fuzz whose counts a reviewer will act on (parser-gated validity, reference-lexer liveness, per-family counts, improvements and silent-in-both reported beside regressions)"
symptoms:
  - "A base-versus-head differential fuzz reports thousands of regressions (base red, head silent) after a fix that closed a real silent pass"
  - "Fixing one reported regression class exposes the next, because each fix removes another compensating misread that had been reddening shapes by accident"
  - "A base-red fixture was reddened by an arm unrelated to the writer, the end-state arm firing because a misread left a span open, not by the writer scan"
  - "Ordinary-code fixture families show 0 regressions while escape-quirk, multi-line-value and dollar-quoted-data families show thousands"
root_cause: missing_workflow_step
resolution_type: workflow_improvement
tags:
  - canary-tests
  - source-discipline
  - differential-testing
  - fuzzing
  - adversarial-review
  - review-triage
  - accidental-coverage
  - stopping-rule
---

# After a fix removes a compensating misread, triage each base-versus-head "regression" by its trigger

## Context

`backend/tests/eslint/no-accounts-updated-at-write-outside-signup-finalize.test.ts` asserts that `accounts.updated_at` is written only by two allowed statements. Its hand-written reader (`blankLine`, driven per file by `blankAll`) blanks comments and tracks templates, quoted values, dollar-quoted spans and interpolations. The writer scans then pattern-match the blanked text. A silent pass is a planted ordinary writer (`await q('UPDATE accounts SET updated_at = NOW() WHERE id = $1', [id])`) that leaves the suite green.

The review standard for this canary counts a REGRESSION as a planted plain writer that the base tree reds and the head tree leaves green. Regressions are held; documented limits are accepted. The hold that set it, the architect re-review dated 2026-09-21 in the task file, proved each case with:
- a base-versus-head pair
- a one-token control
- a bisect over the range

The fix under review changed how the reader met an interpolation inside a quoted value. Base had read it flat, and that misread ended some templates early. It turned out to be compensating for other misreads: base caught some shapes only because it was already wrong somewhere else. Four adversarial passes then ran a base-versus-head differential over generated fixtures. Every pass reported base-red, head-silent cases, and every fix of what they pointed at exposed the next shape.

An earlier round of the same canary shows the other side (session history). Its regressions were filed in their own bucket, above ordinary gaps, and triaged with the user. One of them was caught at base only by accident: base's cruder backtick toggling cancelled out a misread of a template nested inside an interpolation. It was fixed anyway, because its trigger was ordinary code. That is the rule below.

The sibling learning `canary-reader-takes-typescript-facts-from-the-parser-not-a-hand-written-lexer.md` covers the reader redesign itself. This one is the method one level up: how the differential's output was judged, and when to stop.

## Guidance

1. **Classify each base-red, head-silent case by its trigger, not by the count and not by how base caught it.** There are two kinds:
   - **Ordinary code, with nothing documented involved.** This is a real regression. Fix it, even when base's catch was itself accidental. The hold's own case was this kind: a quoted interpolation holding a nested template with a possessive apostrophe (``'${who ? `${who}'s alias` : null}'``), a `/api/admin/*` route comment, and a URL template. Every ingredient was house style, and holding it was right.
   - **A documented misread or an unusual spelling** that base caught only because a different, compensating misread happened to red the suite, often through an arm unrelated to the writer. This is an accidental catch, not a regression of the fix. Chasing it reopens the loop: fixing a compensating misread exposes the next shape it was hiding.

2. **Classify with evidence, not by reading the diff.** The method used in this work:
   - **Parser-gated fixtures.** A generated TypeScript fixture counts only if `ts.createSourceFile` reports zero parse diagnostics. Invalid code is neither a regression nor an improvement.
   - **A reference lexer decides whether the writer is live.** SQL fixtures were checked against a reference model of PostgreSQL's lexer. A writer that PostgreSQL reads as inside a comment or string is correctly silent; if base reds it, that is base's false catch.
   - **Minimise, then run two controls.** First a one-token control, which localises the trigger. Then a ROOT control that neutralises the suspected trigger (respell `E'\''` as `''''`, write a real line break for an escaped one, balance the tag), after which both trees must see the writer. If head stays silent under the root control, the trigger was misnamed; look again.
   - **Record which arm caught it at base.** A writer arm firing on the writer is a detection. The end-state arm ('the reader finishes every file it reads with no span left open'), or any arm unrelated to the writer, means a compensating misread left a span open, so the catch was accidental. The arm tells you HOW base caught it; the trigger still decides what to do.
   - **Report per fixture family**, with improvements (base silent, head red) and silent-in-both next to the regressions. Keep the ordinary-code families separate, so that "ordinary: 0" is visible rather than averaged away.

3. **Fix a compensating misread in scope when it is pre-existing and cheap, and surface it first.** The first pass found one. A SQL `--` comment on the same line as its template's closing backtick blanked the backtick with it. That gap was pre-existing (``q(`SELECT count(*) FROM sessions -- live ones only`)`` was silent at base too), but base's own misread had masked it on some lines. It was surfaced to the user, who chose to include the fix: the comment now ends at the template's closing backtick and at any escape spelling a line break. The task file records this under "User decision, 2026-09-21".

4. **Stop once both of these hold:**
   - every remaining base-caught, head-missed case needs a documented misread as its trigger
   - the ordinary-code families show zero regressions

   Then record the interplay and its measured counts in the scanner's limits documentation. Here that is the KNOWN LIMITS bullet beginning "SQL block comments NEST", which names the triggers and the differential of about 2.3 million fixtures. State in the review signal why the rest were not chased; here that is "Why nesting stays, and what it costs".

### Limits of the rule

- **It needs a real list of documented misreads, or it becomes an excuse.** Two of the four triggers that stopped this work were in KNOWN LIMITS before the differential ran: a backslash escape inside an `E'...'` string, and a string value that spans lines. The other two, an unbalanced tag inside dollar-quoted data and a comment closer spelled with an escape, were recorded during the work. Each was recorded only after a grep showed neither tree spells it, and the first after it was shown silent at base as well. Do not add a trigger just to absorb a regression. A new entry must be unusual, and must say what it costs.
- **An ordinary-code family must actually be in the fuzz.** A zero from a family that was never generated means nothing. Here these were generated:
  - in the third pass, the main, sqlc, deep, code and sqlfile families, and writers inserted into the real `backend/src` files
  - in the fourth, the broad TypeScript family (552,080 fixtures with a live writer)
- **The reviewer's standard still applies to ordinary code.** A case missing from today's tree is not thereby accidental; the hold's regression was missing too.
- **The ratio of improvements to regressions is not the test.** Improvements outnumbered regressions in every counted pass and every family, and one ordinary-code regression would still hold the fix.
- **A liveness verdict is only as good as the reference lexer.** Name the model the verdict came from.

## Why This Matters

The rule prevents two opposite failures.
- **Applied mechanically**, "base red, head green is a regression" never converges when the fix removes a misread that compensated for others. The second and third passes each fixed the compensating misreads the previous pass surfaced, and each revealed the next ones. The raw count grew from pass to pass while the set of triggers narrowed, so the count was never the signal.
- **Applied loosely**, "accidental catch" becomes a blanket dismissal that lets a real regression in ordinary code through, like the one the hold caught.

What separates the two is classifying by trigger, with a measured zero in the ordinary-code families. Recording the counts in KNOWN LIMITS and in the signal puts the reasoning where the next reviewer looks. The reviewer can then check each trigger class against the tree instead of taking "accidental" on trust.

## When to Apply

- A fix to a reader, lexer, scanner or lint rule removes a misread, and a base-versus-head differential shows cases that base reds and head leaves silent.
- A review hold defines a regression as base red, head green, and the fix touches state that other misreads interact with.
- Successive adversarial passes each find a new shape that the previous fix exposed rather than caused.
- Not when the scanner has no documented-limits list, or the differential has no ordinary-code family. Either gap has to be closed first.

## Examples

Pass-by-pass counts, as measured in this work (valid fixtures only):

| Pass | Valid fixtures | Regressions | Improvements | What the regressions needed |
|---|---|---|---|---|
| 1 (six lenses) | not counted | the `--` class | not counted | a pre-existing gap, fixed in scope |
| 2 | 747,573 | 28 | 15,312 | 3 classes, each a compensating misread |
| 3 | 792,331 | 4,658 | 22,412 | 3 classes; 0 regressions and 0 silent in the ordinary families |
| 4 (after nesting) | about 2.3 million | per family below | per family below | the four documented triggers only |

Pass 4's total counts every valid fixture (1,452,589 TypeScript and 838,248 SQL). The per-family rows count only the fixtures whose writer PostgreSQL reads as live, about 1.9 million, since a dead writer is neither kind of case. Per family (regressions / improvements / silent in both):
- ts broad, 552,080: 0 / 596 / 0
- tsT (escape quirks), 143,690: 31 / 533 / 4, all raw-versus-cooked escape spellings
- tsML (multi-statement template), 253,039: 2,580 / 11,080 / 4,894, all a SQL value spanning lines or an `E'\''` string
- tsD (DO body in a template), 230,199: 478 / 2,064 / 592
- sql (broad migrations), 316,746: 1,073 / 5,679 / 2,859
- sqlT, 165,714: 6,794 / 15,014 / 8,013
- sqlD, 232,724: 1,161 / 3,110 / 1,140

On PostgreSQL-valid SQL, head's comment extents match PostgreSQL's.

Three accidental catches:

- **A `--` on the closing-backtick line**, e.g. ``'${fmt(`x`)}' -- note``. Base ended the template early at the nested backtick, so the `--` fell in code mode and the real closing backtick survived. Head read the interpolation correctly; the `--` arm ran to the end of the line and blanked the backtick. It showed as base-red and head-silent, but the cause was the pre-existing `--` gap, which was cheap and so was fixed in scope.
- **A line break spelled as an escape** (`\x0a`, `\u000a`, `\u{a}`) in template text. Base's writer arms were silent. Only the end-state arm fired: base's `--` ran to the end of the line, blanked the template's closing backtick, and left the template open at the end of the file. Its root control writes the escape as `\n`, which both trees read as the line break it is.
- **Nesting widening a phantom from an `E'\''` string.** The reader does not honour the backslash, so it ends the string one quote early and drifts out of step with PostgreSQL. A `/*` inside real string data then reads as a comment opener. Flat counting ended that phantom at the first `*/`, the close of a balanced comment after it, so base read the writer below. Under nesting, that comment's `/*` counts one level deeper and the phantom runs on over the writer. Here base's catch did come from the writer arm. The trigger, not the arm, is what classifies it: the `E'\''` misread was documented before this work, and its root control respells the string `''''`.

## Related

- `canary-reader-takes-typescript-facts-from-the-parser-not-a-hand-written-lexer.md`: the reader redesign this differential verified.
- `new-fail-closed-outcome-must-not-reuse-an-existing-sentinel-2026-09-15.md`: its rule to run a fixture against the pre-change reader is the instrument this learning qualifies. A base red counts against the change when the trigger is ordinary code, not merely because base was red.
- `belt-and-braces-guard-absorbs-upstream-mutation-pins-2026-09-18.md`: the mirror image. There a downstream net made a mutant look green; here a compensating misread made a base look red.
- `source-discipline-canary-comment-normalization-and-lens-vs-probe-coverage-2026-09-08.md`: the lens-versus-probe discovery method these passes used, and the end-state arm whose accidental firing this learning teaches you to read.
- `source-discipline-canary-detection-must-survive-ordinary-authoring-shapes-2026-08-31.md`: the "ordinary author" bar the classification keys on.
- `perf-floor-drop-removes-incidental-security-predicate-2026-05-25.md`: the runtime-code analogue, where removing something that was incidentally catching a case is a change in its own right.
