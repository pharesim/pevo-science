---
title: Mutation-kill claims in test headers and convention docs must match what the assertion actually catches against the corpus the test sees
date: 2026-05-15
last_updated: 2026-06-14
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
  - Claiming a canary that imports a shared production helper or constant "pins" or "mutation-kills" the production call site
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

### Construction class determines mutation class

A recurring special case on the wiring axis: how a canary is *constructed* bounds which mutation class it can possibly catch, independently of how exhaustive its cases look. Three constructions look equivalent and are not:

1. **Interpolate the production constant** into test-local SQL/predicate text — catches constant/charset drift only. A production change that drops the wrapper *around* the constant ships green.
2. **Import or build from the shared production helper** (test and production both call the same function) — catches a mutation inside the helper *body*. It does NOT catch a **call-site bypass**: production stops calling the helper and inlines the pre-fix shape, helper untouched, test still green (it builds from the still-correct helper).
3. **Exercise the production call site** (real-path), or assert structurally that production routes through the helper — the only construction that catches a call-site bypass.

A self-contained negative control that hardcodes the pre-fix shape (e.g. a raw `=` predicate written inline in the test) *demonstrates the delta* but reads no production code, so it detects no production mutation at all. So when the claim is "this canary pins the production predicate," name which of the three it actually is, and never claim call-site-bypass coverage from a constant-import, helper-import, or self-contained negative-control test. See the "Helper-import canary" example below.

### Probabilistic detection: a mutation two of whose outputs usually land in the same value bucket

Point 3 of the triple ("is the comparison value held constant under the mutation?") has a probabilistic variant worth its own attention: a mutation can produce a value that is *usually but not always* indistinguishable from the un-mutated value, so the kill is **probabilistic, not deterministic** — and a passing run does not prove the mutation is caught.

The instance that surfaced it: a real-app-Postgres round-trip test asserts a reissued JWT's `reissuedAt` equals `sessions_invalidated_at.getTime()` read back from Postgres. The same assertion is claimed to kill two regressions in the `recover.ts` reissue writer:

- **Seconds-rounding** the embedded value (`floor(ms/1000)*1000`) changes the millisecond on essentially every run — the assertion goes red **deterministically**.
- **Switching the write from a captured Node `Date` to SQL `NOW()`** is caught only **probabilistically**: the just-captured Node `Date` and the statement's `NOW()` usually land in the **same millisecond bucket** (~96% of local runs), so the round-tripped value matches the embedded value and the mutant survives the assertion most of the time. Suite retries compound the survival.

So "this round-trip test kills a NOW()-switch" is false as an unconditional claim; co-listing "NOW()/seconds-rounding" as equivalent detectors overstates coverage. When a mutation-kill claim covers two regressions that differ in **granularity** (a sub-second precision loss vs a same-instant-different-source swap), verify EACH empirically — do not assume a test that deterministically kills the coarser mutation also kills the finer one. The honest phrasing names which is deterministic and which is probabilistic, and states that the suite must not be relied on as the detector for the probabilistic one. The general rule: any mutation whose two outputs share a quantization bucket (a timestamp truncated to ms, a rounded amount, a hash mod N) is a probabilistic kill at best — pin it with a deterministic fixture (a fixed constant differing in the relevant digit) rather than a live same-instant comparison.

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

### Branch-reachability gated by fixture size (size-threshold subtype)

**Overstated** (from UI-E2E-EDIT-PAPER-FLOW round-2 hold-fix landing at commit `407ce10`):

> "Mutation-killed: production always broadcasts full body via `expect(commentBody.body.startsWith('@@')).toBe(true)`."

The assertion is well-formed and the mutation class is real (`edit.js:1063` has `broadcastBody = diffText.length >= newPostBody.length ? newPostBody : diffText` — dropping the length-gate by always returning `newPostBody` is a concrete mutation to kill). What the round-2 claim missed: the test 1 fixture had `_originalBody=104 chars` and a `NEW_BODY=146 chars` wholesale replacement. `diff-match-patch` produces a diffText of ~290 chars > 146, so production's length-gate falls through to the full-body fallback unconditionally. `body.startsWith('@@')` is `false` on UNMUTATED code → assertion fails on the un-mutated path → the mutation never has a chance to be killed because the assertion was never green to begin with.

The architect's round-3 re-review caught this via cross-reviewer (correctness P1/95 + testing P1/95 each with diff-match-patch reproductions). The diff-branch coverage was structurally absent until the fixture body was enlarged.

**Corrected** (round-3 fix at commit `5b9ff3d`):

The fixture body grew from ~100 chars to ~1.2KB (4 paragraphs: Introduction, Methodology, Results, Discussion). `NEW_BODY` was rewritten as additive rather than wholesale (start from the prefilled body + append one sentence to Discussion). After the change: `_originalBody=1237`, `newPostBody=1339`, `diffText=187`, ratio 0.140 — production now takes the diff branch, `commentBody.body.startsWith('@@')` is `true` on unmutated code, and removing the length-gate (always full body) flips it to `false`. Clean kill.

**The structural pattern:** when production has a size-gated branch (`diffText.length < newPostBody.length`, `body.length > THRESHOLD`, etc.), the test's fixture must produce data that lands on the intended side of the gate. If the fixture sits on the wrong side, the branch under test is unreachable, the assertion fails on unmutated code, and the mutation-kill claim is structurally vacuous in a particularly nasty way — the test fails red on the un-mutated path AND on the mutated path, indistinguishable. A reviewer skimming "test asserts `body.startsWith('@@')`, diff branch covered" assumes the test is green and the mutation is killed; the reality is the test was never green and the branch was never reached.

Before landing a size-gated branch-coverage claim, run the production transform against the test fixture and verify the gate fires the way you expect. For diff-match-patch specifically:

```js
const dmp = require('diff-match-patch').diff_match_patch ? new (require('diff-match-patch').diff_match_patch)() : new (require('diff-match-patch'))();
const diffs = dmp.diff_main(original, modified);
const diffText = dmp.patch_toText(dmp.patch_make(original, modified));
console.log({ originalLen: original.length, modifiedLen: modified.length, diffLen: diffText.length, takesDiffBranch: diffText.length < modified.length });
```

Verify `takesDiffBranch` matches the branch the test claims to exercise BEFORE committing the spec.

### Scope ambiguity

**Overstated** (from BE-ACCOUNT-CREATION-LOGGER-SPY-REAL-PATH-COMPANION dismissal doc, "both regex arms positively covered"):

> "Both regex arms positively covered (consensus-rejection site)."

True for the throw-translation behavior. Misleading for the warn-log emission: the warn-spy assertion runs only on the arm-1 test.

**Corrected:**

> "Both regex arms positively covered for the throw-translation behavior, with the warn-log assertion landing on arm 1 (source structure places `warn` outside any arm-specific branch, so a single positive assertion plus the negative-pin guard kills the slug+level+err mutations on both arms)."

States WHAT is covered on each arm and WHY single-arm coverage suffices structurally.

### Helper-import canary kills the helper body, not the call-site bypass (construction-class subtype)

This subtype is notable because the overclaim survived the architect's own prescribed fix and recurred across three re-review rounds — the canary kept *looking* like it pinned production while catching a strictly narrower mutation class.

A reputation-cycle canary was meant to pin that the ORCID auto-accept arm BTRIM-normalizes the broadcaster-controlled chain ORCID before matching the attested value. Its construction migrated up the three levels above, and each migration was over-described:

- **Round 3→4 (constant-import):** the canary only interpolated the production constant `CHAIN_ORCID_BTRIM_CHARSET` into its own inline SQL. A production-side revert of the BTRIM wrapper shipped green (the constant was unchanged) — claim "the canary pins the production arm" was false.
- **Round 4 fix (helper-import):** the predicate was extracted into a shared `chainOrcidAutoAcceptMatchSql` builder that both production arms and the canary call. The canary now kills a mutation inside the builder *body* (drop the BTRIM → the tab-padded case reds). Correct as far as it goes.
- **The re-overclaim:** the round-4 test comment then said a raw-`=` negative control "catches an inline call-site revert even if the helper is untouched." It does not. The negative control hardcodes the pre-fix raw shape and asserts non-match; it reads no production code, so if production's arm is reverted to an inline raw `=` with the builder left intact, every sub-case (built from the still-correct builder) stays green.

**Corrected claim:**

> "The canary builds its predicate from the production `chainOrcidAutoAcceptMatchSql` builder, so a mutation inside the builder body (e.g. dropping the BTRIM wrapper) reds the tab-padded case. A call-site bypass — production inlining a raw `=` instead of routing through the builder — is NOT caught by this canary or by the raw-`=` negative control; closing that requires a real-path exercise of the production arm or a structural 'production routes through the builder' assertion. The negative control demonstrates the BTRIM-vs-raw delta; it is not a production mutation detector."

**Two sibling instances from the same review batch** (different surfaces, same root failure of claiming more than the construction catches):

- **Absence assertion vacuous on an empty corpus.** Two live-HAF regression tests asserted `.not.toContain(orphanPermlink)` and `meta.total === data.length` against one paper, with no positive-presence assertion on that paper. If the handler can return a silent empty `[]` (e.g. it swallows query errors), a silent-empty listing passes both green and the mutation-kill fires only when the paper is non-empty — the standard fix is a positive-presence floor (`expect(data.length).toBeGreaterThan(0)`) on the same paper so the absence assertion cannot pass vacuously. **Boundary — when the same-fixture floor is neither feasible nor required.** If the under-test corpus's CORRECT result is legitimately empty, a same-paper floor cannot be written (the orphan-parent paper's only accredited comment IS the orphan being hidden, so the endpoint correctly returns `[]`; there is no accredited non-orphan sibling on that paper to assert presence on). The absence assertion is still non-vacuous when two independent bail-paths are closed: (a) the handler **loud-fails** — `fetchCommentsFromHaf` throws `HafQueryError` (→ 503/500) instead of swallowing to `[]`, so `expect(res.status).toBe(200)` proves the query actually executed and the empty set is genuine, not a masked error; and (b) a **sibling positive-presence canary** elsewhere in the same suite (the `jesusalejos` paper canary asserting `.toContain(...)`) exercises the same descent path to a non-empty result, killing any mutation that silently collapses all rows to `[]`. The gate mutation the absence test actually targets — reverting the recursive-arm `EXISTS (active_accreditations)` descent gate — still reds it directly: the orphan's own author is accredited, so on the reverted gate it reappears and `.not.toContain` fails. Verify BOTH closures (read the handler to confirm loud-fail, not swallow; locate the sibling canary) before dropping the floor. Re-demanding a same-fixture floor that these two paths already cover is preemptive hardening — exactly the reflex to resist when the failure mode is already structurally closed. When either closure is absent (handler swallows to `[]`, or no sibling positive canary exists), the same-paper floor remains the fix.
- **Parity canary asserting each surface independently.** A SQL/JS name-supersession parity canary ran one set of inputs through the SQL projection and another through the JS helper, asserting each in isolation. A divergence on an input neither side exercised passes both. Cross-compare the SAME input through both surfaces and assert identical output.

## Related

- `agents/docs/solutions/conventions/tests-must-fail-on-mutation-of-code-under-test-2026-04-22.md` — the principle this complements. That doc covers writing assertions correctly; this doc covers describing them honestly.
- `agents/docs/solutions/conventions/real-path-companion-dismissal-criteria-2026-05-11.md` — generalized dismissal criteria for logger-spy clause (c). Its Examples section was the first site to apply this honesty principle (corrected at commit `a13f364`).
- `agents/docs/solutions/conventions/mock-guard-assertion-must-verify-call-shape-2026-04-21.md` — adjacent: when the assertion's mock-guard predicate doesn't pin the shape claimed, the kill is structurally absent. This convention covers the case where the kill is present but the description overstates the mechanism.
- `agents/docs/solutions/conventions/dedup-shared-constant-defeats-test-value-pin-2026-05-26.md` — the constant-import construction (level 1 of "Construction class determines mutation class") in its dedup-trigger form: when test and production both import the same constant, a mutation to the constant updates both sides and the value-pin goes tautological. Keep an independent literal pin alongside the constant-sourced assertion.
- `agents/docs/solutions/conventions/test-mock-carve-out-clause-c-2026-05-04.md` — its transform-vs-wiring axis is the coarser cut; the "Construction class determines mutation class" guidance above decomposes the wiring axis into constant-import, helper-import, and call-site-exercise.
- `agents/docs/solutions/conventions/control-pair-pins-only-varied-axis-enumerate-mutation-space-2026-06-12.md` — a construction-class instance for comparisons: a same-polarity presence/absence control pair kills the binary revert but is blind to operator and granularity weakenings of the comparison; enumerate the mutation space before stating the kill claim.
- `agents/docs/tasks-archive.md` BE-APP-SSR-REAL-PATH-COMPANION (when round-2 archives) — concrete instance of the corpus-conditional-kill case.
- `agents/docs/tasks/pending/ui-e2e-edit-paper-flow.md` (when it archives) — round-2 and round-3 hold cycles are the canonical instance of the size-threshold subtype. Round-2 landed the assertion against a fixture that failed it on unmutated code; round-3 enlarged the fixture body to make the diff branch reachable. The fix took two architect re-review rounds to surface because round-2's review accepted the structural assertion without running the production transform against the fixture.
