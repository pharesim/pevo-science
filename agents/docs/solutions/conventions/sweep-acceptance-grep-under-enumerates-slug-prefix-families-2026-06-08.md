---
title: "Comment-anchor sweep acceptance-greps under-enumerate PEvO's slug-prefix families"
date: 2026-06-08
category: conventions
module: backend tests/src comment-hygiene + sweep-task acceptance criteria + ce-code-review project-standards lens
problem_type: convention
component: development_workflow
severity: medium
related_components:
  - testing_framework
  - documentation
applies_when:
  - "Writing or reviewing a comment-anchor-rot sweep task (removing task-slug citations, round-N markers, line-number anchors, section anchors)"
  - "Specifying an acceptance grep or audit grep for any convention sweep over backend/frontend source or tests"
  - "An implementer reports a sweep is clean because a grep returned zero hits"
  - "Reviewing a sweep at /ce-code-review and verifying the rot classes the task committed to remove are actually gone"
tags:
  - comment-anchor
  - anchor-rot
  - task-slug
  - acceptance-grep
  - convention-sweep
  - false-clean
  - slug-prefix
---

# Comment-anchor sweep acceptance-greps under-enumerate PEvO's slug-prefix families

## Context

PEvO comment-anchor-rot sweep tasks (removing forbidden anchors from production/test source per root `CLAUDE.md` "Comment anchors") routinely ship an "acceptance grep" the implementer runs to prove the sweep is complete. The recurring failure is that this grep enumerates only ONE task-slug-prefix family — `BACKEND-` — while PEvO source uses several. A grep that returns zero hits then reads as "clean" while real, in-scope rot survives.

Observed instance (2026-06-08 architect review of the anchor-rot-sweep cluster): the `backend-anchor-rot-sweep-signup-verify` task's acceptance criterion #3 was

```bash
grep -nE "BACKEND-[A-Z]|round-[0-9]|\.ts:[0-9]+|§ ?[0-9]+\.[0-9]+|see the task|task acceptance"
```

That pattern matches `BACKEND-…` but NOT the `SEC-` prefix. So the implementer's "zero hits" was technically true, yet two `describe('SEC-004-BE: ORCID signup + confirm …')` titles in `backend/tests/routes/signup-verify.test.ts` survived untouched — even though the same task's prose had EXPLICITLY listed "`SEC-004-BE deliverable` style invocations" as targets. The `/ce-code-review` project-standards persona caught them at review and the task was held.

This is not a one-off. The same under-match is why a separate `backend-anchor-rot-sweep-bridge-tests` task had to exist at all (its `BE-BRIDGE-WRITE-HAF-LAG` slug was invisible to a `BACKEND-[A-Z]` grep), and that bridge file still carried a `SEC-002-TOCTOU-LOCK` slug plus a `tasks-archive.md` redirect after its sweep. The fresh-auth-custody sweep cleared a `project_single_instance_only` memory-slug pointer that no `BACKEND-`-anchored grep would have found either. At least three sweep tasks in one cluster were affected.

## Guidance

When writing or auditing a comment-anchor-rot sweep, use a grep that enumerates EVERY slug-prefix family and redirect form PEvO uses, not just `BACKEND-`. The canonical complete pattern:

```bash
grep -nE "BACKEND-[A-Z]|BE-[A-Z]|UI-[A-Z]|SEC-[0-9]|round-[0-9]|\.ts:[0-9]+|§ ?[0-9]+\.[0-9]+|project_[a-z_]+|see the task|task acceptance|tasks-archive" <files>
```

What each added alternation catches that `BACKEND-[A-Z]` alone misses:

- `BE-[A-Z]` — `BE-BRIDGE-WRITE-HAF-LAG`, `BE-LOG-PII-EMAIL-HASH`, `BE-AUTH-RESUME-SIGNUP-TIMING-GUARD` style labels.
- `SEC-[0-9]` — `SEC-004-BE`, `SEC-002-TOCTOU-LOCK` deliverable/security slugs.
- `UI-[A-Z]` — frontend-side task slugs (`UI-…`).
- `project_[a-z_]+` — memory-slug pointers (`project_single_instance_only`) that the comment-anchor convention also forbids as non-durable.
- `tasks-archive` — "see `<slug>` in tasks-archive.md" redirects, which are doubly rot-prone because the archive trims at 250 lines and drops the target.

Two companion rules:
- The grep is a NECESSARY screen, not a sufficient one. The describe-title misses above were also named in the task's own prose; a reviewer must check the rot classes the task COMMITTED to (its Scope/prose), not just whatever pattern the acceptance step happened to print. Treat any narrow `BACKEND-[A-Z]`-only acceptance grep as suspect on sight and re-run the widened pattern before trusting a "zero hits" claim.
- A sweep can meet a narrow grep and still be incomplete; conversely it may legitimately leave adjacent rot it deliberately scoped out. Distinguish an **in-scope miss** (the task's prose committed to the class, the grep was too narrow to see it) from **adjacent deferred rot** (the task scoped itself elsewhere on purpose) before holding vs archiving.

## Why This Matters

The harm is false confidence. A green acceptance grep is the artifact an implementer cites to move a task to `review/` and an architect could (wrongly) cite to archive it. When the grep under-enumerates, the rot the task was specifically filed to remove ships anyway, the task archives as "done," and the leftover slug/line-number anchor keeps rotting — defeating the entire point of the sweep. Because the misses are slug labels the prose already named, they are exactly the cases where the task author believed coverage was guaranteed.

This is the grep-pattern-specific instance of the general principle in `convention-sweep-syntactic-form-misses-semantic-siblings-2026-05-21`: that doc warns that scoping a sweep by code CONSTRUCT (CTE builders vs inline `pool.query`) misses semantic siblings; this one warns that scoping a sweep by a single SLUG-PREFIX REGEX misses semantic siblings expressed under other prefixes. Same class of error (audit scoped by surface form), different axis.

## When to Apply

- Authoring any comment-anchor-rot sweep task — put the widened pattern in the acceptance criteria, not `BACKEND-[A-Z]` alone.
- Reviewing a sweep in `tasks/review/` at `/ce-code-review` — re-run the widened pattern over each touched file before trusting the implementer's "zero hits"; cross-check against the rot classes the task's prose enumerated.
- Any convention audit where violations are identified by a prefix/keyword family that has more than one spelling in the codebase.

## Examples

**Under-enumerated grep (false-clean):**

```bash
# Acceptance criterion as written in the signup-verify sweep task
grep -nE "BACKEND-[A-Z]|round-[0-9]|\.ts:[0-9]+|§ ?[0-9]+\.[0-9]+|see the task|task acceptance" \
  backend/tests/routes/signup-verify.test.ts
# → 0 hits. Reported "clean." But two describe('SEC-004-BE: …') titles remained.
```

**Widened grep (catches the real rot):**

```bash
grep -nE "BACKEND-[A-Z]|BE-[A-Z]|UI-[A-Z]|SEC-[0-9]|round-[0-9]|\.ts:[0-9]+|§ ?[0-9]+\.[0-9]+|project_[a-z_]+|see the task|task acceptance|tasks-archive" \
  backend/tests/routes/signup-verify.test.ts
# → flags both SEC-004-BE describe titles. Hold, don't archive.
```

## Related

- `[[convention-sweep-syntactic-form-misses-semantic-siblings-2026-05-21]]` — the general principle (audit scoped by surface form misses semantic siblings). This entry is the slug-prefix-regex axis of the same error; that one is the code-construct axis.
- `[[convention-enforcing-fix-must-audit-its-own-new-code-2026-05-17]]` — companion audit-completeness rule: catch new rot the fix itself introduces (the audit-own-replacement check), where this entry catches in-scope rot the fix's grep was too narrow to see.
- `[[task-slug-citations-in-comments-go-stale-on-archive-2026-05-15]]` — why task-slug citations (all prefix families) are forbidden in source in the first place.
- `[[docblock-anchor-stable-symbols-not-line-numbers-2026-05-15]]` — the line-number-anchor rot class the same greps screen for.
- Root `CLAUDE.md` "Comment anchors" — the convention these sweeps enforce.
