---
title: Mutation-kill claims in test headers and convention docs must match what the assertion actually catches against the corpus the test sees
date: 2026-05-15
category: conventions
module: backend
problem_type: convention
component: testing_framework
severity: medium
applies_when:
  - Writing or revising a test header / docblock that enumerates the mutation classes a spec kills
  - Updating a convention doc that generalizes mutation-kill criteria for a class of tests (logger spies, real-path companions, etc.)
  - Reviewing a real-path or wiring test whose load-bearing assertion runs against live corpus data
  - Auditing an implementer signal block that claims "covers mutation X" without showing the assertion mechanism
tags:
  - mutation-testing
  - test-claims
  - convention
  - documentation-fidelity
  - real-path-companion
  - corpus-conditional
related_components:
  - testing_framework
---

## Context

`agents/docs/solutions/conventions/tests-must-fail-on-mutation-of-code-under-test-2026-04-22.md` establishes the principle: tests must fail on mutations of the code under test. That doc covers the structural side — assertions must touch the mutated value, not just call counts or side-effect proxies.

What it does not address is the **fidelity** side: when a test header, convention doc, or task body enumerates which mutations are killed, that enumeration must match what the test's actual assertions catch against the actual corpus or data shape the test exercises. Three findings in BE-ACCOUNT-CREATION-LOGGER-SPY-REAL-PATH-COMPANION review and BE-APP-SSR-REAL-PATH-COMPANION review (2026-05-15) traced to the same root cause: claims about mutation kills were grounded in the production code's structure, not in what the assertion would actually do when the production code is mutated under the test's specific data conditions.

## Guidance

When writing or revising a mutation-kill claim — in a test file header, an implementer signal block, a convention doc's Examples section, or a task body's enumeration — verify each claimed kill by tracing this triple:

1. **The mutation.** What concrete edit to production code does the claim cover? Write it out: "swap `paperDisciplineField(x)` → `x` raw"; "drop the `logger.warn(...)` call before the throw"; "rename event slug literal".
2. **The assertion.** Which line(s) in the test would fail on that mutation? Cite the file and line. If the kill rides on a chain of multiple assertions, name all of them.
3. **The data the test sees.** What does the assertion compare? Is the comparison value held constant under the mutation, or does the mutation change it? If the corpus or fixture data is idempotent under the production transform (e.g., `trim + lowercase` applied to already-lowercase data), the mutation may produce a value indistinguishable from the un-mutated path — kill claim is false on that corpus.

When ANY of the three is unverified, weaken the claim. Use one of these honest phrasings:

- "The spy-was-called check transitively pins the warn-BEFORE-throw ordering: a mutation moving warn after the throw would suppress the call entirely, failing the assertion." (Names the actual mechanism rather than overstating it as a `mock.invocationCallOrder` assertion.)
- "Wiring-axis coverage: dropped import, short-circuited assignment branch, catch-all bypass. Transform-axis coverage (e.g., helper-self-mutation) is deferred to the mocked sibling that pins canon-lowering against a fixture corpus exercising the transform deterministically." (Names what IS covered and what isn't, instead of claiming both.)
- "Warn-log emission asserted on arm 1 only; arm-2's translation behavior is asserted but the warn-call is not. Mutation class is rare because the warn lives outside any arm-specific branch in source, but a regression that gates the warn on arm-1 phrasing alone would not be caught." (Honest about the asymmetry rather than smoothing it into "both arms covered.")

## Why This Matters

Mutation-kill enumerations get read by:

1. **Future reviewers** auditing whether a clause-(c) carve-out, hold-block fix, or convention doc actually delivered what it promised. If the enumeration overstates coverage, the reviewer either:
   - Misses the gap (trusts the claim, archives the task with the gap unaddressed), OR
   - Re-derives the analysis (wastes the review pass that the convention doc was supposed to short-circuit).

2. **The next implementer** writing a similar test. They inherit the overstated pattern: "this kind of test catches mutation X." Their copy carries the same false claim, and the cumulative trust in the convention degrades.

3. **The next audit cycle** under the same convention. If `agents/docs/solutions/conventions/real-path-companion-dismissal-criteria-2026-05-11.md` says "dismissal is appropriate when the mocked test mutation-kills the risk class," and that doc's own Examples section overstates one of the kills, future dismissals applying the doc's criteria inherit the same gap.

The convention `tests-must-fail-on-mutation-of-code-under-test-2026-04-22.md` covers the prevention side: write the assertion correctly the first time. This convention covers the **honesty** side: when you describe what the assertion does, describe it accurately. Both are needed; neither subsumes the other.

## When to Apply

- After landing a hold-fix or feature with claims like "this test kills mutation X." Before committing, walk the triple (mutation → assertion → data) for each claim.
- When invoking `/ce-compound` to capture a dismissal criterion or coverage convention. The Examples section is normative once readers cite it; pin to honest mechanisms, not aspirational ones.
- During architect `/ce-code-review` when the implementer's signal block enumerates mutation-kills. Spot-check 2-3 claims by reading the cited assertion and asking "what would the assertion compare on the mutated path?"
- When a test runs against live corpus data (HAF papers, real Hive responses, real Redis state) and the assertion uses any production transform on that data. Corpus-conditional kills are a recurring source of overstated claims.

Do NOT apply when:

- The test is purely synthetic (test-controlled fixtures only). The data is whatever the test makes it; corpus conditionality doesn't apply. The triple still works but step 3 is trivial.
- The claim is about an assertion that explicitly pins the post-transform invariant against a hand-coded expected value (e.g., `expect(canonLower('UPPER')).toBe('upper')`). The assertion's expected value is independent of the production transform, so the corpus doesn't matter.

## Examples

### Overstated → corrected

**Overstated** (from BE-ACCOUNT-CREATION-LOGGER-SPY-REAL-PATH-COMPANION dismissal doc, line 93 before fix at commit `a13f364`):

> "ordering (warn-BEFORE-throw) via spy call order"

This implied `mock.invocationCallOrder` was the mechanism. It wasn't — the test asserted `.rejects.toThrow(...)` and `warnSpy.toHaveBeenCalledWith(...)` separately.

**Corrected:**

> "ordering pinned by spy-was-called assertion (a mutation moving warn after the subsequent throw would suppress the call entirely, failing the spy check; no explicit `mock.invocationCallOrder` assertion is required)"

The kill is real. The mechanism is honest.

### Corpus-conditional kill false on the test's corpus

**Overstated** (from BE-APP-SSR-REAL-PATH-COMPANION test header lines 14-22 and task body lines 62-66):

> "Test catches the wiring mutation class the mocked test cannot: paperDisciplineField import reverted; `if (canonDiscipline) jsonLd.about = canonDiscipline;` short-circuited; **helper call replaced with raw `pevoMeta.discipline`**; SSR catch-all bypassing `injectPaperMeta`."

The 4 enumerated mutations cover the wiring axis. But `paperDisciplineField` is `trim + lowercase`. The test walks `/api/papers` and picks the first paper with a non-empty discipline string. PEvO's current corpus is all-lowercase per ARCHITECT-DISCIPLINE-FILTER-PUBLISH-CHARSET-ALIGNMENT. For lowercase data, `raw === paperDisciplineField(raw)`. If the production code at `backend/src/app.ts:355-356` is mutated to emit raw `pevoMeta.discipline` instead of the helper-routed value, the SSR output equals what the test expects. The assertion `expect(jsonLd!.about).toBe(expectedAbout)` passes green. The "helper call replaced with raw" mutation is NOT killed on the current corpus.

**Corrected** (reframe pending in BE-APP-SSR-REAL-PATH-COMPANION round-1 hold-block):

> "Wiring-axis coverage: dropped helper import (TS or import-extract surfaces); short-circuited `jsonLd.about` assignment branch (about=undefined → fails); catch-all bypass not reaching `injectPaperMeta` (jsonLd null → fails). Helper-self-mutation coverage (canon-lowering swap) is deferred to the mocked sibling `app-ssr-discipline-canon.test.ts` which pins the transform against a mixed-case fixture corpus that the real-path test cannot exercise on the production all-lowercase corpus."

The claim is now honest about what each axis catches and where the other axis is covered.

### Scope ambiguity

**Overstated** (from BE-ACCOUNT-CREATION-LOGGER-SPY-REAL-PATH-COMPANION dismissal doc, "both regex arms positively covered"):

> "Both regex arms positively covered (consensus-rejection site)."

True for the throw-translation behavior. Misleading for the warn-log emission: the warn-spy assertion runs only on the arm-1 test.

**Corrected:**

> "Both regex arms positively covered for the throw-translation behavior, with the warn-log assertion landing on arm 1 (source structure places `warn` outside any arm-specific branch, so a single positive assertion plus the negative-pin guard kills the slug+level+err mutations on both arms)."

States WHAT is covered on each arm and WHY single-arm coverage suffices structurally.

## Related

- `agents/docs/solutions/conventions/tests-must-fail-on-mutation-of-code-under-test-2026-04-22.md` — the principle this complements. That doc covers writing assertions correctly; this doc covers describing them honestly.
- `agents/docs/solutions/conventions/real-path-companion-dismissal-criteria-2026-05-11.md` — generalized dismissal criteria for logger-spy clause (c). Its Examples section was the first site to apply this honesty principle (corrected at commit `a13f364`).
- `agents/docs/solutions/conventions/mock-guard-assertion-must-verify-call-shape-2026-04-21.md` — adjacent: when the assertion's mock-guard predicate doesn't pin the shape claimed, the kill is structurally absent. This convention covers the case where the kill is present but the description overstates the mechanism.
- `agents/docs/tasks-archive.md` BE-APP-SSR-REAL-PATH-COMPANION (when round-2 archives) — concrete instance of the corpus-conditional-kill case.
