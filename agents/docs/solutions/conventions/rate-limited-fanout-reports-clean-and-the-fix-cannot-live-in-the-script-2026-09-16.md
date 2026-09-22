---
title: "A rate-limited fan-out reports clean, and the fix cannot live in the script that has the bug"
date: 2026-09-16
category: conventions
module: review fan-outs authored with the Workflow tool
problem_type: convention
component: development_workflow
severity: high
applies_when:
  - "Authoring a Workflow script that reduces verdicts from a population of subagents into a survivor list, a pass/fail, or a score"
  - "Dispatching a wide fan-out (roughly 40 agents and up), or one whose later stage is dispatched after an earlier stage has already burned session budget"
  - "Reading the result of a fan-out review that reports few or no survivors against a large raised count"
  - "Recovering the raw findings of a run whose agents died partway through"
  - "Deciding whether a clean review summary is evidence of clean code or evidence of a damaged run"
related_components:
  - development_workflow
  - testing_framework
tags:
  - review-workflow
  - subagent-fanout
  - vote-aggregation
  - rate-limits
  - partial-results
  - silent-failure
  - adversarial-review
  - false-clean
---

# A rate-limited fan-out reports clean, and the fix cannot live in the script that has the bug

## Context

A two-stage review fan-out driven by the Workflow tool dispatches N lens agents to raise
findings, then M adversarial refuters per finding to knock each down. When the session
rate limit kills refuters, a majority-vote survival rule scores the findings nobody
judged as **refuted**, and the run reports a clean review. The summary is
indistinguishable from the summary of a genuinely clean one.

The rule, verbatim from this session's own workflow invocation (these scripts are
persisted under the session directory, not in the repo, so this is session evidence
rather than a repo path):

```js
.then((votes) => {
  const live = votes.filter(Boolean)
  const kills = live.filter((v) => v.refuted).length
  return { finding: f, votes: live, survives: live.length > 0 && kills < Math.ceil(live.length / 2), kills, voted: live.length }
})
```

`agent()` resolves to `null` when a subagent dies on a terminal API error, so a dead
refuter is dropped by `votes.filter(Boolean)` before anything is counted. When all
refuters of one finding die, `live.length === 0`, the first conjunct is false, and the
finding is scored as not surviving. The second conjunct fails the same way:
`0 < Math.ceil(0 / 2)` is `0 < 0`. Both halves of the predicate fall toward "refuted"
for a finding nobody looked at.

In this run the session limit killed 14 of 60 refuters, four findings ended with zero
live votes, and the returned object read `raised: 20, distinct: 20, survivors: [1 item]`.

The script was not naive about it. The same rule carries `voted: live.length`, and the
returned `refuted` array puts `voted` on every entry, so the per-finding vote denominator
WAS emitted: four rows of that array read `voted: 0`. Nobody saw them. The returned object
is delivered through a task notification that truncated at roughly 174,000 characters, and
what a reader actually gets is the top of the payload - the summary counts and the first
survivor. The `refuted` array was in the truncated remainder. The script's own log line
compounded it by reporting `20 judged; 1 survived adversarial refutation`, counting the
four unjudged findings as judged.

**This has now happened at least six times in twelve days, across five sessions**: 21 of
142 agents died; 56 of 75; a round where only 11 of 38 finished; the re-run of that same
round, rate-limited again; 36 of 87, including every refuter of one entire lens; a run
where all 78 refuters failed; and this one. Two properties hold across all of them. The
deaths are always in the **tail phase** - the lenses dispatched first complete, the
verifiers, refuters and critics dispatched last are what die, and the parent's own
budget is drawn from the same limit. And the small Agent-tool fan-outs run in the same
sessions were unaffected, so this is a **width** problem in the roughly 38-to-142 agent
range rather than something wrong with fan-out as a technique.

**Six occurrences, six ad-hoc hand recoveries, zero durable fixes** - and in this one the
obvious fix was already present in the script and was defeated by where it sat. That is
the part worth understanding, and it is not carelessness.

## Guidance

**1. The defect regenerates from the authoring habit, so the fix has to live in the
authoring guidance.** Workflow scripts are authored fresh at each invocation. A
mitigation baked into one run's script dies with that run: there is no file to patch, no
module to import, no test that can go red. The next session writes a new script, reaches
for the same idiomatic majority rule, and reproduces the defect exactly. Nothing in the
repo's code can prevent it. The only durable place for the fix is the guidance loaded at
the top of a workflow-authoring session, alongside the script API it already documents.
Treat "add a vote-denominator rule to the authoring guidance" as the fix, and treat any
per-script mitigation as a patch on one instance of a recurring defect.

**2. A reminder that produces recognition is not a reminder that produces prevention.**
In this session the operator wrote
`survives: live.length > 0 && kills < Math.ceil(live.length / 2)` from scratch **with a
standing memory note describing this exact failure mode in front of them**. The note
made recognition instant once the clean result came back, and did nothing whatsoever to
stop the re-authoring. Six occurrences with an accumulating pile of notes is the
evidence: after-the-fact recognition does not close this. What closes it is the rule
being present at the moment the predicate is typed, which is what authoring guidance is
and what a memory note is not.

**3. Make the unjudged case a named third outcome, in every reduce over killable
agents.** Any aggregation that filters dead agents out before counting has silently
merged "judged and cleared" with "never judged". Decide the unjudged policy explicitly -
survives for hand triage, re-dispatch, or its own bucket in the output - rather than
letting it emerge from a `filter(Boolean)` and a ceiling. This generalizes past
refuters: it holds for graders, verifiers, critics, and any voter population whose job
is to remove items from a list.

**4. Per-finding vote denominators are necessary and demonstrably not sufficient; the
count has to reach the summary level.** `0/3 refuted` beside `2/3 refuted` is the whole
difference between an unexamined item and a cleared one, so emit it. But this run emitted
it and the false-clean landed anyway, because the array it lived in was truncated out of
the delivered payload. A denominator that requires scrolling into a per-finding array sits
on a surface the delivery mechanism is free to drop. Put an `unjudged: N` at the TOP level
of the returned object, beside `raised` and `distinct`, where truncation cannot remove it
and a reader cannot skip past it: those are the numbers a reader actually reads, and that
is the placement that would have worked here. A mitigation has to survive both the
per-invocation authoring problem and the truncation of its own output.

**5. The dead-agent count is visible somewhere in every run's output; go look for it
before believing a clean result.** Historically the tell has been the completion
banner's died-agent count, not the `<usage>` block's `agents_error` field - by the
second occurrence the operator was predicting the false-clean from the agent count
before reading a single finding. Whichever surface a given run exposes, reconcile
dispatched against returned (`items x voters` from the script, returned from the banner
or the journal). If they disagree, the survivor list is a floor, not a result. Until the
summary-level count of point 4 exists, this is the only surface a damaged run reliably
puts in front of a reader, and it is the one that has caught every prior occurrence.

**6. Resuming the dead agents is unproven. Do not plan around it.** A standing note
claims rate-limit-killed subagents resume by ID with partial work intact. In six
occurrences no session has actually exercised it. One session dispatched an entirely new
workflow instead, and it died in the same tail phase. Until someone tries a resume and
reports back, budget for hand recovery from the journal, and treat a successful resume
as a pleasant surprise rather than as the plan.

**7. Recover the raw findings from the journal rather than re-dispatching into the same
limit.** Every completed agent leaves a `{"type":"result", "agentId":..., "result":...}`
row in `<transcriptDir>/journal.jsonl`; the findings of a damaged run are not lost. A
recovery detail specific to this run, new here rather than recurring: result rows carry
only `agentId`, never `label`. The label (for refuters, `refute:<findingIndex>:<angle>`)
lives on the matching `{"type":"started"}` row, so a single pass testing
`label.startswith('refute:')` over result rows matches nothing and reports every finding
as zero-vote. Join through `started`. And resolving a finding index back to a finding
means replaying the script's own dedup in the order it declared the lenses - the index
is a position in a flattened list the journal never stored.

## Why This Matters

The failure mode is indistinguishable from success. "20 raised, 20 refuted, 0 survivors"
is what a genuinely clean review of well-written code looks like, and it is also what a
review looks like when a third of its voters died before voting. The returned object is
well-formed, no finding is marked incomplete, and the damage always points toward
reassurance: dead agents subtract findings, so a run hurt this way looks better than it
was, never worse.

What a recovery buys is not hypothetical. In this run, three of the four zero-vote
findings were docblock corrections already caught by other means. The fourth inverted a
rationale the review documentation had carried for four rounds - a shared
joined-statement helper documented as "structurally cannot reach" a code shape, with a
SET-line count given as the reason. Measured against the real code:

- The cap is `STATEMENT_JOIN_CAP = 4`, consumed by `statementFrom` in
  `backend/tests/eslint/no-custody-claim-derivation-outside-helper.test.ts`, which counts
  the lines it actually joins and stops at the cap, a terminator, a block opener, or a
  blank line.
- Replaying that join over the two finalize statements in
  `backend/src/routes/signup-verify.ts`, from each head a scan could anchor on, gives four
  different answers. Every one of them exhausts the four-line budget and stops **at the
  cap** rather than at a terminator, but where the marker lands inside that budget varies:

  | Head | `updated_at` lands | Slack |
  |---|---|---|
  | `/confirm`, from `await pool.query(` | **not reached** — one line past the cap | — |
  | `/confirm`, from the `` `UPDATE accounts `` template | 4th of 4 joined lines | **0** |
  | `/link`, from `await pool.query(` | 3rd of 4 | 1 |
  | `/link`, from the template | 2nd of 4 | 2 |

Re-measuring changed the finding rather than confirming it, which is worth as much as the
recovery. The documented rationale, that the helper "structurally cannot reach" the shape,
is wrong as a universal: it reaches it from three of the four candidate heads. But it is
right about one of them, and the recovered finding that flatly contradicted it was itself
overstated. The accurate statement is narrower and more alarming than either: from the
head that does reach it most tightly, the marker sits on the last line of the budget with
zero slack, so one added SET column or a reordering that moves the marker down drops it
out of the joined text silently — and a join that stops short reports a statement that
writes nothing, the direction that hides a violation rather than the one that reddens the
bar. That correction exists only because four zero-vote
findings were dug out of a journal by hand, in a run whose summary said there was nothing
to dig for.

## When to Apply

- **Authoring** any Workflow script that reduces subagent verdicts. This is the moment
  the defect is introduced and the only moment it can be cheaply prevented.
- Dispatching a wide fan-out, roughly 40 agents and up, or any run whose later stage is
  dispatched after an earlier stage has already spent session budget. The tail phase is
  where the deaths land.
- Reading any fan-out summary whose refuted count equals or nearly equals its raised
  count. That is the shape every one of the six occurrences took.
- Small voter populations per item: with three voters, one item needs only three deaths
  to vanish, and at a 14-of-60 death rate that is not a tail event.
- Deciding whether to re-run a damaged review. Prefer journal recovery plus hand triage;
  the limit that killed the voters is still in force.
- Not applicable to small Agent-tool fan-outs, which have run alongside every one of
  these failures without incident.

## Examples

**The predicate that produced the bug, and a shape that does not.**

```js
// Bug: dead voters are filtered out, then the empty population is scored.
const live = votes.filter(Boolean)
const kills = live.filter((v) => v.refuted).length
return { finding: f, survives: live.length > 0 && kills < Math.ceil(live.length / 2) }

// Fix, part one: name the unjudged case and carry the denominator per finding.
const dispatched = votes.length
const live = votes.filter(Boolean)
const kills = live.filter((v) => v.refuted).length
const verdict =
  live.length === 0 ? 'unjudged'
  : kills >= Math.ceil(live.length / 2) ? 'refuted'
  : 'survives'
return { finding: f, verdict, tally: `${kills}/${live.length} refuted`, dead: dispatched - live.length }

// Fix, part two, and the half this run was missing: lift the count to the TOP of the
// returned object, above anything truncation can cut.
return {
  raised: all.length,
  distinct: deduped.length,
  unjudged: results.filter((r) => r.verdict === 'unjudged').length,
  dead_voters: results.reduce((n, r) => n + r.dead, 0),
  survivors: ...,
}
```

A payload whose first four numbers read `raised: 20, distinct: 20, unjudged: 4,
dead_voters: 14` cannot be mistaken for a clean review, and cannot be truncated into one.
Part one alone was present here and was not enough. Both halves together are what this
entry asks the authoring guidance to carry, because the script itself will not exist
tomorrow.

**The journal recovery, including this run's join.**

```python
import json
started, returned = {}, set()
for line in open(journal):                      # <transcriptDir>/journal.jsonl
    e = json.loads(line)
    if e.get('type') == 'started':
        started[e['agentId']] = (e.get('label', ''), e.get('phase'))
    elif e.get('type') == 'result':
        returned.add(e['agentId'])              # result rows carry agentId ONLY

# Refuter labels are f"refute:{finding_index}:{angle}". Group the STARTED rows by
# the middle field, then count how many agentIds of each group came back.
votes = {}
for agent_id, (label, _phase) in started.items():
    if label.startswith('refute:'):
        votes.setdefault(label.split(':')[1], []).append(agent_id in returned)

zero_vote = [idx for idx, got in votes.items() if not any(got)]
```

Scanning result rows for `label` instead of joining through `started` yields an empty
match set and a table claiming every finding had zero votes, which is what the first
recovery attempt in this session produced.

**Checking a recovered finding costs less than the run that hid it.** Reimplementing
`statementFrom` in a scratch script and replaying it over the two finalize heads is a few
lines, needs no test run, and mutates nothing. It turned a documented "structurally
cannot reach" into a measured "reaches it with zero margin" - a claim that was cheap to
check and expensive to carry wrong for four review rounds.


## Related

- `source-discipline-canary-comment-normalization-and-lens-vs-probe-coverage-2026-09-08.md`
  is where this learning was first recorded, as a subsection of an entry about
  comment normalization in source-scanning canaries. It is the run that produced
  this failure and the one that documented it, and the coverage was real but
  undiscoverable from the direction anyone searching for a bad review summary
  would come. This entry carries the material; that one keeps a pointer and its
  own subject.
- `await-is-not-a-teardown-boundary-unless-it-yields-to-a-macrotask-2026-09-03.md`
  is the same aggregation step failing in the opposite direction: there the
  findings merge treated two reviewer personas' agreement as independent
  corroboration and promoted a claim the source refutes. Read as a pair, the two
  establish merge-and-score as an unaudited step that can both erase a true
  finding and manufacture a false one.
- `new-fail-closed-outcome-must-not-reuse-an-existing-sentinel-2026-09-15.md`
  came out of the run whose summary is the worked example here. It explains why
  the author's own probes could not find the defect; this entry explains why the
  pass that did find it reported nothing.
- `composite-mutation-probe-does-not-cover-its-constituent-branches-2026-09-06.md`
  is the same epistemics one layer down: aggregate evidence proving less than it
  appears, there over branches inside one guard rather than over votes on one
  finding.
- `parallel-probe-fanout-needs-per-run-artifact-paths-2026-09-22.md`
  is the precondition beneath guidance point 3. That point makes the unjudged
  case survive the reduce, which assumes each agent that did report reported its
  own result; when the fan-out's agents share an output path they do not, and an
  aggregation with a correct unjudged bucket still totals numbers that belong to
  the wrong agents. The two are one checklist: per-agent artifact paths first,
  then a named unjudged outcome in the reduce.
