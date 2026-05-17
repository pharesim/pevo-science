---
title: "Two-commit Edit+mv hold-fix variant is compliant; reviewer dispatch must pass the full SHA range or risk false-positive PS-001"
date: 2026-05-17
category: conventions
module: agent-coordination
problem_type: convention
component: development_workflow
severity: low
applies_when:
  - "Reviewing an implementer's hold-fix where the task-file rename (mv to review/) and the content Edit are in separate commits rather than one"
  - "Running /ce-code-review on a hold-fix commit that contains only the code Edit, with the task-file mv landing in the next commit"
  - "ce-project-standards-reviewer (or any project-standards persona) flags 'task file still in pending/' based on the staged diff of the Edit commit alone"
  - "Assessing whether an intentional two-commit Edit-then-rename sequence violates root CLAUDE.md Shared-index race discipline item 3"
  - "Authoring or auditing hold-block commits as an implementer or as an architect re-review intake"
tags:
  - git
  - commit-discipline
  - hold-block
  - task-lifecycle
  - code-review
  - false-positive
  - mv-rename
  - project-standards
  - re-review-intake
related_components:
  - agents/docs/tasks
  - .githooks/commit-msg
---

## Context

Root `CLAUDE.md` "Shared-index race discipline" item 3 establishes a canonical one-commit hold-block shape: `Edit → git add <file> → git mv <src> <dst> → git commit`. The rule's stated purpose is specific: prevent `git mv` from recording pre-Edit content from the index when the Edit has not yet been staged. The failure mode it guards against is an *unintended* two-commit split where the first commit's subject says "round-N hold (Z items)" but its diff is a bare rename, with the Edit stranded as a separate unstaged `M`. The rule does not forbid two-commit splits per se; it forbids the accidental split that arises from staging out of order.

Observed implementer practice in the 2026-05-17 architect review of three UI tasks (`ui-orcid-callback-destroy-clear-return-to`, `ui-papers-orcid-null-fallback-verification`, `ui-accreditation-verify-retriable-handling`) revealed a consistent variant: an *intentional* two-commit split with *matching* subjects, where the content edit and the `git mv` land in separate commits by design, each describing exactly what its diff contains. This variant achieves the same index-content invariant as the canonical form (the rename always commits post-Edit content) by construction rather than by staging order, and is strictly safer in several respects. It is not a rule violation; it is a valid alternative shape.

A second hazard surfaced in the same session. The architect dispatched `/ce-code-review` against a single named Edit commit. The `ce-project-standards-reviewer` subagent, scoping only to that commit, never saw the sibling `git mv` commit. It flagged "Re-review signal appended in `pending/` instead of `review/`" as a P1 finding at confidence 100 — a false positive. The task file was in `review/`; the reviewer simply lacked the commit that moved it there. A sibling persona on the same review session correctly ruled no violation, producing an asymmetric outcome on identical evidence depending solely on whether the reviewer happened to look one commit downstream.

## Why This Matters

P1 false positives at confidence 100 are the most expensive class — they demand immediate engagement and look the most credible at first glance. The 2026-05-17 session produced two such PS-001 flags (one per Pattern-B task) that the architect had to triage against the sibling reviewer's correct ruling. Wasted token spend on the dispatch + manual filesystem cross-check + decision overhead, plus an architectural asymmetry where the same review session could either flag a Pattern-B fix as a rule violation or correctly archive it depending on which subagent happened to look further. Without this convention captured, the same false positive will recur every time an implementer uses Pattern B and the orchestrator dispatches single-SHA.

The root cause is not reviewer error; it is information incompleteness. A reviewer dispatched against a single Edit commit has no way to know a mv commit follows. Passing the full SHA range removes the ambiguity entirely: the reviewer sees the task file move to `review/` and no violation exists to flag.

## Guidance

**Pattern A (canonical — one commit, Edit staged before mv):**

```bash
git add tasks/pending/task-file.md
git mv tasks/pending/task-file.md tasks/review/task-file.md
git commit -m "ui(scope): round-N hold items landed"
# one commit; diff contains both the content edit and the rename
```

**Pattern B (intentional two-commit split — equally valid):**

```bash
# Commit 1: content edit only
git add tasks/pending/task-file.md
git commit -m "ui(scope): drop tautological null-orcid loop in pages-edit test"
# diff = Edit only; subject describes the Edit

# Commit 2: state transition only
git mv tasks/pending/task-file.md tasks/review/task-file.md
git commit -m "ui: mv task-file to review"
# diff = rename only; subject describes the rename
```

Pattern B is canonical-equivalent. Both forms satisfy the root `CLAUDE.md` index-content invariant — Pattern A by ordering, Pattern B by separation. Pattern B's two commits are strictly safer: the Edit lands fully committed before the rename runs, so the failure mode root `CLAUDE.md` warns about (rename committing pre-Edit content) is impossible by construction. Each commit's subject describes exactly what its diff contains, eliminating the "subject claims X, diff shows Y" mismatch the canonical rule was written to prevent. Do not flag Pattern B as a violation of item 3.

**When dispatching `/ce-code-review` on a hold-fix re-review, scope to the full SHA range since the prior architect review — not to the named Edit commit alone:**

```bash
# Wrong — single-SHA dispatch leaves the mv commit outside the review window:
/ce-code-review <single-edit-sha>

# Right — range dispatch gives persona subagents the complete implementer commit set:
/ce-code-review base:<prior-architect-review-sha>
# or: /ce-code-review <prior-architect-sha>..HEAD
```

The criterion is: every implementer commit since the last architect review must be inside the review window. A two-commit Pattern B split satisfies this only when both commits are in scope. If you must name a specific Edit commit in the orchestrator's prompt, also name or range-include the sibling mv commit — persona subagents do not query `git log` independently; their view of the change set is whatever SHA or range the orchestrator provides.

**For architect re-review intake**, the rule's success criterion is "the task file in `review/` contains the edited content," not "Edit and rename are in the same commit." When auditing a hold-fix's commit shape, verify the current filesystem state (`ls agents/docs/tasks/review/ | grep <slug>`) rather than inferring location from a single staged diff.

## When to Apply

- Any architect commit-shape audit of hold-fix moves (`review/` → `pending/` or `pending/` → `review/`) — treat Pattern B as canonical-equivalent, not as a two-commit deviation that requires explanation.
- Any `/ce-code-review` dispatch on a hold-fix re-review — default to passing the full SHA range from the prior architect review to current HEAD. Single-SHA dispatch is correct only when the implementer's full change set is confirmed to be one commit.
- Any `ce-project-standards-reviewer` (or equivalent persona) evaluating compliance with root `CLAUDE.md` "Shared-index race discipline" item 3 — the rule's success criterion is "rename commits post-Edit content," not "Edit and rename are in the same commit."
- Any architect intake of a `ce-project-standards-reviewer` finding that claims "task file remains in pending/" — verify against current filesystem state with `ls agents/docs/tasks/pending/ | grep <slug>` and `ls agents/docs/tasks/review/ | grep <slug>` before accepting the finding.
- When writing hold-block commits as an implementer — either Pattern A or Pattern B is acceptable. Pattern B is marginally preferable for long-lived tasks where independent revert of the content edit vs. the state transition is useful, but the choice is not noteworthy and does not need to be documented in the commit message.

## Examples

**Pattern B in the wild (2026-05-17 architect review session):**

```
ui-papers-orcid-null-fallback-verification (round-2 hold-fix):
  26aff60  ui(papers): drop tautological null-orcid loop in pages-edit test
    M frontend/tests/unit/pages-edit.test.js
    M agents/docs/tasks/pending/ui-papers-orcid-null-fallback-verification.md
  1dd8862  ui: mv ui-papers-orcid-null-fallback-verification to review
    R agents/docs/tasks/pending/... → agents/docs/tasks/review/...

ui-accreditation-verify-retriable-handling (round-3 hold-fix):
  ae8a137  ui(accreditation-verify): fix inverted preamble comment on concurrent-flights spec
    M frontend/tests/unit/pages-accreditation-verify.test.js
    M agents/docs/tasks/pending/ui-accreditation-verify-retriable-handling.md
  d59271a  ui: mv ui-accreditation-verify-retriable-handling to review
    R agents/docs/tasks/pending/... → agents/docs/tasks/review/...
```

Both pairs are well-formed. Pattern B is NOT a staging-discipline violation. The canonical rule's failure mode (rename committing pre-Edit content) is impossible in both — the Edit is fully committed before the rename operation runs.

**False-positive PS-001 vs. correct sibling ruling, same review session:**

```
ce-project-standards-reviewer scoped to ae8a137 only (single-SHA dispatch):
  [P1 / confidence 100] CLAUDE.md rule #8 violation: re-review signal appended
  in pending/. The commit appends a "UI re-review signal" block to
  agents/docs/tasks/pending/ui-accreditation-verify-retriable-handling.md but
  does NOT perform a git mv to tasks/review/. The task file remains in pending/
  after this commit (confirmed by filesystem state).
  → FALSE POSITIVE. Commit d59271a (immediately following) moves the file to
    review/. The reviewer's scope excluded the mv commit. The "filesystem
    state" claim was inferred from the staged diff at ae8a137, not from a
    current ls of the working tree.

ce-project-standards-reviewer on a sibling task in the same session:
  "Two-commit split (Edit in 26aff60, mv in 1dd8862): Compliant. Root CLAUDE.md
  shared-index discipline item 3 guards against committing a rename before
  staging the edit; splitting them into two sequential commits eliminates that
  risk entirely and is strictly safer than the single-commit canonical form."
  → CORRECT. Same convention, same review session, opposite conclusion from
    the same reviewer persona — driven entirely by whether the reviewer
    happened to consider the next commit.
```

**SHA-range dispatch vs. single-SHA dispatch:**

```bash
# Exposes the false-positive class
/ce-code-review 26aff60
# Reviewer sees: Edit commit only. Task file still in pending/ at that SHA.
# Flags rule #8 violation.

# Avoids the false-positive class
/ce-code-review base:<prior-architect-sha>
# Reviewer sees: Edit commit (26aff60) + mv commit (1dd8862) + any other
# implementer commits since the architect's last review. Task file reaches
# review/ within the range. No violation.
```

## Related Conventions

- Root `CLAUDE.md` "Shared-index race discipline" item 3 — the canonical one-commit shape this convention extends. The new convention is additive; root `CLAUDE.md` describes only the accidental two-commit failure mode and does not name the intentional two-commit variant.
- `concurrent-agent-staging-sweep-2026-05-12.md` — sibling discipline on the same shared-index axis, focused on cross-session contamination (broad `git add` sweeping sibling staged paths) rather than within-session sequencing. Both cite root `CLAUDE.md` item 3 as the parent rule.
- `parallel-agent-git-index-race-2026-05-15.md` — sibling discipline on the inter-agent index race; orthogonal to the single-agent two-commit shape covered here.
- `re-review-intake-supersession-check-2026-05-05.md` — same architect intake checkpoint, different axis (supersession by parallel follow-up tasks). Both mandate a SHA-range check before reviewer dispatch.
- `agents/architect/CLAUDE.md` "Re-review cycle" — "run `/ce-code-review` on the new diff scoped to the commits since the hold block was written" implicitly covers Pattern B, but does not name the variant or warn about the single-SHA dispatch failure mode. This convention is the explicit form.
