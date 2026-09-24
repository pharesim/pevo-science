---
title: "Mutation probes and discriminating tests are per site, not per fix: a fixture's incidental posture silently selects which twin branch a probe proves"
date: 2026-08-31
last_updated: 2026-09-24
category: conventions
module: frontend/tests + architect re-review intake
problem_type: convention
component: testing_framework
severity: high
root_cause: incomplete_enumeration
resolution_type: workflow_improvement
applies_when:
  - "Landing one fix at N parallel or twin sites (mutually exclusive page branches, duplicated orchestrator gates) and claiming probe or discriminating-test coverage for it"
  - "Running a mutation probe against one named test to back a per-item verification claim, where the fixture's incidental posture (custody, isContinuation, memo state) selects which site executes"
  - "Architect re-review intake on a task whose signal block claims a probe or discriminating test for a fix spanning more than one site"
  - "Writing a discriminating test for a gate that has a twin at a sibling call path or page branch"
  - "Verifying whether reverting one site's fix alone would leave the suite green"
symptoms:
  - "Reverting one twin site's change alone leaves the suite green while the named probe test still passes"
  - "A per-item verification claim fails at exactly one site, across consecutive hold rounds"
  - "Every test that reaches the branch under claim runs with a fixture posture that routes execution through the sibling site instead"
  - "The twin gate's only coverage lives in a sibling suite, not in the suite cited by the claim"
related_components:
  - development_workflow
  - frontend_stimulus
tags: [mutation-testing, per-site-probes, fixture-selection, twin-sites, re-review-intake, coverage-verification, hold-cycle, discriminating-tests]
---

# Mutation probes and discriminating tests are per site, not per fix

## Context

When a fix lands at N parallel sites (two mutually exclusive page branches, twin orchestrator gates in sibling files), the verification claim "revert the fix, the named test fails" is a per-fix claim. But a test exercises exactly one path through the code, and which site that path visits is decided by the fixture's incidental posture: which custody kind the mocked auth store carries, which branch a getter like `isContinuation` resolves to given the fixture's paper shape, what a memoized factor answer left behind, whether an assertion like "run() was never called" structurally confines the test to the code before the first commit attempt. A probe run against one named test therefore proves only the single site that test's fixture happens to select. The claim "fix reverted, named test fails" can be simultaneously true for the fix and false for one of its sites, and the suite stays green with that site's guard deleted.

This surfaced as three per-site verification misses across consecutive re-review rounds on the frontend fresh-auth surface, each one a per-item claim failing at a site the named test never visited: one round found the refuse-while-open branches (five sites, per that round's hold record) all deletable with the suite green (the test suite now records this history in its own words: "without them the busy branches are deletable with every suite still green", the "Refuse-while-open (busy) discriminates from a cancel" section comment in frontend/tests/unit/lib-settings-fresh-auth.test.js), and the following rounds on the two sibling tasks found the two instances documented under Examples below. The two tasks involved (the light-account reauth-window task and the hasPassword-factor-divergence task) are provenance only; the pattern is general to any fix with parallel sites.

The procedural shape of the miss (session history): the implementers' probe passes were real and disciplined (committed baseline, one mutation script per item, named test confirmed red, restore), but results were reported as aggregate counts ("17 mutation probes, all killed") with no per-site breakdown, and each miss was found afterward by an architect-side reviewer deleting the branch and re-running the suite, never self-reported by the probe pass that preceded it.

## Guidance

**Implementer, before claiming probe or test coverage for a fix:**

1. Enumerate every separately deletable site of the fix. A site is any code location where the fix could be reverted independently while the others stand: each arm of an if/else that received the same guard, each twin file in a mirrored pair (`authorship-consent.js` / `settings-fresh-auth.js` are such a pair), each gate in a sequence, each branch of a sentinel dispatch.
2. For each site, name one discriminating test whose fixture PROVABLY selects that site. "Provably" means you traced the fixture's posture through the branch-selecting code: read the getter or gate that routes execution (the `isContinuation` getter, the `custody !== 'light'` short-circuit in `ensureSessionWindow`) and confirm the fixture's values land on the site in question. The test title is not evidence; the fixture's routing is.
3. Run the revert-one-site probe per site: revert only that site's change, confirm the named test fails, restore. Commit the fix before probing (a harness restore wipes uncommitted edits; this is already documented probe discipline).
4. State the site list explicitly in the completion signal: "site 1: symbol/branch, discriminated by test name because fixture posture; site 2: ...". A bare "probed, test fails on revert" is a per-fix claim and will be re-derived at intake anyway; an aggregate probe count carries even less.

**Reviewer (architect) at re-review intake:**

1. Re-derive the site list from the code, not from the signal. Grep for the fixed construct (the option name, the sentinel constant, the guard call) and enumerate every occurrence; check sibling files for twins of the touched orchestrator.
2. For each site, open the named test and verify the fixture's selection posture actually routes to it. The thing to verify is the posture, not the test title: titles describe intent, fixtures decide branches.
3. Treat "the twin has a test" as a per-twin question. A dedicated test in one file of a mirrored pair says nothing about its sibling.

**Posture axes that decide branch selection in this codebase** (check each against the site's routing code):

- **Custody kind.** `ensureSessionWindow` returns a ready-with-no-proof outcome before consulting any option when the auth store's custody is not `'light'` (the `Alpine.store('auth')?.custody !== 'light'` first line of `ensureSessionWindow`, frontend/src/lib/fresh-auth.js), and `withAuthorshipFreshAuth` runs the broadcast with no proof at all for self-custody (its `ctx.custody !== 'light'` early return, frontend/src/lib/authorship-consent.js). A fixture that never sets `custody = 'light'` short-circuits every downstream fresh-auth site.
- **Branch-selecting getters.** The `isContinuation` getter routes on `username` vs `paper.author`, the `versions[]` chain walk, and the `head_author`/`head_permlink` pointers (frontend/src/pages/edit.js:459-484). A fixture's paper shape silently picks the submit branch.
- **Memoized state.** The password-factor answer is memoized per username per tab; a prior test's observation decides a later test's factor unless cleared (see the `clearPasswordFactorMemo()` call and its comment in the `beforeEach` of frontend/tests/unit/pages-edit.test.js). The retry gate deliberately reuses the memo ("the 401 retry gate reuses the memoized factor instead of a second status read", frontend/tests/unit/lib-authorship-consent.test.js), so the memo's content is itself a branch selector.
- **Stored session state.** Whether a live window proof sits in sessionStorage decides whether acquisition (and hence any of its option handling) runs at all.
- **Assertion confinement.** An assertion that a mocked collaborator was never invoked (`expect(run).not.toHaveBeenCalled()`) structurally restricts the test to the code that executes before that collaborator; no retry-path or post-commit site can be under such a test, whatever its title says.
- **Which exit a linear sequence takes.** Where one branch runs the same effect at two points, the fixture's exit (an unmount mid-await, a rejecting collaborator, an early return, or falling through to the end) decides which of them the assertion observed. See `discriminating-spec-must-select-an-exit-only-the-probed-layer-serves.md`.

## Why This Matters

The failure is invisible to every signal that normally carries trust. The suite is green with the missed site's guard deleted. The implementer's per-item claim is honest: the probe was run, the named test did fail on revert, just not for every site the fix covers. Only re-deriving the site list from the code exposes the gap, and each miss discovered at re-review costs a full hold round (task moved back to pending, fix, move to review, re-review).

The stakes in the concrete instances were not cosmetic: the unguarded sites controlled `allowRedirect` suppression on pre-broadcast gates and ORCID fallbacks. Reverting one meant a passwordless account could be bounced into a full-page OAuth navigation that discards completed IPFS pins and in-flight form state, exactly the destructive outcome the fix existed to prevent, on the branch the tests never visit.

## When to Apply

- Any fix applied to parallel branches, mirrored files, or repeated gates: the same option added in two arms of a conditional, the same sentinel handled in a twin orchestrator, the same guard added to N call sites.
- Any completion signal claiming "probed per item" or "tested per page": the unit of proof is the site, so a per-item claim over multi-site items still needs per-site enumeration.
- Architect intake of held-task re-review signals, alongside the existing disciplines of independently re-enumerating "covers all N" claims from the tree and re-auditing sweep completeness against sibling-task surfaces (a parallel task can add the N+1th site of the same class after the enumeration was made).

## Examples

Both instances verified against the tree on 2026-08-31; every file:line below is as of that date and has since drifted. Both gaps have since been closed, and the second instance's twin structure no longer exists: `pages-edit.test.js` gained a continuation-posture twin of the same-author test that asserts `comp.isContinuation` is true before exercising the gate, `lib-authorship-consent.test.js` gained "an assumed password rejected at the RETRY mint also redirects rather than dead-ending", and the duplicated retry gate itself was consolidated into the shared `consentOpFreshAuthRetryGate` in `frontend/src/lib/fresh-auth.js` that both surfaces now delegate to. Read the instances as worked examples of the miss, not as a map of the current tree.

**Instance 1: the fixture that selects the wrong twin branch.** `frontend/src/pages/edit.js` has two mutually exclusive pre-broadcast gates passing `allowRedirect: false`, one in the continuation branch (edit.js:1151, inside `if (isContinuation)` at edit.js:1121) and one in the same-author native-edit branch (edit.js:1238, in the `else` at edit.js:1197). The discriminating test "a passwordless window closing during the uploads refuses without navigation" (frontend/tests/unit/pages-edit.test.js:1777) drives the `unchangedLightComponent` fixture (pages-edit.test.js:1673-1708), whose paper has `author: 'alice'` with `username = 'alice'`, self-pointing head fields, and no `versions[]`. Traced through the `isContinuation` getter, that posture takes the single-post fallback `return this.username !== this.paper.author` (edit.js:479) and resolves false, so the test exercises only the same-author gate. The tests that DO reach `isContinuation === true` (e.g. the continuation-path timer test at pages-edit.test.js:199, which sets `username = 'bob'` against `author: 'alice'`) never set `custody = 'light'`, and the real fresh-auth module runs in this suite (pages-edit.test.js:23), so they short-circuit at the custody gate in `ensureSessionWindow` (fresh-auth.js:731) before `allowRedirect` is ever consulted. Net effect, confirmed at re-review by mutation probe: reverting `allowRedirect: false` at the continuation gate alone left the suite green. The fix had two sites; the signal named one test.

**Instance 2: the assertion that confines the test to the initial gate.** `frontend/src/lib/authorship-consent.js` handles the `FRESH_AUTH_ORCID_FALLBACK` sentinel at two sites: the initial-gate fallback inside `resolveProof` (authorship-consent.js:90-92) and the retry-gate fallback inside `withAuthorshipFreshAuth`'s catch block (authorship-consent.js:161-163). The only ORCID-fallback test, "an assumed password the backend rejects at the mint falls back to the ORCID redirect" (frontend/tests/unit/lib-authorship-consent.test.js:228), asserts `expect(run).not.toHaveBeenCalled()` (lib-authorship-consent.test.js:241). The retry gate is reachable only after `run(proof)` has been called and thrown `FRESH_AUTH_REQUIRED` (authorship-consent.js:132, 139), so the run-never-called assertion structurally pins this test to the initial gate; the two retry-gate tests that do exist (lib-authorship-consent.test.js:203, 215) resolve the retry mint successfully and never select the fallback branch. The retry site had no discriminating test. Its twin shows what the missing test looks like: `frontend/src/lib/settings-fresh-auth.js` has the same retry gate (settings-fresh-auth.js:173-176), and "an assumed password rejected at the RETRY mint also redirects rather than dead-ending" (frontend/tests/unit/lib-settings-fresh-auth.test.js:390-400) selects it provably by rejecting the first `run()` with `FRESH_AUTH_REQUIRED` (line 395) and the second mint with a 401 (lines 392-394), then asserting `{ redirect: true }` with `run` called exactly once. Twin files, same construct, one discriminated and one not: per-twin enumeration is what catches it.

## Related

- `tests-must-fail-on-mutation-of-code-under-test-2026-04-22.md` — the revert-verify foundation this refines: its "revert the single line the spec is about" phrasing implicitly assumes one site; this entry says enumerate the sites first.
- `mutation-kill-claims-must-match-assertion-and-corpus-2026-05-15.md` — closest sibling: fixture posture silently selecting what a test exercises, within one site (fixture on the wrong side of a size gate); this entry extends the mechanism from fixture-selects-branch to fixture-selects-site.
- `control-pair-pins-only-varied-axis-enumerate-mutation-space-2026-06-12.md` — the same meta-move on a different axis: it enumerates the weakening space of one comparison; this entry enumerates the site space of one fix.
- `defense-in-depth-canary-must-pin-each-layer-2026-05-07.md` — the vertical counterpart: one canary per defending layer along a single path; this entry is the horizontal version, one probe per parallel twin site.
- `object-shape-fix-every-reset-site-2026-04-21.md` — the fix-side twin: a multi-site bug fix must cover every site; this entry applies the same enumeration to the verification probes.
- `completeness-claim-tasks-need-independent-re-enumeration-2026-06-14.md` — the generic intake move (re-derive the population from the tree, never trust the claimed count); this entry instantiates it for probe site lists and adds the fixture-posture check.
- `re-review-intake-green-suite-not-held-item-completion-2026-06-09.md` — the intake-side frame this adds a gate-blind class to: a per-fix probe leaves a twin site deletable under a green suite.
- `sampling-an-unordered-collection-is-mutation-blind-to-a-truncating-batch-2026-08-26.md` — sibling mutation-blindness mechanism within one assertion, and the documented home of the committed-baseline probe discipline referenced in Guidance step 3.

- `discriminating-spec-must-select-an-exit-only-the-probed-layer-serves.md` — the depth counterpart to this entry's breadth: where one branch runs the same effect at two points, choosing the site to revert is only half the design, because the fixture's exit decides which point the assertion saw.
