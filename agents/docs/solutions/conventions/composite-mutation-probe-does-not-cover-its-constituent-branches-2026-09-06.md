---
title: "A composite mutation probe proves the mechanism is load-bearing as a whole, not that each branch, operand, or short-circuiting arm is individually covered"
date: 2026-09-06
category: conventions
module: frontend/tests/unit/eslint/enclosing-symbol.js + architect re-review intake
problem_type: convention
component: testing_framework
severity: high
applies_when:
  - "A guard's self-test suite already CLAIMS to mutation-kill a detection mechanism (a docblock, completion signal, or aggregate probe count says so) and the only evidence offered is that deleting the whole mechanism reddens a probe"
  - "A single composite probe covers a multi-decision-point detection block: several boolean operands, several ORed conditions, or a multi-arm branch tree"
  - "A guard has short-circuiting fast-path arms and every existing probe reaches it through a route that trips an earlier arm before the later ones execute"
  - "Re-reviewing a guard added as the fix for a prior hold on this same defect class, where the check now has to go one level deeper than the hold went"
tags:
  - conventions
  - canary-tests
  - mutation-resistance
  - composite-probe
  - branch-coverage
  - short-circuit
  - silently-disarmed-guards
---

# A composite mutation probe proves the mechanism is load-bearing as a whole, not that each branch, operand, or short-circuiting arm is individually covered

## Context

A frontend source-discipline canary leans on a shared textual-resolution helper, `enclosingSymbol` in `frontend/tests/unit/eslint/enclosing-symbol.js`, to name the declaration that encloses each matched line. Two of its internal branches were reviewed for self-test coverage using the same method: delete the mechanism, watch a probe go red, call it covered.

The closing-brace walk inside `enclosingSymbol` gained running block-comment tracking (an `inBlockComment` flag with an opener test, a region-exit test, and the closing-brace test itself) so that a `}` written inside a comment is not mistaken for the end of a real block. One probe exists for this: a `}` sitting at the declaration's own indentation, inside a block comment, between the declaration and the target line. Deleting the tracking wholesale turns that probe red. But mutating the region-exit test's predicate from `includes('*/')` to `endsWith('*/')`, or dropping the single-line-comment guard from the opener test, both leave the whole suite green while changing what a real file resolves to.

Separately, the declaration guard for `(`-initialized variable assignments has three ways to decide "this is a function": a `function`-keyword test, an arrow test, and a paren-counting fallback for wrapped parameter lists. Every probe that reaches this guard also happens to have unbalanced parens on the declaration line, so the paren-counting fallback alone accounts for every test's verdict. The keyword-and-arrow test is composite-green but individually unreachable to failure: deleting it changes no assertion's outcome.

The same module had already been held once for exactly this defect class: two branches with no discriminating probe between them. That gap was flagged and held for the implementer, never dismissed or accepted as a cost-of-doing-business tradeoff (session history). The fix for that hold added probes for those two branches, and in the same change introduced the three new block-comment-tracking branches described above, landing back in the identical gap one level in. The natural repair ("this branch is unprobed, add a probe for it") does not generalize to branches the repair itself introduces.

## Guidance

When a guard, hook, or canary is defended by a mutation probe, do not stop at "deleting the mechanism reddens some test." That only proves the composite depends on the mechanism as a whole; it says nothing about any individual condition, operand, or short-circuiting arm. Verify coverage per decision point instead:

1. Enumerate every decision point in the code under test: every `if`, every operand of a boolean expression, every arm of a guard clause or short-circuiting `&&` / `||`.
2. For each decision point, find (or write) the probe whose outcome flips when THAT operand alone is mutated, with every other operand held at whatever value the probe already gives it.
3. Pay particular attention to short-circuiting expressions where a fallback can silently subsume an earlier test. If every existing probe that reaches a guard also satisfies the fallback condition on its own, the earlier test is decorative.

Concretely, from the two branches above:

- The closing-brace walk's block-comment tracking has three decision points: the opener test (`trimmed.startsWith('/*') && trimmed.indexOf('*/', 2) === -1`, the second clause existing specifically so a comment that opens and closes on one line is not treated as a multi-line opener), the region-exit test (`if (inBlockComment) { if (trimmed.includes('*/')) inBlockComment = false; ... }`), and the closing-brace test that only runs outside a tracked comment. The existing probe exercises all three but only along one path through each: its opener line never closes on the same line, and its exit line matches under either `includes` or `endsWith`. Two more probes discriminate them: one where a block comment closes mid-line with code following it (`endsWith('*/')` would wrongly leave `inBlockComment` set), and one where a single-line, self-closing block comment sits directly above a real closing brace (without the opener's second clause, that self-closing comment is misread as opening a multi-line region, and the following genuine `}` gets swallowed as comment interior instead of ending the block).

- The declaration guard is `if (/\bfunction\b|=>/.test(line)) return true;` followed by a paren-count fallback. Both probes that currently reach this guard and expect `true` have strictly more `(` than `)` on that line, so the fallback alone would produce the same verdict, and the keyword-or-arrow test never gets to be the deciding factor. The discriminating probe is one where that test is the only thing that can produce the right answer: a target inside `const handler = () => {`, whose parens already balance (one open, one close), so paren-counting alone would say "not a declaration" and only the `=>` test says otherwise.

Do not treat "I mutated the whole mechanism and a test went red" as a substitute for this per-operand pass. It answers a different, easier question.

**Withdraw the demand when a branch is genuinely unkillable.** This check produces a list of candidate gaps, not a list of required probes. A branch whose mutation is semantically equivalent over the declared input domain has no discriminating probe to write, and asking for one is asking for a test that cannot fail. That has already happened once here: a hold asked for null-and-undefined mutation kills on an epoch-check seam, the implementer showed the two forms were identical over the declared domain, and two reviewers independently confirmed the pushback before the demand was dropped (session history). Verify unkillability rather than assuming it, then record the argument instead of the probe.

## Why This Matters

Detection code fails silently when it has a bug: no runtime crash, no user-facing symptom, nothing that surfaces the defect except someone manually re-deriving the missing case later, usually well after the regression it was meant to catch has already shipped. Its own self-tests are often the ONLY thing standing between a broken detector and a permanently green, permanently useless gate. That makes composite-only verification specifically dangerous here in a way it is not for ordinary code: "I ran a mutation test and it went red" reads as proof, closes the review finding, and removes any further incentive to look at the individual branches.

The failure is not hypothetical elsewhere in this code family either. A separate review found that deleting all five branches of a fresh-auth fix left two full suites green at 29 of 29 and 203 of 203 (session history). A whole-mechanism probe would have called that covered too.

The recurrence is the strongest evidence this needs to be a standing check rather than a one-off fix. The same module was already held once for two branches with no discriminating probe. The repair added probes for exactly those two and, in the same breath, introduced three new branches under one composite probe, landing in the identical gap one level in. That is not the same mistake happening twice by coincidence; it is the natural consequence of a repair strategy that has no mechanism for catching branches the repair itself creates. Only a per-operand check applied at review time closes that loop.

## When to Apply

**The trigger is an accuracy gap in coverage that is already claimed, not an invitation to retrofit per-branch mutation tests onto every guard.** This entry follows the same narrowing the corpus already applies to control-pair coverage: when a suite (or a docblock, or a completion signal) already asserts that it mutation-kills a mechanism, an undiscriminated branch makes that existing claim incomplete, and closing it is an accuracy fix. Demanding per-branch probes for a guard whose suite never claimed to discriminate it is preemptive hardening and keeps its default-dismiss bar. See `behavior-change-coverage-gap-not-preemptive-hardening-2026-06-10.md` for the discriminator and `control-pair-pins-only-varied-axis-enumerate-mutation-space-2026-06-12.md` for the template.

Within that scope, apply the per-operand check to code whose PURPOSE is to detect, where a defect produces no symptom other than silence: a source-discipline canary, an ESLint or lint rule, a CI gate, a commit hook, or any assertion whose only companion is its own self-test suite. Run it when:

- reviewing a new or changed guard before it is archived or merged, especially one added as the fix for a prior hold on the same defect class;
- a composite mutation probe is the only evidence of coverage cited in a review, commit message, or self-review note;
- the guard contains a short-circuiting boolean expression or an early-return chain with more than one condition, which is precisely the shape where a fallback quietly subsumes an earlier test.

Do not extend this to guards with a single decision point (nothing to discriminate), to ordinary business-logic tests (a wrong branch there surfaces through downstream behavior, integration tests, or a bug report), or to branches shown to be semantically unkillable.

## Examples

**Before.** A review confirms the closing-brace walk's block-comment tracking is covered by deleting the tracking and observing the existing probe go red. Conclusion recorded: "block comment handling is covered." This is the composite-only check, and it is where the earlier review stopped.

**After, per decision point.**

- Mutate the region-exit test from `trimmed.includes('*/')` to `trimmed.endsWith('*/')`. The existing probe's exit line is exactly `'    */'`, which satisfies both predicates, so the suite stays green. A file where a comment closes mid-line, such as `'    */ return value;'`, now resolves the wrong enclosing symbol under the mutation. Gap: needs a probe with trailing code after the `*/` on the same line.
- Drop the opener test's single-line guard (the `&& trimmed.indexOf('*/', 2) === -1` clause). The existing probe's opener line never closes on the same line, so the suite stays green. A single-line, self-closing block comment sitting directly above a genuine closing brace now gets misread as opening a multi-line comment region, swallowing that brace and resolving downstream lines to a stale, already-closed declaration. Gap: needs a probe with a same-line-closed block comment immediately preceding a real closing brace.

**Before, the declaration guard.** Coverage cited as: a parenthesized-expression probe (guard correctly returns false) plus a wrapped-arrow and a wrapped-async-call probe (guard correctly returns true).

**After, per decision point.** Both true-returning probes have unbalanced parens on the declaration line, so the paren-count fallback alone explains every recorded true verdict and the keyword-or-arrow test is never the deciding factor. Deleting that test changes no assertion. Gap: needs a probe where it is the only thing that can save the declaration, such as a target inside `const handler = () => {`, whose parens already balance and which paren-counting alone would misresolve as not-a-declaration.

## Related

- `mutation-probes-are-per-site-not-per-fix-2026-08-31.md` is the orthogonal axis. It enumerates the N parallel or twin SITES one fix lands at, and traces which site a fixture's posture routes execution to. This entry enumerates the N BRANCHES inside ONE guard's control flow, and traces which branch an input drives execution through. Both conclude that an aggregate probe proves less than it appears to.
- `control-pair-pins-only-varied-axis-enumerate-mutation-space-2026-06-12.md` is the closest methodological cousin, one level down: a present-or-absent control pair proves only the axis it varies and misses operator weakenings of a single comparison. It also supplies the preemptive-hardening narrowing this entry adopts.
- `eslint-custom-rule-unwrap-arms-need-compound-form-canary-2026-05-16.md` is the closest prior art in the same domain: a branch inside a custom-rule resolver reads as covered while the test actually reaches it by another path. The mechanism differs (visitor descent rather than boolean short-circuit); the lesson that reaching a guard is not proof of reaching a branch of it is the same.
- `tests-must-fail-on-mutation-of-code-under-test-2026-04-22.md` is the root principle this family specializes. The contribution here is that revert-verifying the WHOLE mechanism does not transfer to any ONE of its constituent branches.
- `source-discipline-canaries-must-assert-at-call-site-not-file-granularity-2026-08-26.md`, `fail-closed-does-not-transfer-from-set-equality-to-pairing-canaries-2026-08-31.md`, and `source-discipline-canary-detection-must-survive-ordinary-authoring-shapes-2026-08-31.md` are the three rungs governing what a source-discipline canary collects, compares, and detects over the tree. This entry sits one layer beneath all three: it governs the probes over the shared resolver machinery those canaries are built on.
- `behavior-change-coverage-gap-not-preemptive-hardening-2026-06-10.md` is the standing triage default this entry is scoped against.
- The frontend resolver is a deliberate hand-port of `backend/tests/support/enclosing-symbol.ts`, ratified as dialect divergence rather than consolidated. A branch-coverage gap found in one dialect's shared logic is worth checking against the other.
