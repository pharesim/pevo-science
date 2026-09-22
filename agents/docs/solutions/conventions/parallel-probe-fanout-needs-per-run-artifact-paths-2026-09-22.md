---
title: A parallel probe fan-out needs per-run artifact paths, not just per-run tree copies, and a run's identity read from its own output
date: 2026-09-22
category: conventions
module: frontend/tests/unit + agent-coordination
problem_type: convention
component: development_workflow
severity: high
root_cause: incomplete_enumeration
resolution_type: workflow_improvement
applies_when:
  - Dispatching a parallel fan-out of probe or test-running agents where each agent already gets its own isolated tree copy
  - Briefing an agent to redirect command output to a fixed literal path rather than one scoped inside its own copy
  - Rolling N agents' kill counts or pass/fail results into one fleet verdict destined for a signal block or a review
  - Deciding whether a probe result may be cited as evidence when only its exit code and summary line were read
tags:
  - mutation-testing
  - subagent-fanout
  - probe-isolation
  - log-contamination
  - false-clean
  - review-workflow
related_components:
  - testing_framework
---

# A parallel probe fan-out needs per-run artifact paths, not just per-run tree copies

## Context

A fan-out dispatched eleven parallel agents to run sixteen mutation probes against
frontend unit specs. Every agent was given its own scratchpad copy of the tree, built
with the project's established probe-copy recipe, and every agent used it. Tree
isolation was correct: no agent could mutate or restore a file another was reading.

The brief was wrong on an axis the recipe never mentions. It told every agent to
redirect the test runner's output to the same two literal paths under the shared
machine-wide temp directory, one for the baseline run and one for the mutated run.
Eleven concurrent agents therefore truncated and wrote into the same two files. An
agent reading its log back had no guarantee the bytes on disk came from its own
process.

Two agents caught it, both from the shape of what they read rather than from anything
the harness told them. One noticed the runner's own run-start banner, which names the
working directory the process actually ran in, pointed at a sibling's probe directory.
The other found two complete run summaries in a single file, one reporting one failure
and one reporting six, which only happens when two processes write to the same
destination. Both discarded the contaminated log, restored their pristine copy, re-ran
with output written inside their own directory, and reported only numbers they could
attribute to themselves.

The other nine had no such tell. Their logs were well-formed, their exit codes
plausible, their summaries singular. The fleet returned "sixteen killed, none
survived", and that number was one step from being written into a task signal block as
verified evidence for an architect's review of a held task.

The fix was to discard the fan-out entirely and re-run all sixteen probes serially in
one copy, each run's log written inside that copy, each run's banner parsed and checked
against the directory it was supposed to have run in. The serial run reproduced the
same conclusion. That was not knowable beforehand, which is the whole reason the re-run
was necessary rather than optional.

Prior sessions had circled this without landing on it (session history). One recorded a
lens agent leaking a scratch file into another agent's nominally isolated copy, caught
only because that agent diffed the copy against what it expected before trusting it.
Another recorded a scratchpad directory removed mid-flight by a racing cleanup, so a
probe silently executed against the real checkout and the agent discovered it
afterwards by checking whether the tree was dirty. Both are the same class: an
isolation guarantee that failed quietly while every visible signal stayed normal.

## Guidance

**Isolate every per-run artifact path on the same key as the tree.** A brief that hands
out a bare path under the shared temp directory has handed out a machine-wide name to N
concurrent agents. Scope logs, coverage output, temp files and helper scripts inside
the copy the agent already received. The existing probe recipe covers the tree and says
nothing about any of these, so a brief built from it is not yet safe.

**Read the run's identity out of its own output.** Most test runners print a banner
naming the working directory they started in. Parsing that back out of each captured
log and asserting it matches the directory the run was supposed to happen in converts
"I trust the file I was pointed at" into something checked. Two different banners, or
two summary blocks, in one log means that log is contaminated and gets discarded rather
than summarized.

**Carry the provenance beside the result, not just the count.** A result worth citing
records the exit code taken from the process rather than inferred from a summary line,
the failure count, the failing names, and the identity the banner reported. A result
that is only a number cannot be audited later, by you or by a reviewer.

**Assert the baseline is green before the first mutation.** A probe read against an
already-red baseline says nothing, however carefully the mutation itself was applied.

**Apply each mutation with an occurrence-count assertion.** Replace text only after
asserting the anchor matched the exact expected number of times, and target an
occurrence explicitly when identical lines sit in branches that must be probed apart.
Otherwise a probe can mutate nothing, or the wrong site, and report a kill it did not
earn.

**When contamination is possible but unproven, re-run rather than re-read.** The
recovery is not to re-examine logs that may already be wrong. Serial execution in one
copy removes the concurrency that made contamination possible and is what makes a
per-run identity check meaningful, because there is nothing else running to be confused
with. It is slower, and for a probe set whose results are about to be cited as evidence
that is the correct trade.

**Put the fix where it outlives the run.** This is the part most easily lost. A prior
retrospective in this repo concluded, after six recurrences of a different fan-out
defect and six hand recoveries, that a mitigation baked into one invocation's script
dies with that invocation, because such scripts are authored fresh each time (session
history). The same applies here: a careful harness written once is not the fix. The fix
is that the recipe pasted into every probe brief names artifact paths alongside the
tree, so the next fan-out inherits it without anyone remembering this incident.

## Why This Matters

A fan-out that reports a clean sweep and a fan-out that reports the same numbers after
reading a sibling's output are indistinguishable at the point where someone decides to
believe them. Nine of the eleven agents here could not have detected the corruption
from inside their own output; the two that did were reading a banner and a summary
count that happened to disagree with themselves. Detection rested on the shape of the
damage, not on anything designed to catch it, and a fan-out whose damage happened to
land tidily would have reported clean with no tell at all.

The consumption point is what makes this expensive rather than merely untidy. The
number was headed for a signal block, which this project's review discipline treats as
ground truth once written. A wrong kill count there does not read as a broken probe
harness later; it reads as coverage that exists.

Tree isolation is the part that is easy to see, so it is the part briefs get right. The
shared resource that bites is whichever one nobody named: a log path here, a helper
script in a prior incident, a cache file in another, a database identifier band in
another still. The rule generalizes past logs. Enumerate every name a set of concurrent
workers touches, and scope each of them, rather than isolating the obvious resource and
assuming the rest followed.

## When to Apply

- Writing a brief for any parallel probe, mutation-test, or adversarial-review fan-out,
  whether dispatched by hand or driven by a workflow script.
- Any brief that already carries the frontend or backend scratchpad-copy recipe. That
  recipe solves tree isolation only, and its silence on output paths is what makes a
  brief built from it look complete when it is not.
- Reviewing a fan-out's rolled-up result before citing it: ask whether the harness can
  show per-run provenance, or only a final number.
- Choosing between a wide parallel fan-out and a serial harness when the results are
  destined for a signal block. Past a handful of agents, or whenever per-run isolation
  cannot be verified from the output, prefer serial.

## Examples

Before, as briefed to all eleven agents:

```bash
cd $SP/probe-N
npx vitest run tests/unit/<file> > /tmp/base.log 2>&1     # baseline
# ...apply mutation...
npx vitest run tests/unit/<file> > /tmp/probe.log 2>&1    # probe
```

Two machine-wide names, eleven writers. Whichever write lands last is what every reader
sees.

After, with the path scoped to the copy and the identity checked:

```bash
cd $SP/probe-N
npx vitest run tests/unit/<file> > $SP/probe-N/base.log 2>&1
grep -m1 'RUN  *v' $SP/probe-N/base.log    # must name $SP/probe-N, not a sibling
# ...apply mutation, asserting the anchor matched the expected count...
npx vitest run tests/unit/<file> > $SP/probe-N/probe.log 2>&1
grep -m1 'RUN  *v' $SP/probe-N/probe.log
```

And the serial harness that replaced the fan-out, in outline:

```python
snapshot = {path: read(path) for path in files_to_mutate}   # pristine, held in memory
assert_green(run_baseline(run_dir))                          # a red baseline voids every probe

for mutant in mutants:
    restore_all(snapshot)
    apply_mutation(mutant, expected_occurrences=1)            # or nth= for twin branches
    log = f"{run_dir}/{mutant.id}.log"                        # inside this run's own copy
    result = run_suite(run_dir, log)
    assert parse_banner_dir(log) == {run_dir}                 # identity, not trust
    record(mutant, exit_code=result.exit_code, failed=result.failed,
           failing=result.x_lines, ran_in=parse_banner_dir(log))

restore_all(snapshot)
```

The `ran_in` field is the point. A result that cannot say where it ran is a number
someone will later have to take on faith.

## Related

- `agents/docs/solutions/conventions/rate-limited-fanout-reports-clean-and-the-fix-cannot-live-in-the-script-2026-09-16.md`
  is the same class through a different mechanism: an aggregate that reads as verified
  when the per-unit evidence was silently damaged. Its damage was dead agents dropped
  from the tally before it was taken, so a finding nothing had judged defaulted to
  refuted rather than being named unjudged; this one's is a shared output path. Its
  conclusion that the fix cannot live in the freshly-authored script applies here
  unchanged, and is why this entry ends on the recipe rather than on the harness.
- `agents/docs/solutions/conventions/worker-fanout-helper-name-divergence-2026-05-15.md`
  is the nearest sibling: tree isolation necessary but not sufficient, instantiated on
  the code workers wrote rather than the artifacts they wrote to. Its context states
  that workers in isolated worktrees cannot see each other's outputs, which is true of
  the tree and not of anything else they share.
- `agents/docs/solutions/conventions/mutation-probes-are-per-site-not-per-fix-2026-08-31.md`
  is another unearned probe claim, there because a fixture's posture routed execution
  through the wrong site. Same symptom class, different mechanism.
- `agents/docs/solutions/conventions/concurrent-agent-staging-sweep-2026-05-12.md`,
  `agents/docs/solutions/conventions/parallel-agent-git-index-race-2026-05-15.md`,
  `agents/docs/solutions/conventions/test-teardown-wildcard-delete-shared-id-band-parallel-workers-2026-06-14.md`
  and
  `agents/docs/solutions/conventions/cross-file-singleton-redis-key-test-isolation-2026-06-15.md`
  are the same shape on other shared names: the git index, a synthetic identifier band,
  a singleton cache key.
