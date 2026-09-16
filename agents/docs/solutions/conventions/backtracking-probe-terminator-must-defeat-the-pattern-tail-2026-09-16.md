---
title: "A backtracking probe that reports zero may not have engaged: the terminator must defeat that pattern's own tail, and the growth curve is the only signal"
date: 2026-09-16
category: conventions
module: backend/tests/eslint
problem_type: convention
component: testing_framework
severity: medium
related_components:
  - development_workflow
  - code-review
resolution_type: workflow_improvement
applies_when:
  - "Measuring catastrophic-backtracking or ReDoS cost, before reporting any pattern as linear or flat"
  - "Probing several patterns from one harness, especially siblings from one file or built from shared fragments whose tails differ"
  - "Reviewing a claim that a pattern's match cost is bounded, where the evidence offered is a timing number rather than a growth curve"
  - "Reading a timing table whose rows are orders of magnitude apart, before concluding the fast rows are fast"
  - "Writing the probe that pins a quantifier bound a previous round introduced"
symptoms:
  - "A pattern measures ~0ms at every input length while a sibling of the same construction measures hundreds of milliseconds"
  - "Raising the probe input size does not move the reading at all, and the larger input falsely increases confidence"
  - "A timing table mixes genuine measurements and artifacts in identical-looking rows"
  - "A quadratic pattern is reported as flat in a review handoff, caught by the result looking implausible rather than by the harness"
tags:
  - regex
  - catastrophic-backtracking
  - canary-tests
  - timing-probes
  - vacuous-pass
  - measurement-methodology
  - source-discipline
---

# A backtracking probe that reports zero may not have engaged: the terminator must defeat that pattern's own tail, and the growth curve is the only signal

## Context

Measuring whether a regex backtracks super-linearly means building an adversarial input:
a prefix the pattern starts matching, a long run of some character, and a terminator. Then
the run is doubled and the cost watched for four-fold growth.

The input has three parts and only two of them get designed. The prefix is chosen so the
pattern engages, the run is chosen from the character classes that overlap, and the
terminator is whatever was on the end of the last probe someone wrote. That last part is
load-bearing, and when it is wrong the probe does not fail loudly. It reports the pattern as
flat, at every length, and the flat reading is indistinguishable from the one a genuinely
linear pattern gives.

This surfaced while widening one head pattern in
`backend/tests/eslint/no-accounts-updated-at-write-outside-signup-finalize.test.ts` and
checking whether its siblings carried the same cost. Three of them do. The first measurement
said one did and two did not, and the two were reported as flat in a review handoff before
the reading was rechecked.

## Guidance

**A cost probe that reports zero has not proved the pattern is linear. It has produced a
reading that is equally consistent with the probe never engaging, and that is the first
hypothesis to rule out, not the last.**

**1. The terminator must not satisfy the pattern's tail at the position the run ends.** The
quadratic cost is the engine exploring every way to partition the run between two adjacent
unbounded quantifiers. It only does that exploring if its first, greedy path does not
immediately succeed. A terminator the tail accepts hands it that immediate success: the run
is consumed greedily, the tail matches the terminator, and the engine returns on its first
attempt having backtracked nothing. Cost is then constant in the run length, which is why
the reading is flat at 50,000 characters exactly as it is at 500.

**2. Choose the terminator against THIS pattern's tail, never by copying a sibling probe.**
The terminator is not a property of the probe idiom, it is a property of the pattern under
test. `x` is a correct terminator for a pattern whose tail requires a literal keyword and a
silently wrong one for a pattern whose tail is `[a-z_]`. Two probes in the same file, written
to the same template, can be one valid and one vacuous.

**3. Do not use the match outcome as the signal.** The obvious defensive rule — assert the
match fails — is neither necessary nor sufficient, and this is the part worth carrying,
because it is the rule a careful person reaches for first. A pattern can exhaust every
partition of the run and then still succeed, by a route that has nothing to do with the
terminator. Measured here: with the terminator that defeats the tail, the match still
returns true, having found a completely different parse after the expensive exploration.
Asserting `toBe(false)` would have failed that probe for the wrong reason while the timing it
was guarding stayed correct.

**4. The growth curve is the signal.** Double the run and look for roughly four-fold. That is
the one reading which distinguishes "this pattern is flat" from "this probe did not engage",
because a probe that does not engage is flat under doubling too but sits at zero, while a
genuinely linear pattern is flat at a small non-zero cost that tracks the input. Any
conclusion drawn from a single length is a conclusion about the probe as much as the pattern.

**5. Validate a fast reading against a known-slow control in the same run.** The cheapest
guard against all of the above is to measure one pattern already known to be quadratic
alongside the ones under test. If the control reads fast too, the harness is wrong. If the
control reads slow and a sibling reads zero, the sibling's terminator is the first thing to
look at, not its pattern.

## Why This Matters

The failure mode is silent and it points the wrong way. A probe that is too short reports
fast and is a false green; that hazard is already known. This one reports fast at any length,
so the usual remedy — push the input bigger — does nothing, and the growing input actively
reassures. A reviewer watching 50,000 characters come back in a tenth of a millisecond
concludes the pattern is flat with more confidence than at 500, not less.

It is also specifically a hazard of probing patterns in FAMILIES, which is the situation these
canaries create. One file here carries five head patterns sharing a construction. Probing them
as a set is the right instinct, and writing one probe harness and pointing it at each in turn
is the obvious implementation. But the terminator that is correct for the first is a property
of that first pattern's tail, and carrying it across the family is what produces a table of
results where some rows are measurements and others are artifacts, presented identically.

The consequence in this round was a wrong claim handed to a reviewer: two patterns reported
flat that are in fact quadratic. Nothing shipped on it, because the reading was rechecked
before it went anywhere load-bearing. What makes it worth recording is that the recheck was
prompted by finding the result implausible rather than by anything in the harness, and a
harness whose wrong answers are only caught by suspicion is not a harness anyone should reuse.

## When to Apply

- Measuring catastrophic backtracking or ReDoS cost for any pattern, before reporting a
  pattern as linear or flat.
- Probing several patterns from one harness, especially patterns from the same file or built
  from shared fragments, where their tails differ even though their heads look alike.
- Reviewing a claim that a pattern's match cost is bounded, when the evidence offered is a
  timing number rather than a growth curve.
- Reading any timing table where some rows are orders of magnitude apart. Ask what terminated
  each input before concluding the fast rows are fast.

## Examples

**The vacuous reading and the real one**, against patterns read out of the committed source
rather than retyped, at 50,000 spaces:

| pattern | terminator `x` | terminator `9` |
|---|---|---|
| `ACCOUNTS_STATEMENT_RE` | 840ms | 858ms |
| `UPDATE_TARGET_RE` | **0.0ms** | 816ms |
| `MERGE_TARGET_RE` | **0.0ms** | 840ms |
| `COPY_COLUMNS_RE` | 0.0ms | 0.0ms |
| `ALTER_ACCOUNTS_RE` (as committed) | 0.1ms | 0.1ms |

The two bolded zeros are the artifact. Those two patterns end in a capture group beginning
`[a-z_]`, and `x` satisfies it, so each matched on its first attempt. `ACCOUNTS_STATEMENT_RE`
was unaffected by the same terminator because its tail requires the literal `accounts`, which
`x` cannot satisfy — which is precisely why copying a terminator between them is unsafe. The
last two rows are flat under both terminators and are the genuine negatives.

**Why asserting the match fails would not have saved it.** The expensive case succeeds:

```
input:  "UPDATE ONLY" + 40 spaces + "x"   -> matched, captured "x"     (0ms, never backtracked)
input:  "UPDATE ONLY" + 40 spaces + "9"   -> matched, captured "ONLY"  (expensive)
```

With the defeating terminator the pattern abandons its optional `ONLY\s+` clause, captures
the word `ONLY` itself as the table name, and succeeds — after exhausting the partitions. The
match returns true in both rows. Only the clock tells them apart.

**The growth curve, which does tell them apart**, on `ACCOUNTS_STATEMENT_RE`:

| run length | time | growth |
|---|---|---|
| 12,500 | 50.8ms | |
| 25,000 | 204.1ms | 4.0x |
| 50,000 | 832.1ms | 4.1x |
| 100,000 | 3,328.7ms | 4.0x |

Four-fold per doubling is the quadratic signature. A pattern that is genuinely flat shows a
small cost that grows about linearly; a probe that is not engaging shows zero at every row,
which is the shape to be suspicious of rather than reassured by.

## Related

- `backtracking-fix-must-bound-every-quantifier-whose-class-overlaps-2026-09-14.md` is the
  entry this one sits directly beneath, and the two should be read together. That entry owns
  finding the cost — enumerating every quantified run, intersecting their character classes,
  and doubling the run length, which is where the four-fold signature used here comes from.
  This entry owns trusting the reading. The division matters because that entry's own worked
  probe asserts a zero match count, and is correct to, only because its pattern's tail
  requires the literal word `companions`, which no adversarial run character can satisfy. That
  safety is a property of that pattern, not of the idiom, and it is not stated there as
  something to re-derive per pattern. Flagged for refresh on that ground rather than edited
  here, since amending another entry belongs to a refresh pass.
- `sql-grammar-questions-are-settled-against-a-nonexistent-relation-2026-09-16.md` is the
  sibling from the same review round and the same file. Its closing note says that widening a
  head pattern is exactly the moment to re-check the cost rung; this entry is what that
  re-check ran into. It should gain a citation to this one on the next refresh pass.
- `tests-must-fail-on-mutation-of-code-under-test-2026-04-22.md` is the root convention
  underneath both. A probe whose terminator satisfies the tail is a test that cannot fail for
  the reason it exists, which is the same defect in a timing register rather than an
  assertion register.
- `sampling-an-unordered-collection-is-mutation-blind-to-a-truncating-batch-2026-08-26.md` is
  the closest precedent for the shape: a check that looks like coverage, passes, and is blind
  to the very mutation it was written for. Same vacuity, different mechanism — there the gap
  is which members get examined, here it is whether the engine does any work at all.
- `control-pair-pins-only-varied-axis-enumerate-mutation-space-2026-06-12.md` is the general
  form of the known-slow-control rule. A control exists to pin the axis under test, and a
  timing harness with no slow control pins nothing, because every failure mode of the harness
  and the happy answer produce the same number.
- `mutation-kill-claims-must-match-assertion-and-corpus-2026-05-15.md` is why the wrong
  reading mattered beyond the measurement: a cost claim stated in a handoff is a claim about
  what was verified, and it gets audited rather than accepted.
