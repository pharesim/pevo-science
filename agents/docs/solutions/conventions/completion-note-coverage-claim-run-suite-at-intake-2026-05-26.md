---
title: "Completion-note coverage claims are unverified — run the suite at review intake"
date: 2026-05-26
category: conventions
module: code-review
problem_type: convention
component: development_workflow
severity: high
applies_when:
  - "Architect review intake on a task whose completion note or signal block claims the suite is green, no test covers X, or no existing test asserted the old behavior"
  - "Reviewing a diff that reworks a function which has an existing test file the diff did not touch"
  - "A behavior change removes or replaces a state mutation, or adds calls to shared stores/services that test mocks may not implement"
related_components:
  - testing_framework
  - documentation
tags:
  - completion-notes
  - coverage-claim
  - review-intake
  - test-regression
  - architect-discipline
  - run-the-suite
  - behavior-change
  - factual-verification
---

# Completion-note coverage claims are unverified — run the suite at review intake

## Context

A behavior change landed in `handleEmailDelete` (`frontend/src/pages/settings.js`).
The old implementation patched `this.emailStatus = { hasEmail: false, ... }`
optimistically after the DELETE call. The rework replaced that patch with a full
session teardown: `Alpine.store('auth').disconnect()`,
`Alpine.store('notifications').stop()`, `Alpine.store('toast').show(...)`, and
`this.navigate('/')`. The task completion note stated, as the justification for not
touching tests: "no existing test asserted the old delete behavior."

That claim was false. The `describe('handleEmailDelete')` block in
`frontend/tests/unit/pages-settings.test.js` — a file the diff never touched —
contained `it('deletes email and resets state')`, which asserts
`expect(comp.emailStatus.hasEmail).toBe(false)`. The mock store in that file has no
`disconnect` method and the Alpine-store mock returns `{}` for the `'notifications'`
key. On the success path, `Alpine.store('auth').disconnect()` throws "undefined is
not a function" into `handleEmailDelete`'s catch block; the catch sets `emailError`
and returns; `emailStatus` is never patched; the assertion fails because `hasEmail`
is still `true`. Suite RED.

A second test, `it('preserves hasPassword on delete ...')`, passed only by accident:
the thrown disconnect left `emailStatus` untouched, so its `hasPassword` assertion
held. It had become a ghost — passing under both the old contract and the
exception thrown by the new one, carrying no signal either way.

The false negative was caught at architect review intake. The `/ce-code-review`
correctness and testing personas flagged the stale tests by reading the test file,
and the architect then ran `npx vitest run tests/unit/pages-settings.test.js -t
handleEmailDelete`, which returned "1 failed" — establishing ground truth rather
than trusting the completion note or the persona reasoning alone.

## Guidance

At `/ce-code-review` intake, run the relevant test suite — do not rely on reading
the diff plus the completion note. Treat every coverage claim in a completion note
or signal block, positive ("tests are green", "npm run build passes") or negative
("no existing test asserted X", "no test covers this path"), as an unverified
assertion until the suite output confirms it.

Concrete intake step:

1. From the diff, identify the test file(s) for the changed module (e.g.
   `frontend/tests/unit/pages-settings.test.js` for a change in
   `frontend/src/pages/settings.js`).
2. Run narrow first: `npx vitest run <test-file> -t '<describe block>'`. If green,
   widen to the full file, then the module's suite.
3. On any failure, read the failure output before continuing the review. Do not
   assume the failure predates the diff — assume it is caused by the diff until
   proven otherwise.
4. A RED suite from a pre-existing test in an untouched file is a blocking finding,
   the same as a logic error in the diff. Send the task back to `pending/` with a
   hold block requiring an in-scope green-up (the implementer's preference is to fix
   self-caused regressions in-scope, not defer them).

The `/ce-code-review` personas read the test file and can flag stale assertions, but
they cannot know that `Alpine.store('notifications')` resolves to `{}` at runtime in
that fixture. The suite run is the ground-truth check the persona analysis only
approximates; it is not a substitute for it, and it is not optional.

## Why This Matters

A behavior change that drops a pre-existing contract (here, the `emailStatus`
optimistic patch) leaves its test RED only in the test file, not in the diff. The
diff looks complete — the implementation is internally consistent, the success path
coherent, the error handling present. Nothing in the diff signals the break. The
only thing that surfaces it at review time is running the suite.

The ghost-test failure mode compounds the risk: a test that passes by accident
(because an exception thrown on the new path leaves state unchanged in a way that
still satisfies an assertion written for the old path) is a green result that
actively misleads. Reading the assertion and tracing execution is the only way to
notice — unless the suite run already showed you a sibling test failing in the same
block.

Negative coverage claims that justify skipping test updates ("no existing test
asserted the old behavior") carry the highest risk precisely because they supply a
rationale for not looking. The negative claim is often wrong in exactly this way:
the test exists, it asserts the old contract, and it is now red.

## When to Apply

Apply at every `/ce-code-review` intake where any of these hold:

- The completion note or signal block asserts test state in any form (green suite,
  passing build, no coverage of X, "tests not needed").
- The diff changes a success path — what a handler does after its primary operation
  succeeds.
- The diff removes or replaces a state mutation (a field assignment, flag reset,
  patch object) without touching a test file.
- The diff adds calls to shared stores or external services (Alpine stores, toast,
  router, auth) that test mocks may not implement.

The last two are the precise pattern here: a new call on a store the test mock
returns as `{}` throws on the success path, runs the catch block, and produces a
failure that reads like an error-path failure rather than a success-path mock gap.

## Examples

**Before:** `handleEmailDelete` patched `this.emailStatus = { hasEmail: false, ... }`
on success, and `it('deletes email and resets state')` asserted
`expect(comp.emailStatus.hasEmail).toBe(false)` — a direct assertion on that patch.

**After:** `handleEmailDelete` calls `Alpine.store('auth').disconnect()` on success.
`mockAuthStore` defines `isConnected`, `username`, `loginFromResponse`, and others —
but no `disconnect`. Calling `.disconnect()` throws; control jumps to the catch;
`emailStatus` is never patched; the assertion fails because `hasEmail` is still
`true`.

**The fix (in-scope green-up):** add `disconnect: vi.fn()` to `mockAuthStore`, add a
notifications-store mock exposing `stop: vi.fn()` and wire it into the `Alpine.store`
dispatch for `'notifications'`, then rewrite the happy-path test to assert the new
teardown contract (`disconnect` called, `stop` called, the account-deleted toast
shown, `navigate('/')` called) instead of the removed `emailStatus` patch. Give the
ghost `preserves hasPassword` test a meaningful assertion against the new contract or
remove it.

**The intake sequence that caught it:** read the diff; note the success path now
calls `Alpine.store('auth').disconnect()`; check whether `mockAuthStore` defines
`disconnect` (it does not); run `npx vitest run tests/unit/pages-settings.test.js -t
handleEmailDelete`; see "1 failed"; file a hold block before reading further.

## Related

- `agents/docs/solutions/conventions/coverage-claim-downgrade-requires-codebase-search-2026-05-21.md`
  — direction-complementary sibling, same root cause (an unverified negative
  coverage claim), different artifact site and enforcement point. That convention
  governs the implementer's write-time discipline for coverage claims in test-file
  headers (search the codebase before negating); this one governs the architect's
  intake-time duty (run the suite) when a completion note makes a coverage claim.
- `agents/docs/solutions/conventions/tests-must-fail-on-mutation-of-code-under-test-2026-04-22.md`
  — implementer-side prevention layer. If implementers verify their tests fail on a
  reverted property, the pre-existing-test-RED scenario surfaces during their own run
  rather than at architect intake. This convention is the architect-side backstop
  when that did not happen.
- `agents/docs/solutions/conventions/mutation-kill-claims-must-match-assertion-and-corpus-2026-05-15.md`
  — adjacent: enforces factual accuracy of coverage claims against running
  assertions and corpus data. Different granularity (what a test would catch under
  mutation vs whether the suite passes at all), same discipline of verifying claims
  against running code.
- `agents/docs/solutions/conventions/implementer-self-verify-signal-block-sha-2026-05-04.md`
  — structural parallel: a claim in a task-coordination artifact (a cited SHA) that
  is unverified and turns out false. Implementer-side is "verify your SHA"; this is
  the architect-side analog for suite-state claims.
- `agents/docs/solutions/conventions/stale-review-intake-verify-spec-at-head-2026-05-15.md`
  — same actor and moment (architect at review intake), adjacent duty: verify spec
  compliance at HEAD rather than only reading the diff. This adds a second intake
  check — run the suite — when the completion note makes coverage claims.
- `agents/docs/solutions/conventions/re-review-intake-green-suite-not-held-item-completion-2026-06-09.md`
  — successor for held-item completion. Running the suite (this convention)
  establishes that the claimed green state is real; that successor adds that a real
  green suite is still not evidence the held items landed. Four held-item classes
  (type-derivation refactors, structured-log-field renames, add-a-test-for-X items,
  single-source abstractions met at the type layer only) pass typecheck/lint/tests
  whether or not they landed and need a per-item diff audit. Do not stop at "run the
  suite" when the claim is held-item completion.
