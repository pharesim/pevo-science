---
title: "A guard downstream of a rule absorbs that rule's mutants, so mutant-green can mean the net caught it rather than the rule being unpinnable"
date: 2026-09-18
last_updated: 2026-09-22
category: conventions
module: backend/tests/eslint
problem_type: convention
component: testing_framework
severity: high
related_components:
  - development_workflow
applies_when:
  - "Adding a belt-and-braces guard, fallback or recovery path downstream of a rule whose conditions a canary already pins by mutation"
  - "A guard rejects a candidate on the reasoning that no valid input looks like this anyway, placed after the rule it backstops"
  - "A mutation pass reports that several previously-pinned conditions have all become undiscriminable at once"
  - "A new guard cannot itself be discriminated by any valid-code fixture, only by a shape engineered to hit it"
  - "Deciding whether to keep a defence-in-depth layer inside detection logic that a canary is the only checker of"
tags:
  - canary-tests
  - mutation-resistance
  - defense-in-depth
  - source-discipline
  - vacuous-pin
  - masked-observable
  - regex-reading
---

# A guard downstream of a rule absorbs that rule's mutants

## Context

`backend/tests/eslint/no-accounts-updated-at-write-outside-signup-finalize.test.ts` is a standing
source-discipline canary. It reads `backend/src` and `backend/migrations` as text and asserts that
`accounts.updated_at` is written by exactly the two signup finalizes. Because the scan is textual,
its soundness rests entirely on a hand-written reader: the comment and value blanker `blankLine`,
and the statement reader `statementAt`. Anything the reader mis-blanks is source that never gets
scanned, and a write hiding in that span passes silently.

What keeps such a reader honest is mutation. Every reader feature is expected to have a fixture that
goes red when the feature is deleted, and the fixture works by planting an ordinary writer in the
affected span and checking the scan still sees it. "This mutant reds" and "under this mutant an
ordinary writer goes unseen" are the same measurement from two sides.

The round that produced this learning taught the blanker to read TypeScript regex literals, so that
a quote inside a pattern is a character of the pattern rather than the opener of a phantom string
value. Whether a slash starts a pattern or divides is decided by two constants, `OPERAND_END_RE`
(after an operand, a slash divides) and `PATTERN_KEYWORD_RE` (after a keyword, it opens a pattern),
both applied by `regexLiteralEnd`, which then walks forward to the closing slash.

Alongside them the round added a belt-and-braces guard inside `regexLiteralEnd`: when the candidate
closing slash was followed by `/` or `*`, reject the pattern, on the reasoning that no valid regex
literal ends that way and what does end that way is a comment opener. The guard was useful on its
own terms. A misjudged division opens a pattern that runs to the next slash on the line, which in
ordinary source is routinely the opener of a trailing `//`; once that opener is swallowed the
comment's prose is read as live code, and a path glob in that prose opens a block comment that
blanks every line below it until the next closer, writers included. The guard capped exactly that.

That is the shape the friction came out of: a rule that fixtures pin, and a downstream net that
catches the rule's failures. This canary has a documented history of fixtures that turn out not to
discriminate what they claim, including one found live in an earlier round where a merged
closer-search fixture's two boundary values coincided under both implementations, making the pin
vacuous until a fixture with genuinely divergent boundaries replaced it (session history).

## Guidance

When you add a guard, fallback or recovery path downstream of a rule that fixtures already pin,
treat the neighbouring pins as suspect until you re-measure them.

**Re-run the discrimination of every pin near the new guard, not only the pin for the guard itself.**
Ask each neighbouring condition the original mutation question: delete one token from it, and does
its fixture go red? If it goes green where it went red before, the guard is masking that pin. The pin
is still in the file and still passes; it has stopped measuring the thing it was written to measure.

**Treat a mutant that turns green after adding a guard as a defect in the verification, not as
evidence that the condition is unpinnable.** The two look identical from the test report: the suite
is green under a mutant, and the honest-looking conclusion is "this condition cannot be discriminated
by valid code." Only re-running the same mutant with the guard removed tells them apart.

**Prefer a pinned rule over an unpinnable net.** A guard no valid-code fixture can discriminate is a
guard whose presence or absence no test can detect, and it buys that untestability at the cost of
making the rules around it untestable too.

**A loud detector is not a net.** An assertion that reds when the reader disagrees with an
independent oracle hands back no answer in the rule's place, so it cannot rescue a mutant: it turns
the mutant red. That is the shape to reach for when a rule's damage has to be caught rather than only
recorded, and it is what this canary later did with TypeScript's parser as the oracle.

**Record the damage a misjudgement causes in prose rather than catching it with a net nothing can
test.** A KNOWN LIMITS entry naming the shape still misjudged, what it costs, and why neither tree
spells it is worth more than a guard that silences the same shape invisibly. The next author reading
the limit knows what they are trading; the next author reading the guard sees only a green suite.

**Widen the rule in the same change that removes the net.** Removing the guard without completing the
rule it protected trades a masked pin for a real silent pass. The two moves belong together.

## Why This Matters

The canary's whole value is that a future edit to the reader reds a bar. Nothing else checks the
reader, because the reader is the checker. A pin masked by a downstream net looks exactly like a
working pin in CI, so the failure is invisible until someone needs it.

The concrete cost: a future author narrows the rule for a reason that reads perfectly well locally,
and the suite stays green. The narrowed rule misjudges some ordinary construct, the blanker blanks a
live span, and the source below that span stops being scanned. The canary still passes, but it is
passing over source it no longer reads, and a write to `accounts.updated_at` landing in the unscanned
region is exactly what the file exists to catch.

The masking also corrupts the record. Once a cluster of conditions reads as "cannot be
discriminated," the natural next step is to write that conclusion into the file as a documented
limit, converting a measurement artefact into a permanent and wrong claim about the reader.

And against the fixtures the round had, the guard gave nothing back. None of them could discriminate
it, because every misjudged division it caught needed a prior the operand list was believed to cover
completely, so the net was catching only mutants, which is to say only the tests. The list was not in
fact complete. Later adversarial passes found valid TypeScript priors it does not carry (`x!!`, a
trailing-dot `1.`, an identifier ending in a combining mark, `f<string>`), and a net like this one
would have silently rescued some of them. The recommendation stands regardless, because what held in
the end was neither a longer list nor a net but taking the fact from a parser and detecting
disagreement loudly (see `canary-reader-takes-typescript-facts-from-the-parser-not-a-hand-written-lexer.md`).

This sharpens a rule this canary's history already carries: deleting a feature and watching its
dedicated fixture red proves the fixture and the feature are wired together, and nothing more. It
does not prove the fixture exercises the intended path, that the pinned behaviour is the correct one,
or that a sibling reader got the same fix (session history).

## When to Apply

Apply whenever detection logic that a canary is the only checker of gains a new conjunct, fallback,
defensive clause or recovery path near an already-pinned rule. This repo carries nine such canaries
under `backend/tests/eslint/`, each with the same structure: a rule that decides something, and
fixtures that pin each condition by deleting one token from it.

The shapes that should trigger a re-measurement:

- A new "this cannot legitimately happen, so reject" clause placed after a decision the rule already
  makes. That was the closing-slash guard.
- A fallback substituting a safe answer when the primary rule produces a suspicious one. The safe
  answer is frequently the same answer the correct rule would have given, which is what makes it mask
  the rule's mutants.
- A second, independent check of the same property downstream of the first. Defence in depth is a
  runtime virtue and a verification hazard: two independent checks of one property mean neither one's
  failure is observable.
- Any mutation pass reporting that several previously-pinned conditions became undiscriminable at
  once. A cluster is stronger evidence of a new net above them than of a genuine property of the
  language being scanned.

It does not apply to a guard catching a shape the rule was never responsible for, since there is no
neighbouring pin to mask. The test is whether the guard and the rule can fail on the same input.

## Examples

The guard was tried in the working tree and removed before the change was committed, so no committed
revision of the file carries it; the removal commit's message is the surviving record. Its shape
inside the scan loop of `regexLiteralEnd` was:

```ts
    } else if (c === '/') {
      // no valid regex literal ends against a comment opener
      if (line[j + 1] === '/' || line[j + 1] === '*') return -1;
      return j + 1;
    }
```

What the close looks like now, with the rule carrying the weight instead:

```ts
    } else if (c === '/') {
      return j + 1;
    }
```

`OPERAND_END_RE` now covers Unicode identifiers, digits, and closing `)`, `]`, `}`, quote and
backtick, with TypeScript's non-null assertion and postfix `++`/`--` admitted only where an operand
precedes them, so the prefix `!` of `!/re/.test(v)` still opens a pattern. `PATTERN_KEYWORD_RE`
carries the keyword set behind a lookbehind that keeps out a property of the same name
(`obj.return / 2` divides) and a name merely ending in one (`noreturn / 2`). `codeBefore` supplies
the previous line carrying code when a slash leads its own line. The residual misjudgements, and what
each costs, are written into the KNOWN LIMITS bullet. Any whose damage crosses a line end is now also
caught, by an arm comparing the reader's template and block state with TypeScript's parser at every
line end.

A mutant that was green with the guard and reds without it: take the division fixture
`const half = total! / 2 /* note */;`, which asserts through `scanned` that only the `/* note */`
span is blanked. Mutate `OPERAND_END_RE` by deleting its postfix group. Reproduced standalone against
the head constants:

```
real rule,   no guard   DIVISION (comment stays a comment -> fixture green)
mutant rule, no guard   PATTERN "/ 2 /" swallows the /* opener -> fixture RED
mutant rule, GUARD on   DIVISION (comment stays a comment -> fixture green)
```

The mutant misjudges the division after `total!` as a pattern. That pattern runs to the next slash,
which is the `/` of `/*`, so its close lands on a comment opener and the guard rejects it, handing
back the same `-1` the correct rule would have returned. The fixture passes, and the condition reads
as undiscriminable.

Eight one-token mutants behaved this way in the round's mutation matrix: six of `OPERAND_END_RE`
(the postfix group, `!`, the quote members, `}`, digits, the Unicode class), the lookbehind of
`PATTERN_KEYWORD_RE`, and the walk-back in `codeBefore`. A ninth green mutant in the same matrix was
the guard itself, which is the separate observation that the net was undiscriminable. With the guard
removed, seven redded immediately; the eighth, the Unicode class, needed its own fixture corrected
first, because the identifier it used (`média`) ends in an ASCII letter and so never reached the
Unicode branch. That correction is itself the general point in miniature: a fixture that passes for
the wrong reason and a fixture rescued by a net are both pins that measure nothing.

## Related

- `defense-in-depth-canary-must-pin-each-layer-2026-05-07.md` prescribes the opposite remedy for a
  neighbouring shape: when a canary bypasses an upstream layer to reach a downstream branch, add a
  companion canary that discriminates layer-present from layer-absent. That prescription assumes the
  layer is discriminable. This entry is the case where it is not, and where the correct move is to
  delete the layer and complete the rule instead. Read the two together: add a companion canary when
  the layer can be pinned, remove the layer when it cannot.
- `shared-constant-unification-is-not-membership-coverage-2026-09-16.md` is the same canary and the
  same family of illusion: a structural change that stops two consumers drifting from each other
  proves nothing about the constant's membership. There the mechanism looked like coverage; here a
  net supplied the coverage the fixture was supposed to supply.
- `composite-mutation-probe-does-not-cover-its-constituent-branches-2026-09-06.md` is the principle
  one construct over: deleting a whole mechanism proves it is load-bearing, not that each branch is
  individually covered. A downstream net is how an individual branch's mutant gets rescued.
- `source-discipline-canary-comment-normalization-and-lens-vs-probe-coverage-2026-09-08.md` covers the
  neighbouring failure where a prescribed probe list only confirms what it names. The distinction
  worth keeping: there the probe never ran the evasion, here the probe ran correctly and the
  observable was masked before any fixture could see it.
- `tests-must-fail-on-mutation-of-code-under-test-2026-04-22.md` is the root convention this refines.
- `canary-reader-takes-typescript-facts-from-the-parser-not-a-hand-written-lexer.md` is where the operand list's incompleteness led: the
  interpolation close comes from TypeScript's parser, and a loud agreement check catches the damage a
  misjudged division does across a line end, without masking any pin.
