---
title: A startup-file sentence that contradicts a convention doc keeps producing the defect the doc explains — correct the sentence, don't add a pointer beside it
date: 2026-09-09
category: conventions
module: agents/ui/CLAUDE.md + agents/docs/solutions
problem_type: convention
component: documentation
severity: medium
root_cause: inadequate_documentation
resolution_type: workflow_improvement
applies_when:
  - A defect class recurs across many instances even though an `agents/docs/solutions/` entry documents the correct rule and names the right file
  - Landing a `/ce-compound` entry whose `module:` field names a startup-read protocol file (`agents/<role>/CLAUDE.md`, root `CLAUDE.md`)
  - A solutions entry's Related section says "keep that rule and this clarification consistent" about another file
  - About to file a sweep task against N instances of one convention violation
  - Auditing a protocol file that states a rule and its own invariant several paragraphs apart
related_components:
  - frontend/public/messages/STUBS.md
  - agents/ui/CLAUDE.md
  - agents/docs/solutions/conventions
tags: [agent-coordination, conventions, solutions-discoverability, startup-protocol, self-contradicting-protocol-file, i18n, stubs-md, recurrence]
---

# A startup-file sentence that contradicts a convention doc keeps producing the defect the doc explains — correct the sentence, don't add a pointer beside it

## Context

`frontend/public/messages/STUBS.md` is PEvO's translator ledger. The Stub-tracking paragraph of `agents/ui/CLAUDE.md` defines its form: every stub-adding commit appends `<locale>: <key>` lines, one per locale-key pair awaiting translation, and a translator deletes the matching line in the commit that lands the real translation. The stub-list-is-the-single-source-of-truth paragraph in that same file states the guarantee the form buys: "grepping for a specific key yields every locale where it still needs translation". One key, one line per still-pending locale. That per-key grep invariant is the ledger's whole value.

Six i18n keys broke it by being listed under two or three sweep headings at once. Each time the proximate cause was the same authoring move: an author added a `### Updated <date>` heading for a key that had never actually been translated, so the key's lines existed twice or three times over.

The correct rule was already documented. `agents/docs/solutions/conventions/i18n-stubs-added-vs-updated-scope-never-translated-keys-2026-06-09.md` says a never-translated key whose English is reworded is reworded **in place** under its existing `### Added` heading, with no `Updated` entry, because `### Updated` exists to warn that prior translation memory may mislead and a never-translated key has no translation memory to mislead. That entry landed 2026-06-09. It did not stop the recurrence.

**Why it did not.** `agents/ui/CLAUDE.md` is the file the ui agent loads unconditionally at startup: step 1 of root `CLAUDE.md`'s Startup Protocol is "Read the relevant `agents/<role>/CLAUDE.md` for your role". The `### Updated` bullet in its Sweep-grouping section said, in the same sentence as the heading's definition:

> Use `Updated` instead of `Added` when the key already existed; the distinction tells translators that translation memory from the prior text may mislead and the value needs fresh review.

Read literally, "when the key already existed" covers every reword of any pre-existing key, including one that no locale has ever translated. Further down, the same file states the per-key grep invariant that the literal reading destroys. The file contradicted itself at a distance, and the earlier half is the half phrased as an imperative.

**Discoverability was not the missing piece, and that is what makes this non-obvious.** The 2026-06-09 entry named `agents/ui/CLAUDE.md` in its own `module:` frontmatter field, and its Related section already said:

> `agents/ui/CLAUDE.md` §Internationalization — the authoritative source for the `### Added`/`### Updated` distinction and the per-key single-source-of-truth grep invariant. Keep that rule and this clarification consistent.

That instruction was written and never carried out. The contradictory sentence had landed 2026-05-17 in `f0a6c7f0` ("architect(ui-claudemd): permit STUBS.md `### Updated` header variant"), the clarification landed three weeks later, and the sentence stood for three more months while keys kept breaking.

Prior sessions make the blind spot concrete (session history). The duplicate on the sixth key survived two full architect review passes and was caught only on the third, by the `learnings` persona inside `/ce-code-review` cross-referencing `agents/docs/solutions/` — that is, by a reviewer-side net, not by anything in the implementer's own context. Sharper still: the ui session that then repaired the ledger opened with `cat agents/ui/CLAUDE.md` as its routine startup read, spent the session fixing the exact symptom that file's rule produces, proactively grepped the ledger and discovered four more duplicated key families on its own — and never flagged the rule itself. Across three architect reviews and one implementer fix session, all touching this ledger entry, nobody named the contradiction. Only the symptom was repaired, each time narrowly.

The correction is `301ed073` (2026-09-09), reachable from the current tree. It edits `agents/ui/CLAUDE.md` itself, inserting a carve-out paragraph immediately beneath the offending bullet:

> **`Updated` is for keys with a translation to invalidate, not for every pre-existing key.** Read "when the key already existed" against the purpose in the same sentence: the heading exists to warn that prior translation memory may mislead. If every non-English locale still holds the English stub, no translation exists for the reword to invalidate and there is nothing to warn about. Reword the English in place under the key's original `### Added` heading and add no second entry. A key listed under two headings is listed twice per locale, which breaks the per-key grep invariant this file states below and is the ledger's whole guarantee.

Two lines of diff, three months late.

## Guidance

This refines `agents/docs/solutions/conventions/conventions-in-solutions-dont-reach-implementer-context-2026-05-18.md`. That entry's Context section established that `agents/docs/solutions/` is a knowledge store, not a delivery mechanism, and its Guidance section prescribed surfacing a one-line hook in the startup-read path — `agents/<role>/CLAUDE.md` or root `CLAUDE.md` — with the full rationale left in the solutions entry.

**The refinement: a pointer is not sufficient when the startup file already contains text that actively contradicts the doc.** The 2026-05-18 remedy assumes the startup file is *silent* on the rule, so a link fills a gap. When the startup file instead states the rule *wrongly*, an agent reads it, acts on it, and never follows the pointer, because nothing in the sentence it just obeyed signals that a conflict exists. A link parked beside a wrong sentence reads as elaboration, not as correction, and leaves the wrong sentence load-bearing. The remedy has to be to **correct the contradictory sentence in place**, in the startup file, in its own commit.

Three operational rules follow.

1. **When a defect class recurs, suspect the authoritative text before suspecting the authors.** Six independent authoring events producing one defect is not six lapses; it is a rule being followed. Before filing another sweep task against the instances, read the startup-path sentence that governs them and ask whether a literal, good-faith reading of it produces the defect. If it does, the sweep is downstream work and the sentence is the fix.

2. **A protocol file can contradict itself across paragraphs, and neither paragraph looks wrong alone.** The Sweep-grouping bullet is a defensible rule. The stub-list-single-source-of-truth paragraph is a defensible invariant. Only holding both at once reveals that the first, read literally, breaks the second. A reader arriving at either paragraph for its own purpose sees nothing amiss. So when auditing a protocol file, check its imperatives against its invariants pairwise, not paragraph by paragraph — and when you write the fix, place it adjacent to the sentence that generated the defect rather than near the invariant it protects, because adjacency is what the next literal reader will encounter.

3. **A Related-section instruction to edit another file is a work item, not a cross-reference.** "Keep that rule and this clarification consistent" is an unexecuted task the moment the entry is committed. Either land the other file's edit in the same commit as the `/ce-compound` entry, or file it as a task. Left as prose inside a file nobody in the startup path reads, it is exactly as reachable as the convention it was meant to enforce, which is to say not at all.

## Why This Matters

The measurable cost is on disk and re-derivable:

```
grep -oE '^[a-z]{2}: [A-Za-z0-9_.]+' frontend/public/messages/STUBS.md \
  | sed 's/^[a-z]*: //' | sort | uniq -c | awk '$1>15'
```

returns five keys at the current tree: `upgrade.backendTimeout` at 45 lines across three headings, plus `upgrade.keychainImportFailed`, `upgrade.keychainImportWarning.active`, `.memo` and `.posting` at 30 lines across two headings each. Fifteen non-English locales, so 165 lines where 75 belong: 90 surplus. `grep -E '^[a-z]{2}: ' frontend/public/messages/STUBS.md | sort | uniq -d | wc -l` returns 75 duplicated locale-key pairs out of 3615 ledger lines. The sixth key, `upgrade.sessionChangedBeforeCleanup`, was cleared under the custody-upgrade subject-pin work (`b1aee50f`) and now sits at exactly 15 lines under a single `### Added` heading. The other five are filed for a sweep in `agents/docs/tasks/pending/ui-stubs-duplicate-ledger-entry-sweep.md`.

What the numbers show is the shape of the failure, not just its size. Each of those six events was a *separate* task, by an agent that had read `agents/ui/CLAUDE.md` at startup and had not read `agents/docs/solutions/`. Every one of them was compliant with the text it was given. The 2026-05-18 remedy had been satisfied on paper — the doc named the file, the doc said to keep them consistent — and the defect rate did not move, because the delivery surface was not empty, it was wrong. A gap and a contradiction look identical in a discoverability audit ("is this rule reachable from the startup path?" — yes, sort of) and behave completely differently at write time.

The cost asymmetry is the argument for checking the authoritative text first. Correcting the sentence cost two lines of diff. The instances it produced cost one cleared key, one pending sweep task with six acceptance criteria, and a ledger that lied to translators for three months about how much work was pending. Every additional month the sentence stood was another opportunity for the next reword to add the seventh instance, and each instance is discovered individually, at review, one round at a time.

## When to Apply

Apply when any of these hold:

- A convention documented in `agents/docs/solutions/` is violated repeatedly by the same role after the entry landed. Read the role's startup-read file for a sentence that produces the violation under a literal reading, before filing a sweep or writing a second entry.
- You are landing a `/ce-compound` entry whose `module:` field names `agents/<role>/CLAUDE.md` or root `CLAUDE.md`. That field is a signal that the authoritative text may need editing, not merely citing.
- You are writing a Related-section line of the form "keep that rule and this clarification consistent". Land the other edit or file the task; do not leave it as prose.
- You are adding a new rule to a protocol file that already states an invariant the rule could violate. Check the pair before committing, and place the carve-out next to the rule.
- A code review dismisses a finding as a false positive because "the convention doc says otherwise". If the startup file says the opposite of the doc, the dismissal is correct for that finding and the file still needs fixing; the dismissal is not the end of the work.

Do not apply the in-place-correction remedy when the startup file is genuinely silent on the rule. That is the plain 2026-05-18 case, and a one-line hook is the right and cheaper answer there. The distinguishing question is not "is the rule reachable?" but "does the reachable text, read literally by someone who reads nothing else, produce the defect?"

## Examples

**Before — a pointer that could not win.**

The 2026-06-09 entry exists, is correct, names `agents/ui/CLAUDE.md` in `module:`, and closes with "Keep that rule and this clarification consistent." Meanwhile the Sweep-grouping bullet still reads "Use `Updated` instead of `Added` when the key already existed." A ui agent rewording the English of `upgrade.backendTimeout` reads the startup file, finds a rule that answers its exact question, and appends:

```
### Updated 2026-05-17 (UI-CUSTODY-UPGRADE-SEED-PHRASE-DERIVE-FLOW)
ar: upgrade.backendTimeout
cs: upgrade.backendTimeout
… (15 locales)
```

The key already had 30 lines under two `### Added` headings. It now has 45. `grep upgrade.backendTimeout STUBS.md` reports three times the pending work that exists. Nothing in the agent's context flagged a conflict, and the solutions entry it never opened is the only place the conflict was named.

**After — the sentence corrected in place.**

`301ed073` inserts the carve-out directly beneath the bullet that produced the defect. The next agent to reword a never-translated key's English encounters the correct rule at the first place it looks, with the reasoning inline ("no translation exists for the reword to invalidate") and the solutions entry cited afterward for the recurrence history rather than as the sole carrier of the rule. The instance-level fix follows the same shape one level down: `b1aee50f` folded `upgrade.sessionChangedBeforeCleanup` back into its original `### Added` sweep, restoring `grep -cE '^[a-z]{2}: upgrade\.sessionChangedBeforeCleanup$'` to exactly 15.

**The generalizable move.** When the seventh instance of a documented convention violation shows up, the first command is not `git log` on the offending file. It is opening the startup-read protocol file for the role that keeps producing it and reading the governing sentence adversarially, as a literalist would. If a good-faith literal reading yields the defect, the sentence is the bug; the instances are its output, and sweeping them without editing the sentence schedules the eighth.

## Related conventions

- `agents/docs/solutions/conventions/conventions-in-solutions-dont-reach-implementer-context-2026-05-18.md` — the entry this refines. It covers the *silent* startup file (a link fills a gap); this one covers the *contradictory* startup file (a link leaves the wrong sentence load-bearing). Read them together: the discoverability check it prescribes should ask what the startup path *says*, not only whether it *mentions*.
- `agents/docs/solutions/conventions/i18n-stubs-added-vs-updated-scope-never-translated-keys-2026-06-09.md` — the correct rule, and the entry whose unexecuted Related-section instruction is the concrete evidence for rule 3 above. Its content needed no revision; only its delivery did.
- `agents/docs/solutions/conventions/hold-block-must-not-contradict-convention-docs-2026-04-22.md` — the architect-side sibling: a hold block that contradicts a convention doc makes the implementer build the wrong thing faithfully. Same failure shape (an authoritative instruction outranks a correct doc the reader never opens), different surface (a task file rather than a startup file).
- `agents/docs/solutions/conventions/signal-block-on-first-review-move-ambiguity-2026-05-18.md` — a live sibling instance: `agents/backend/CLAUDE.md`'s re-review-signal section disagrees with a convention entry, and that entry deferred reconciling it to the architect backlog rather than fixing it in place. Worth closing rather than letting it decay the same way.
- `agents/docs/solutions/conventions/convention-enforcing-fix-must-audit-its-own-new-code-2026-05-17.md` — audit the replacement, not just the flagged site. Applied here to prose: the carve-out paragraph had to avoid re-introducing an anchor-rot form, so it cites the invariant by name with a stable container riding along rather than by line number or task slug.
- `agents/docs/solutions/conventions/positional-anchor-stable-named-container-carve-out-2026-05-20.md` — the rule the carve-out paragraph's "this file states below" phrasing is written against, and the reason this entry cites section names rather than line numbers throughout.
- `agents/docs/solutions/conventions/symmetric-walker-convention-application-audit-prototype-holds-2026-05-05.md` — same family from the other direction: the convention doc's text can be one round behind the strongest form of the rule. Here the doc was ahead of the protocol file, and the protocol file won at write time because it is the one that gets read.
- `agents/docs/solutions/conventions/completeness-claim-tasks-need-independent-re-enumeration-2026-06-14.md` — the counts here (five keys, 75 duplicated pairs, 90 surplus lines) are re-derived from the tree with the grep above rather than copied from the task file's table; re-run it rather than trusting these numbers after the sweep lands.
- `agents/docs/solutions/conventions/convention-sweep-syntactic-form-misses-semantic-siblings-2026-05-21.md` — a sweep scoped to one syntactic form misses siblings. A sweep scoped to instances, rather than to the sentence that generates them, misses all future instances, which is the stronger version of the same miss.
