---
title: "Completeness-claim tasks need an independent working-tree re-enumeration before archive"
date: 2026-06-14
category: conventions
module: architect code review + completeness/sweep task review + ce-code-review project-standards lens
problem_type: convention
component: development_workflow
severity: high
related_components:
  - testing_framework
  - documentation
applies_when:
  - "Reviewing a task whose value is completeness: 'covers all N pages/call-sites/files', 'verified', 'a FULL enumeration', or a sweep that reports 'clean'"
  - "Reviewing a fix that extracts or introduces a reusable helper/mixin/base-class to fix a bug class (sibling sites may still carry the pre-fix shape)"
  - "Reviewing a sweep/migration/re-anchor across 'src + tests', all routes, every handler, or a named identifier family"
  - "Production and test files were touched together and the task asserts both are covered"
  - "Deciding whether to archive a task in tasks/review/ on the basis of its self-reported scope count"
tags:
  - completeness-claim
  - coverage-verification
  - re-enumeration
  - grep-bug-shape
  - helper-extraction
  - diff-scoped-review-blindspot
  - architect-review
  - false-clean
---

# Completeness-claim tasks need an independent working-tree re-enumeration before archive

## Context

PEvO runs the architect, backend, and ui agents concurrently; the architect owns
code review and archive of implementer task files in `tasks/review/`. A recurring
class of task is the **completeness/coverage task**: "sweep anchor-rot across src +
tests," "convert all redirect-initiating pages to the shared guard," "re-anchor
every wrong-symbol docblock." These carry a self-reported scope claim — a
hand-written table or sentence like "all four redirect-initiating pages
(verified)," or a sweep that simply reports "clean."

The defect mode is **incompleteness by omission**. The committed diff is correct:
every site the implementer found is fixed properly. What is missing is a sibling
the implementer never enumerated — a fifth page with the byte-identical bug, an
identifier-prefix family the grep never matched, a production source whose test
sibling got swept but which itself did not.

The trap: a diff-scoped review — even a thorough multi-persona `/ce-code-review`
fan-out — **structurally cannot catch this.** The omission is, by definition, not
in the diff. Reviewers reading only the changed lines see clean, correct work and
approve. The left-behind site is invisible to anyone who only reads what changed.

Two instances surfaced in a single review pass:

1. A UI bfcache "stuck loading button" fix shipped a shared guard mixin
   (`createOrcidRedirectGuard`) and a scope table asserting all four
   redirect-initiating pages (signup/recover/login/settings) were covered and
   verified. A **fifth** page (accreditation) had the identical bug — loading flag
   set `true`, then `window.location.href`, reset only in the `catch`. The
   committed code was clean; the fifth page was caught only because review personas
   independently grepped the working tree for the **bug shape**, not the diff.
2. A comment-anchor-rot sweep claimed "a FULL enumeration first," but its grep
   under-reached the identifier-prefix families (matched some prefixes, missed
   others, and missed a soft "see task" redirect form), leaving in-scope rot in
   unswept files — including production sources whose test siblings *were* swept.
   The complete miss list came only from the reviewer's own widened independent
   re-grep.

## Guidance

For any task whose value proposition is completeness — "covers all N," "swept the
tree," "converted every call-site," a "clean" sweep result — **the reviewer MUST
run an independent working-tree re-enumeration as a distinct review step before
archiving. Never trust the task's own count.**

- **Re-derive scope from the tree, not from the task body.** Do not read the
  "covers all five (verified)" line and check those five. Independently enumerate
  the full population from the current working tree with your own search, then diff
  your population against what the task touched.
- **When the fix extracts a reusable helper/mixin to fix a bug *class*, grep for
  the ORIGINAL BUG SHAPE — the pre-fix pattern — across the whole tree, not the
  cited sites.** The helper's existence is the signal that a class of siblings may
  exist; unconverted siblings still carry the old shape. The cited sites are
  converted and won't match; the missed siblings will. This is the single
  highest-yield check for "introduces a shared fixer" tasks.
- **Widen every enumeration axis.** For identifier/prefix sweeps, enumerate ALL
  prefix/identifier families and ALL soft-redirect forms, not the subset the
  implementer happened to grep. For call-site/page sweeps, enumerate ALL siblings
  matching the bug shape, including production sources whose test siblings were
  swept (and vice versa).
- **A persona fan-out grepping the working tree corroborates but does not replace
  the rule.** `/ce-code-review` personas that independently grep the tree are how
  both instances were actually caught — but they are confirmation, not the gate.
  The gate is the architect's own independent re-enumeration.
- **On any miss, do not archive on the task's own count.** Either hold the task
  with the specific missed sites listed, or split a follow-up that fixes the
  omissions (reusing the same helper the task introduced, if applicable). Where a
  rot class recurs, the durable fix is a CI diff-gate; until one exists for a given
  class, the manual independent re-enumeration is the only backstop. (A CI
  diff-gate for the comment-anchor sub-case has been filed as an architect
  follow-up.)

## Why This Matters

A completeness task's whole point is that the *last* missed site is the one that
bites in production. The bfcache bug on the fifth page is exactly as user-visible
as on the other four — a permanently stuck loading button on a redirect-initiating
page. A comment anchor left rotting in a production source is exactly the rot the
sweep existed to eliminate. Archiving on the self-reported count signs off "done"
while the original failure mode is still live, and the task file — the record that
would have prompted a re-sweep — is now deleted.

The deeper point is **where review power comes from.** Diff review is excellent at
"is this change correct" and useless at "is this change complete," because
completeness is a property of the *whole tree relative to the change*, not of the
change. A self-reported scope count and a diff review are the same blind spot
stacked twice: both look only at what was done, neither looks at what was skipped.
Independent re-enumeration is the only step that looks at the population the task
claimed to cover.

## When to Apply

Before archiving any `tasks/review/` task whose success criterion is
coverage/completeness rather than a single localized behavior. Signals:

- The task body contains a scope claim ("covers all N," "verified all
  pages/files/call-sites," "a FULL enumeration," "clean / no remaining instances").
- The fix introduces or extracts a shared helper, mixin, base class, or utility to
  fix a bug class (the helper implies siblings).
- The task is a sweep/migration/re-anchor across "src + tests," "all routes,"
  "every handler," or a named identifier family.
- Production and test files were touched together and both are asserted covered.

Do NOT spend the re-enumeration budget on a task scoped to a single named site or a
localized behavior change with no completeness claim — there is no population to
re-derive.

## Examples

What the task claimed vs. what the tree held:

```
Task body claim:    "Converted all four redirect-initiating pages to
                     createOrcidRedirectGuard (signup, recover, login,
                     settings) - verified."
Diff review verdict: clean (all four conversions correct)
Independent grep:    accreditation page still carries the pre-fix shape
                     -> 5th site, byte-identical bug, invisible to diff review
```

The high-yield check — grep the ORIGINAL bug shape, not the cited sites. The cited
sites are already converted to the helper, so they will NOT match the pre-fix
pattern; the unconverted siblings will:

```bash
# The fix extracted createOrcidRedirectGuard. Don't grep the helper name
# (that finds converted sites). Grep the PRE-FIX SHAPE across the whole tree:
#   loading flag set true -> window.location.href -> reset only in catch
rg -n --type js 'location\.href' frontend/src
# inspect each hit: a converted site goes through the mixin; an unconverted
# sibling sets its own loading flag and resets only on catch -> that is the miss
```

Widen every prefix/identifier family — don't inherit the implementer's grep
breadth:

```bash
# Under-reaching first pass (what the task ran): one prefix family only
rg -n 'FOO-[a-z-]+' src tests
# Independent re-enumeration: ALL families + soft-redirect forms, then diff the
# population against the files the task touched (watch a production source whose
# TEST sibling was swept)
rg -n '\b(FOO|BAR|BAZ)-[a-z-]+\b' src tests
rg -n 'see (task|the task file)|\.md' src tests
```

## Related

- `[[convention-sweep-syntactic-form-misses-semantic-siblings-2026-05-21]]` — the syntactic-construct axis of this rule (grep the dangerous pattern, not the construct the original instance lived in); closest sibling to "grep the bug shape, not the cited sites."
- `[[sweep-acceptance-grep-under-enumerates-slug-prefix-families-2026-06-08]]` — the slug-prefix-regex axis; one of this entry's two evidence sources. This entry generalizes it: enumerate ALL families for ANY completeness claim, not only slug prefixes.
- `[[convention-enforcing-fix-must-audit-its-own-new-code-2026-05-17]]` — the inverse axis: that entry catches rot the fix ADDED forward into the diff; this one catches bug shapes the fix LEFT BEHIND outside the diff. Both halves of the same diff-scoped blind spot; both are needed.
- `[[wrapping-primitive-exhaustive-call-site-audit-2026-04-22]]` — grep the underlying primitive across all source files to find sites the wrapper missed; the bug-shape grep here is the same primitive aimed at siblings never converted to the new helper.
- `[[helper-contract-flip-untouched-adopter-audit-2026-05-16]]` — when a shared helper's contract flips, the audit set is ALL call sites; complement to this entry's "siblings never adopted at all."
- `[[cross-surface-parity-audit-at-sibling-composition-sites-2026-05-14]]` — "widen your enumeration rings before declaring an out-of-scope frontier"; supplies the ring-walking structure the independent re-enumeration should follow.
- `[[coverage-claim-downgrade-requires-codebase-search-2026-05-21]]` — a coverage CLAIM must be verified by codebase search, not taken verbatim; same "the claim is the artifact, search before trusting it" discipline, applied to a downgrade.
- `[[completion-note-coverage-claim-run-suite-at-intake-2026-05-26]]` — run the suite at intake because completion-note claims are unverified; the grep-side analogue of that run-the-suite-side rule.
- `[[enumerated-exemption-lists-are-drift-vectors-2026-04-28]]` — a hand-written "covers all N (verified)" scope table is itself a drift-prone enumeration, which is why an independent re-enumeration is needed rather than trusting the table.
- Commits: `f5297ac2` (the four-page guard fix whose scope table missed a fifth page) and `bbe6607c` (the anchor sweep whose acceptance grep under-reached prefix families) — illustration only; the durable lesson is the independent re-enumeration step, not these SHAs.
