---
title: "Relocated content is not new content: read the base-ref source before scoring a review finding's severity"
date: 2026-09-16
category: conventions
module: ce-code-review triage + frontend/tests
problem_type: convention
component: code-review
severity: medium
root_cause: missing_workflow_step
resolution_type: workflow_improvement
applies_when:
  - "Reviewing a diff that moves a describe() block, docblock, or header comment byte-identically out of one file into a new sibling file"
  - "A review lens scores severity for a claim or disclosure visible in the new file, without diffing it against the pre-move location at the base ref"
  - "Multiple independent lenses converge on a finding, and that convergence is being read as evidence the diff INTRODUCED the issue"
  - "Triaging a carve-out clause (c) real-path-companion claim in a header whose wording changed shape across a file split"
  - "Verifying byte-identity of a moved block by diffing from its start line in both files without bounding the diff to the block's true end"
symptoms:
  - "Three of six review lenses flag a header sentence in a newly created file as a fresh convention violation"
  - "The flagged sentence is present verbatim in the pre-split file at the base ref, which a new-file-only diff view cannot show"
  - "An unbounded tail-diff from a moved block's start line reports extra lines as dropped content that are actually a sibling block correctly left behind"
tags:
  - code-review
  - severity-scoring
  - base-ref
  - relocated-content
  - false-positive
  - review-triage
  - multi-lens
  - file-split
related_components:
  - testing_framework
  - development_workflow
---

# Relocated content is not new content: read the base-ref source before scoring a review finding's severity

## Context

An architect `/ce-code-review` covered a pure file split: a 17-case
`describe('teardown abandons in-flight acquisitions', ...)` block moved byte-identically out
of `frontend/tests/unit/lib-fresh-auth-session-window.test.js` into a new sibling
`frontend/tests/unit/lib-fresh-auth-teardown.test.js`, carrying its file-header docblock with
it (commit `1c03368c`).

Three of six independent lenses (project-standards, learnings, adversarial) converged at
confidence 100 on the new file's header as a fresh violation of root `CLAUDE.md`'s
"Carve-out for deterministic edge-case coverage" clause (c), which requires that "the same
risk class is covered by a real-path test elsewhere, OR a follow-up task is filed to add
such coverage." The new header's closing paragraph opens:

> Clause-c real-path companion: none exists for this suite's risk class.

Read against a file the diff labels as newly created, that satisfies neither branch of
clause (c). It looks exactly like a violation the split introduced, and it was scored
P1/P2/P2 on that basis.

The mitigating fact was invisible from the new file, because it lived only in the file the
diff deleted content *from*. The pre-split parent header already carried the same admission:

```
git show <base-sha>:frontend/tests/unit/lib-fresh-auth-session-window.test.js | sed -n '28,50p'
```

> Clause-c real-path companion: none exists yet for this suite's risk class. [...] What has
> no real-path coverage is a light-account broadcast or upload carrying a window proof, and
> a follow-up is filed to add one.

The gap was already on record before the split touched anything. What the split actually did
was narrow the disclosure to the teardown suite's own, more specific risk class (a subject
scrub landing mid-acquisition, not the broadcast/upload gap) and *drop* an "and a follow-up
is filed" clause that did not discharge the narrower class at all. That is a strict
improvement in accuracy, not a new hole. The residue was a tracking gap, not a standards
violation, and it was routed as a P2 note onto the task that already tracks this header
family rather than held against the finished test move.

A prior incident in this repo is the nearest analog on record (session history): an
i18n ledger rule in `agents/ui/CLAUDE.md` raised an "Updated" heading whenever a string was
reworded, without checking whether a prior translation existed for the reword to invalidate,
so carried-forward content was bucketed identically to genuinely-changed content. The fix
for it went unexecuted for about three months, during which six keys ended up double- or
triple-listed. The fix was the same shape as this one: make the rule consult the prior state
before classifying.

## Guidance

When a review finding targets a header, docblock, or comment inside a file the diff
**created by relocating content** (a file split, a module extraction, a test-suite divide),
read the same claim in the **source file at the base ref** before assigning severity:

```
git show <base-sha>:<path/to/source-file> | sed -n '<start>,<end>p'
```

If the same statement, or a strict narrowing of it, already existed pre-split, the finding is
not "the diff introduced a violation." At most it is "the diff relocated a pre-existing
statement," which is a different and usually much lower severity, and often a different
task's problem rather than a hold on the move itself.

This generalizes past clause (c). Any assertion that "this file's comment says X and that's a
problem" is a claim about the **diff**, and a diff's content is what changed, not the
post-image alone. A line present unchanged in both pre-image and post-image was not
introduced by this diff, whatever file it now lives in.

**A second, mechanical trap surfaced on the same move.** Confirming that a relocated block is
byte-identical by tail-diffing from its start line in each file, with no upper bound, produces
a false "content dropped" alarm whenever the moved block is not the last one in its source
file. The block here started at base line 818 and new-file line 168:

```
diff <(awk 'NR>=818' base.js) <(awk 'NR>=168' new.js)
```

reports 90 lines present only on the base side. Those 90 lines are not lost content. They are
a different, later `describe('collisions and suppressed navigation', ...)` block that
correctly stayed behind in the parent. The unbounded diff cannot know where the moved block
ends, so it folds in everything after it. Bound the extraction to the block's true end, or
diff a fixed equal line count on both sides:

```
diff <(awk 'NR>=818 && NR<=1350' base.js) <(awk 'NR>=168' new.js)
```

returns nothing: the block is in fact byte-identical.

## Why This Matters

A P1 hold on a finished, faithful split is expensive in a way that is easy to underweight. It
returns a task that mutation testing already validated (64 tests before the split, 47 + 17
after, identical kill sets across four mutants on both trees) for rework that fixes nothing,
because the thing being fixed was never broken by this diff. It also mis-files the real,
smaller issue: a tracking omission belonging to a sibling task's header sweep. Parked on the
wrong task, that omission is invisible to whoever would act on it.

The failure mode is structural, not a lens mistake. Every lens reads the diff's post-image by
default, and none reads the base-ref version of a file the diff only deletes from unless a
step says to. A review that never opens the base ref for a relocation diff makes this error on
every future comment finding inside a split, extraction, or rename, however many lenses agree.

**This does not overturn the convergence rule.** The corpus already holds that when several
independent lenses converge, that is the strong signal and should not be waved off by a
majority of refuters. That still holds: the three lenses were right that the clause-c gap is
real and untracked. What this entry adds is a second, separate axis. Convergence is evidence
a finding is *true*; it is no evidence about whether the diff *introduced* it, because every
lens reads the same new file and none reads the base ref. A finding can be unanimous, real,
and about a state that predates the diff, all at once. Score truth by convergence. Score
severity, ownership, and which task owns it against the base ref.

This was not a wholesale review failure, and reading it as one would be the wrong lesson:
`correctness` and `testing` returned zero findings, `maintainability` raised only a
pre-existing nit, and `correctness` established "no test weakened" by running four mutants
against both trees and comparing kill sets rather than by reading the header at all.

## When to Apply

Apply the base-ref check when a finding both:

- targets a comment, docblock, header, or disclosure inside a file the diff created via a
  **move, split, or extraction** (not a from-scratch new file); and
- characterizes that content as newly introduced, newly non-compliant, or a fresh gap (rather
  than a typo or formatting issue that is obviously new regardless of origin).

It does not apply to genuinely new prose written during the move, nor to ordinary
code-behavior findings where the base-ref version is irrelevant to correctness.

## Examples

**Before, the false read.** The new-file-only view shows a clause-c paragraph naming no
real-path companion and no follow-up task. Three lenses score it a clause-(c) violation on the
assumption the split introduced it.

**After, the base-ref check.** The same disclosure is already present, in a broader form, in
the pre-split parent. Side by side, the split's version is a narrower and more accurate
restatement, not a new gap: it drops "a follow-up is filed" precisely because that follow-up
does not cover the teardown suite's mid-flight-scrub risk class.

**The correction that landed** (commit `294c9325`): no hold on the test-move task, which
archived clean; a P2 note appended to the light-account fresh-auth e2e coverage task naming
the teardown header as a sixth entry in that task's header family, with the disposition (add a
scrub leg, or record the class as an accepted gap) left to the implementer.

## Related

- [`re-review-cluster-path-restricted-union-diff-not-per-commit-2026-05-26.md`](./re-review-cluster-path-restricted-union-diff-not-per-commit-2026-05-26.md) — the inverted symptom of the same root cause: a relocation makes code look falsely *missing* rather than falsely *new*.
- [`review-finding-untracked-sibling-contamination-2026-06-09.md`](./review-finding-untracked-sibling-contamination-2026-06-09.md) — the same wrong-reference-point pattern when judging a finding's status.
- [`carve-out-clause-c-companion-citations-are-unverified-prose-2026-09-02.md`](./carve-out-clause-c-companion-citations-are-unverified-prose-2026-09-02.md) — the sibling clause-c failure mode on the other axis: that entry verifies a citation is TRUE, this one verifies a true claim is NOVEL to the diff.
- [`hold-item-completion-structural-vs-behavioral-2026-05-12.md`](./hold-item-completion-structural-vs-behavioral-2026-05-12.md) — the corpus's existing "cross-reviewer corroboration is the strong signal" statement, which this entry scopes to existence rather than novelty rather than contradicting.
- [`re-review-intake-supersession-check-2026-05-05.md`](./re-review-intake-supersession-check-2026-05-05.md) and [`worktree-fanout-orphan-detection-2026-04-29.md`](./worktree-fanout-orphan-detection-2026-04-29.md) — the architect-intake gates of the same trust chain; this entry extends it to the per-lens level.
- [`sibling-docblock-tallies-must-each-state-precisely-what-they-count-2026-09-09.md`](./sibling-docblock-tallies-must-each-state-precisely-what-they-count-2026-09-09.md) — adjacent comment-accuracy-in-relocation failure mode.
