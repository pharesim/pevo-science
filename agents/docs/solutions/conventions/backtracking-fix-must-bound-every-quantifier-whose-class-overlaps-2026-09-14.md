---
title: "Bounding the quantifier the report names is not enough: catastrophic backtracking stays open while any other unbounded run shares its character class"
date: 2026-09-14
category: conventions
module: backend/tests/eslint + code-review process
problem_type: convention
component: testing_framework
severity: high
related_components:
  - development_workflow
  - documentation
root_cause: incomplete_enumeration
resolution_type: code_fix
applies_when:
  - "Bounding a quantified run in a regex to defuse catastrophic backtracking, when the pattern is composed from several shared fragments"
  - "Reviewing a fix, or a docblock, that claims a pattern's match cost is now constant or linear"
  - "Authoring or editing a source-discipline canary whose detection is a regex over comment text rather than a parse"
  - "Two composed regex fragments have character classes that share a member, so the same character can be consumed by either"
  - "Sizing a timing probe for a synchronous hot path, where the failing case can outrun the test timeout without yielding"
symptoms:
  - "Label matching over a separator run grows four-fold per doubling of the run, invisible at the length the probe happens to use"
  - "The cheaper entry point is probed and the hot one is not, understating production cost by about half"
  - "An earlier round bounded the implicated runs and its docblock then claimed constant cost; measurement showed the cost was still quadratic"
  - "A run built from a character shared by two classes costs orders of magnitude more than the reported run, and does not return at all at moderate length"
  - "The canary stalls on an ordinary authoring shape, a section underline written directly against the label text"
tags:
  - canary-tests
  - source-discipline
  - regex
  - catastrophic-backtracking
  - incomplete-enumeration
  - overlapping-character-classes
  - timing-probes
  - code-review
---

# Bounding the quantifier the report names is not enough: catastrophic backtracking stays open while any other unbounded run shares its character class

## Context

`backend/tests/eslint/no-unresolvable-carve-out-companion-citation.test.ts` is a standing source-discipline canary. It scans every `.ts` file under `backend/tests` for the clause-(c) real-path companion citations the mock carve-out requires, and fails when a citation names a companion that cannot witness the risk class it was cited for. Its parsing is regex-driven: `LABEL_SRC` recognises the label, the fragment `QUALIFIER` recognises one qualifying word inside it, and `LABEL_SRC` is interpolated in turn into `forwardPattern` and `reversePattern`, which `citationsIn` runs over every comment block in every scanned file.

A section underline written directly against the label text is the adversarial input. The label partitions that run between its own quantifiers and explores every partition before the match finally fails for want of the word `companion`.

An earlier round had already been through this once. It bounded the dash-or-space runs and its docblock then asserted that those bounds "cap each run so the partitions are constant, not O(n)". The claim was false. The pattern was still quadratic, and the probe meant to pin the bound ran 400 dashes against a 250ms threshold and passed. A green probe on a still-quadratic pattern is worse than no probe: it converts an open question into a settled one, in a docblock later readers will trust.

Two details from that earlier round are worth carrying (session history). The probe was not merely too short, it was sized just under the knee: the same 400-dash input measured about 211ms cold against its own 250ms bound, roughly 84 percent of budget, while measuring around 31ms warm once the module-level scan had already exercised the pattern. A probe whose input sits near its own pass threshold cannot distinguish "bounded" from "still quadratic, just not yet over the line", and one whose result depends on whether the pattern is cold is not measuring what it claims to. Separately, the false docblock claim and the partial fix landed in the same change, so they reinforced each other and the next reader had no signal that one arm was unexamined.

This entry is about the second attempt, and specifically about why the obvious second attempt was also not enough.

## Guidance

**The unit of work is the pattern's full set of unbounded quantifiers, not the one the reported input implicates. The multiplier to hunt for is which pairs of those quantifiers have intersecting character classes, because those are the pairs that can partition the same stretch of input.**

Work it in this order.

**1. Enumerate every quantified run in the pattern, including the ones inside fragments it interpolates.** A pattern assembled from `String.raw` fragments hides its own quantifiers. Here the label's runs live in two places: `LABEL_SRC` carries the dash-or-space runs and an emphasis run on either side of the qualifier slot, and `QUALIFIER`, which `LABEL_SRC` interpolates, carries a qualifier word plus a wrapper run on each side of it. A reviewer reading only `LABEL_SRC` sees five of the nine runs that participate, and none of the four the qualifier slot can repeat.

**2. Write down each run's character class, then intersect them.** This is the step that was skipped, and it is the whole finding:

| run | class |
|---|---|
| separators in `LABEL_SRC` | `[\s-]` |
| emphasis, both occurrences in `LABEL_SRC` | ``[*_`]`` |
| qualifier word in `QUALIFIER` | `[\w-]` |
| qualifier opening wrapper in `QUALIFIER` | ``[(\[`'"*_]`` |
| qualifier closing wrapper in `QUALIFIER` | ``[)\]`'"*_]`` |

The underscore belongs to four of those five classes at once. It is a `\w` character, a member of the emphasis class, and a member of both wrapper classes. The backtick belongs to three, and the asterisk to three. Any character sitting in two or more classes is a partition seam: a run built out of it can be split between the two quantifiers in every possible way, and the engine will try all of them.

**3. Construct an adversarial run out of each intersecting character and measure, doubling the length.** Four-fold cost per doubling is quadratic. With the qualifier word left unbounded, `labelCount` on the label text plus N dashes measured:

| N | `labelCount` | `citationsIn` |
|---|---|---|
| 400 | 31ms | 62ms |
| 800 | 123ms | 251ms |
| 1600 | 505ms | 1042ms |
| 3200 | 2103ms | 4373ms |
| 6400 | 9289ms | 18673ms |

Textbook O(n^2), and invisible at the reported length.

**4. Bound every run, not only the implicated one.** The dash case in the original report was the cheap one. Underscores, which partition between the word class and the emphasis or wrapper classes, cost 5.7s at 400 characters and about eleven minutes at 1600, and did not return within 25s at 6400. With only the word class bounded, 6400 underscores still did not return. Per-configuration measurement at a 6400-character run, with the word class bounded in every row and the row naming which other runs were left unbounded:

| left unbounded | dashes | underscores | asterisks | backticks |
|---|---|---|---|---|
| nothing (landed) | 0.3ms | 0.4ms | 0.3ms | 0.3ms |
| emphasis runs | 0.3ms | 53ms | 13ms | 17ms |
| qualifier wrappers | 0.3ms | 5300ms | 0.5ms | 0.5ms |
| both | 0.3ms | >20s | 32ms | 35ms |

**5. Prefer a plain repetition bound over a cleverer character class, and place it past anything honest.** Two narrower fixes were proposed and both are worse than a bound:

- `\w[\w-]*`, meaning "a qualifier word begins with a word character", removes the pure-dash blow-up but is close to a no-op on the general shape. An alternating run of word characters and dashes stays quadratic at 472ms against a 477ms baseline at 19,443 characters, and through `citationsIn` it measures slower than the status quo. It is also a silent correctness regression: a label carrying a five-dash separator run goes from one label to zero, and with no colon in reach the block is then dropped rather than counted, which is exactly the silent-skip failure the canary exists to prevent.
- `[\w-]{1,24}` is linear but too tight. A 29-character qualifier naming a real exported function stops parsing and is then accused as an unparsed claim, and so is a 42-character one. The longest exported symbol name in `backend/src` is 42 characters, so a bound of 64 sits clear of every identifier the codebase can name.

Every finite bound costs something at its far side. Say so in the docblock, and place the bound where nothing honest reaches it.

**6. Bound runs; do not bound searches.** This is the boundary against the sibling lesson in `source-discipline-canary-comment-normalization-and-lens-vs-probe-coverage-2026-09-08.md`, which rejects a bounded lookahead for the opposite reason. The two are not in conflict. A bound on a SEARCH for a delimiter changes what the scanner concludes: past the bound it answers "not a comment" and reads that comment's prose as live source, which is a silent misread in the dangerous direction. A bound on a quantified RUN inside a classifier changes only which spellings still count as the label, so its far side is a recall edge you can enumerate, place, and probe. Read the two rules together or the prescription here looks like a regression of that one.

**7. Measure every entry point that embeds the pattern source.** `citationsIn` reaches the same `LABEL_SRC` through `forwardPattern` and `reversePattern`, runs first on every comment block, costs roughly twice `labelCount`, and had no probe at all. A probe on the cheaper entry point understates production cost by a factor of two and leaves the hot path unpinned.

**8. Size the probe as a window, not a threshold, and run two lengths shortest first.** A probe that is too short cannot catch the regression. A probe that is too long turns a failure into a hang: at 100,000 characters the quadratic pattern never returns, and because a regex match is synchronous it blocks the event loop, so the runner's own test timeout cannot interrupt it. A canary that looks hung gets disabled, which is the same outcome as no canary. Two lengths in one loop, short first, gives both properties: the short pass aborts the spec on the expensive regressions before the long pass ever runs, and the long pass catches the cheap ones. Here 6400 catches the word-class revert at 8.4s through the spec path, the same revert the table above measures at 9.3s in isolation, and the wrapper revert at 5.9s, while 100,000 catches the emphasis revert, which is only 53ms at 6400 and 4.5s at 100,000. Bounded, the slowest shape is 2ms to 3ms at either length against a 250ms threshold. Take the measurement warm, the way the spec will actually run it, and know which of warm and cold you quoted.

**9. Mutation-verify each bound, and make the restore path a guard rather than a habit.** Eleven mutants were applied one at a time to an isolated copy, run, then restored with a byte-comparison against a gold copy before the next went in. A run whose restore path was misconfigured refused every mutant rather than probing a dirty tree, which is the behaviour to build in: a mutation harness that cannot prove it restored cleanly must decline to report.

Ten mutants went red, each failing within seconds. One survived: reverting only the trailing emphasis run's bound leaves the suite green, because that run is linear on its own. It backtracks n ways with a constant check after it, not n by m. It stays bounded anyway so the invariant "every quantified run in the label is bounded" holds by construction rather than by a neighbour's bound, and the signal recorded it as not independently pinned rather than claiming coverage.

All measurement was done on isolated copies of `backend/tests`, never in the shared checkout.

## Why This Matters

A ReDoS-style report names one input, and the named input is usually the cheapest member of its family. Fixing the quantifier that input implicates produces a pattern that is green on the reported case and far worse on a neighbouring one. Here the reported dash run cost nine seconds at 6400 characters while the unreported underscore run of the same length did not return at all, and the fix that satisfied the report left it untouched.

Character-class intersection is the mechanism that makes this predictable rather than a matter of luck. Two adjacent unbounded quantifiers only multiply if some character can be consumed by either, so the intersection of their classes is precisely the set of characters an attacker, or an innocent section underline, can use to build the pathological run. Enumerating the classes and picking out the characters that belong to more than one turns "try some inputs and hope" into a finite checklist.

The docblock consequences matter as much as the runtime ones. The first round's claim that the partitions were constant was load-bearing prose in a file whose entire purpose is to stop unverifiable prose from standing in for verification. A canary that asserts its own cost bound and is wrong about it launders the defect. Nothing in the knowledge store would have caught it either: before this entry, no learning here covered what a canary costs to run, only whether its claims are true.

And the probe-sizing failure mode is symmetric in a way that is easy to get wrong in one direction only. Too short is a false green. Too long is a hang no test timeout can break, because the work is synchronous, and a hanging canary gets commented out. Both ends are failures of the same design decision, so the design has to satisfy both at once.

## When to Apply

- Fixing any catastrophic-backtracking or ReDoS finding, whether reported by a scanner, a review lens, or an observed slow test.
- Editing any regex assembled by interpolating shared `String.raw` fragments, where the quantifiers that participate are not all visible in one place.
- Reviewing a change that claims to have made a pattern linear. Ask which runs were enumerated, not which run was fixed, and ask whether the classes were intersected.
- Sizing a timing probe for any synchronous hot path, where the failing case can exceed the test timeout without yielding.
- Adding a quantifier bound to a pattern that classifies text for a guard, where failing to match is a silent skip rather than a visible error. The bound's far side is then a recall regression, and it needs its own probe.

## Examples

**The pattern, before.** Four runs use `*` or `+`, across three classes that all overlap the word class through the underscore:

```js
const QUALIFIER = String.raw`(?:(?!(?:${STOP_WORDS})(?![\w-]))[(\[\x60'"*_]*[\w-]+[)\]\x60'"*_]*[\s-]{1,4})`;
const LABEL_SRC =
  String.raw`real[\s-]{0,4}path[\s-]{0,4}(?:[*_\x60]+[\s-]{0,4})?${QUALIFIER}{0,2}(?:<[a-z]+>|[*_\x60]+)?companions?(?:\(s\))?`;
```

**The pattern, after.** Every run carries a repetition bound, including the four the dash report did not implicate:

```js
const QUALIFIER = String.raw`(?:(?!(?:${STOP_WORDS})(?![\w-]))[(\[\x60'"*_]{0,4}[\w-]{1,64}[)\]\x60'"*_]{0,4}[\s-]{1,4})`;
const LABEL_SRC =
  String.raw`real[\s-]{0,4}path[\s-]{0,4}(?:[*_\x60]{1,4}[\s-]{0,4})?${QUALIFIER}{0,2}(?:<[a-z]+>|[*_\x60]{1,4})?companions?(?:\(s\))?`;
```

The landed pattern is flat in input length: about 2.1ms at 6400, at 19,443, at 50,000 and at 120,000 characters. That flatness is the guarantee the `LABEL_SRC` docblock is now entitled to state, and it states the measured basis alongside it, including that bounding only the dash-or-space runs was tried, measured, and is not enough.

**The probe, as landed**, in the spec titled `the label and both citation parsers stay flat on a separator run`. Two lengths, short first, every intersecting character as its own separator shape, plus mixed shapes, and both entry points timed:

```js
for (const runLength of [6_400, 100_000]) {
  for (const sep of ['-', '_', '*', '`', 'a-', 'a_', '_-*`']) {
    const adversarial = `real-path${sep.repeat(Math.ceil(runLength / sep.length))}x`;
    for (const [name, run] of [
      ['labelCount', (): void => expect(labelCount(adversarial)).toBe(0)],
      ['citationsIn', (): void => expect(citationsIn(adversarial)).toHaveLength(0)],
    ] as const) { /* time `run()` and assert under 250ms */ }
  }
}
```

The `'a-'` and `'a_'` shapes exist because the rejected `\w[\w-]*` candidate is green on a pure separator run and quadratic on an alternating one. Keeping those shapes in the loop means the probe refuses the fix that only looks linear.

**Verification of the landed change.** 11 of 11 specs green on the canary; 9 files and 131 tests across `backend/tests/eslint/`; `npm run typecheck` green; a whole-tree census of every scanned file's label count, citation set and ratchet class byte-identical before and after, so no file changed class and no backlog pin moved; and the repo's `.githooks/pre-commit` anchor gate run standalone over all 272 added lines with zero hits and five control lines firing. The census is the part that makes a regex bound safe to land: the runtime measurement proves the pattern got faster, and only the census proves it still recognises the same corpus.

## Related

- `carve-out-clause-c-companion-citations-are-unverified-prose-2026-09-02.md` is where this canary was specified and argued for. It enumerates the design constraints such a guard must satisfy: near-zero false positives, an explicit diff-versus-whole-tree scoping decision, a per-line escape marker, a mirrored self-test. The constraint this entry adds to that list is cost. A pattern built to satisfy the other four can still be the thing that takes the guard down.
- `source-discipline-canary-comment-normalization-and-lens-vs-probe-coverage-2026-09-08.md` is the sibling rung, and the entry most likely to be read as contradicting this one. It rejects a bounded lookahead because a bound on a SEARCH silently answers "not a comment" for anything longer than the bound. A bound on a quantified RUN is the other case, and the distinction is drawn in the guidance above under bound runs, do not bound searches.
- `source-discipline-canary-detection-must-survive-ordinary-authoring-shapes-2026-08-31.md` is the detection-reach rung of the same ladder: which legal spellings a textual matcher fails to see. This entry is the cost rung. Both share a root cause, closing the one instance that was observed instead of the class it belongs to.
- `backtracking-probe-terminator-must-defeat-the-pattern-tail-2026-09-16.md` is the measurement rung: a probe that reports zero may never have engaged the pattern at all. It applies to the probe above, whose zero-match assertions are sound only because the label pattern's tail requires the literal word `companions`, which no run of separator characters can satisfy. That is a property of that pattern rather than of the idiom, so the terminator is re-derived per pattern.
- `mutation-kill-claims-must-match-assertion-and-corpus-2026-05-15.md` covers why a mutation sweep's own completeness claim gets audited rather than accepted.
