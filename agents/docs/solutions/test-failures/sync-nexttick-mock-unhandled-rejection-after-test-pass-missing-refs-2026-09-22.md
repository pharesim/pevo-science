---
title: "Vitest exits 1 on an all-green suite: a synchronously mocked $nextTick runs a real async mount whose rejection lands after the test"
date: 2026-09-22
category: test-failures
module: frontend/tests/unit
problem_type: test_failure
component: testing_framework
symptoms:
  - "vitest printed `Test Files 86 passed (86)` and `Tests 1911 passed (1911)` yet exited 1, with an `Errors 3 errors` line two lines under the Tests count"
  - "three passing tests each left behind an unhandled rejection carrying `TypeError: Cannot read properties of undefined (reading 'abstractEditor')`, reported only after the test had already been scored as passed"
  - "the three affected tests were exactly the ones reaching loadPaperData's success path with _mounted = true and no $refs on the mocked component; the sibling failure-path test in the same region never scheduled the mount and never rejected"
  - "implementers reading only the Tests count reported the suite green; the exit code and the Errors line went unread until an isolated-copy run checked them"
root_cause: async_timing
resolution_type: test_fix
severity: medium
tags: [vitest, alpine, next-tick, refs-mock, unhandled-rejection, async-timing, test-harness, mount-editors]
related_components: [frontend, development_workflow]
framework_version: "vitest 2.1.9 / alpinejs 3.15.11 / node 20"
---

# Vitest exits 1 on an all-green suite: a synchronously mocked $nextTick runs a real async mount whose rejection lands after the test

## Problem

The frontend unit suite reported every test passing yet `vitest run` exited 1, because the edit
page spec's shared harness mocked `$nextTick` as a synchronous call-through without ever setting
`$refs`, so the deferred editor mount that `loadPaperData` schedules dereferenced `undefined` after
three tests had already been recorded as passed.

## Symptoms

The summary looked like a clean run at a glance:

```
Test Files  86 passed (86)
     Tests  1911 passed (1911)
    Errors  3 errors
```

The `Errors` line sits two lines under the `Tests` count everyone reads, and the process exit code
was 1. Reading only the `Tests` line gives no signal: every test is green, no `it()` block carries a
failure marker, and no individual test's output mentions a `TypeError`. The three
`TypeError: Cannot read properties of undefined (reading 'abstractEditor')` errors were unhandled
promise rejections that vitest's reporter logged after the owning tests had already been scored, so
per-test output had nothing to chase. The owners were the tests that drive `loadPaperData` through
its success path with `_mounted = true`: the draft `$watch` registration test, the
rapid-concurrent-invocation test, and the `Promise.allSettled` rejection-reset test. The
`loadPaperData catch:` test in the same region also sets `_mounted = true` but takes the failure
path, never schedules the mount, and never rejected.

Discovery was incidental (session history): the architect noticed the exit code while confirming
test counts for a review of an unrelated commit, and confirmed by rebuilding the tree in an isolated
copy that no in-flight task had introduced it. The three rejections were months old.

## What Didn't Work

- Reading the `Tests` count harder. `1911 passed (1911)` is exactly what a fully green suite prints.
  The `Test Files` and `Tests` lines carry no information about unhandled rejections; only the
  separate `Errors N errors` line and the exit code do.
- A per-describe workaround. One describe block in `frontend/tests/unit/pages-edit.test.js` had
  already set `comp.$refs = {}` inside its own `loadedComponent()` helper, with a comment saying why.
  That protected the tests in that block and left every other block sharing the top-level
  `createComponent()` exposed. A local workaround does not close a shared-harness gap.
- Guarding `this.$refs` in `frontend/src/pages/edit.js`. It would also make the crash go away, and it
  is the wrong fix: it defends a state (`$refs` being `undefined`) that a real Alpine component can
  never be in (see Why This Works), so the guard would only ever protect the harness, permanently
  masking a harness defect behind unreachable defensive code in shipped source.
- Comparing test counts across different baselines (session history). The task file recorded 1911
  tests at filing; the implementer measured 1918 at the fix. That read like a regression signal and
  was a measurement-context artifact: the two figures came from isolated copies built from different
  bases. Before-and-after counts only mean something when both copies are built from the same base,
  which the implementer then did (identical 86 files / 1918 tests, differing only in the `Errors`
  line and the exit code).

## Solution

The fix is entirely in the shared harness. In `frontend/tests/unit/pages-edit.test.js`,
`createComponent()` sets `comp.$refs = {}` right after the `$nextTick` mock, with a comment anchored
on the symbols involved:

```js
comp.$nextTick = vi.fn((fn) => fn && fn());
// A real Alpine component always has $refs. loadPaperData schedules
// _mountEditors through the mocked $nextTick and discards the promise, so
// an unset $refs makes that deferred mount dereference undefined and
// surface as an unhandled rejection after the test has already passed. An
// empty default lets the mount find no editor elements instead. Cases that
// need live or stale refs assign their own after construction.
comp.$refs = {};
```

The per-describe `loadedComponent()` workaround lost its own `comp.$refs = {}` line, since the helper
it calls now supplies it. Nothing under `frontend/src/` changed. Before the fix, the spec ran
81 passed / 3 errors / exit 1; after it, 81 passed / no `Errors` line / exit 0, and the full suite
exits 0 (measured in isolated copies built from the same base). The fix was applied and measured in
a scratchpad copy before the task prescribing it was written (session history), which is the cheap
way to turn "that should fix it" into a number.

## Why This Works

`loadPaperData()` in `frontend/src/pages/edit.js` finishes a successful load by scheduling the mount
without awaiting it:

```js
this.$nextTick(() => {
  this._mountEditors();
});
```

The harness's `$nextTick` mock, `vi.fn((fn) => fn && fn())`, still invokes the real `fn`; it just
does not wait for anything async inside it. `_mountEditors()` is `async`, so the synchronous call
starts it and returns a promise nobody holds. Inside, execution passes the `_mounted` and
`_editorsInitialized` guards, sets `_editorsInitialized = true`, then hits its first `await` on the
dynamic `editor.js` import. Any throw after that first `await` lands in the microtask queue once the
import resolves, detached from the call stack that invoked `$nextTick`. Because the promise was
discarded, nothing observes the rejection until vitest's global unhandled-rejection listener does,
and by then the `it()` block that triggered it has resolved and been scored as a pass. That is the
whole mechanism: a synchronously mocked `$nextTick` still runs a genuinely async callee, and a throw
past that callee's first `await` becomes an unhandled rejection with no owner, landing after the
test ends. The tests that fail this way are precisely the ones that take a success path far enough
to schedule the deferred work.

The throw itself came from `_mountEditors()` reading `this.$refs.abstractEditor` and
`this.$refs.bodyEditor` after the import resolved, with `this.$refs` undefined on the mocked
component. Setting it to `{}` is faithful to the real runtime, not just crash suppression. Alpine's
`$refs` magic (`frontend/node_modules/alpinejs/src/magics/$refs.js`, Alpine 3.15.11) is:

```js
magic('refs', el => {
    if (el._x_refs_proxy) return el._x_refs_proxy
    el._x_refs_proxy = mergeProxies(getArrayOfRefObject(el))
    return el._x_refs_proxy
})
```

`$refs` is always the result of `mergeProxies(...)`, an object, never `undefined`, on any real
component. A ref name with no matching `x-ref` element reads back as `undefined` through that
proxy, which is exactly what `{}.abstractEditor` evaluates to. So `{}` is behaviorally identical to
"no matching ref elements" on the read paths `_mountEditors` exercises, and a production guard on
`this.$refs` would defend a state that never occurs outside an under-specified mock.

The pre-fix exit 1 was an inverted tripwire rather than coverage. Reverting the `$nextTick` mount
scheduling in `loadPaperData()` made the pre-fix tree exit 0: the rejection fired only because the
mount wiring was present and working, not because any test asserted the mount succeeded. No test in
the file asserts that a successful `loadPaperData()` schedules `_mountEditors()` and populates the
editors from `$refs`; a Mutation Probe that reverts the scheduling line survives before and after
this fix. That coverage gap is separate follow-up work, tracked as a pending ui task, and it is why
the fix loses nothing: the signal it removed was never one anybody could have acted on as a failure.

`frontend/src/pages/publish.js` shares the shape (`init()` schedules
`this.$nextTick(() => { this._mountEditors(); })`, and its `_mountEditors()` reads
`this.$refs.abstractEditor` / `this.$refs.bodyEditor` after its own `editor.js` import). Its spec,
`frontend/tests/unit/pages-publish.test.js`, already sets `$refs` in its own `createComponent()`
(`comp.$refs = { abstractEditor: null, bodyEditor: null };`), which is why `publish.js` never showed
this failure. The recurrence surface is measured: six other unit specs mock `$nextTick` as a
synchronous call-through in a `createComponent()`-style helper (`pages-review`, `pages-search`,
`pages-paper-detail`, `pages-stats`, `pages-profile`, `pages-publish`), and only `pages-publish`
sets `$refs`, because only `publish.js` and `edit.js` read `this.$refs` off the instance. The other
five are unexposed today and would fail the same way the day their page grows a `$refs`-reading
deferred method without the harness picking it up.

## Prevention

- Read the exit code and the `Errors` line, not the `Tests` count, when deciding whether a suite is
  green. In an isolated full-suite run (never the shared multi-agent checkout):

  ```bash
  cd frontend && npx vitest run > "$SP/vitest.log" 2>&1; code=$?
  grep -E 'Test Files|Tests  |Errors' "$SP/vitest.log"
  echo "vitest exit: $code"
  ```

  Capture vitest's own exit status before anything else runs; piping through `tee` or reading `$?`
  after a `grep` reports the wrong process. Treat a non-zero exit as a finding even when every test
  passed, and use the `originated in` trace on each unhandled-rejection report to attribute it to
  the test that scheduled the deferred work, since it surfaces after that test has ended.
- Any new spec that mocks `$nextTick` synchronously (`vi.fn((fn) => fn && fn())` or equivalent) and
  drives a component through a success path sets `$refs` in the shared helper (`createComponent()`
  or its equivalent), not inside one describe block's local variant. Check the page for
  `this.$refs` reads when adding a deferred-mount method; the harness has to know about them.
- Before accepting a harness default that merely stops a crash, check it against what the framework
  guarantees by reading the framework's own source. Here the question was concrete: can Alpine's
  `$refs` ever be `undefined` on a real component? The installed `$refs.js` answers no, which is
  what makes `{}` a faithful default instead of a mask. Before touching the harness, the implementer
  also enumerated every `this.$refs` read in `edit.js` (two, both element-guarded) and confirmed
  the teardown-guard tests assign their own `$refs` after construction, so the default could not
  change what any existing test proved (session history).
- Measure a claimed fix before prescribing it: apply the one-line change in a scratchpad copy and
  run the spec and the full suite there, comparing before and after copies built from the same
  base. Counts from different bases are not comparable.
- When an accidental failure signal goes away, ask what it was accidentally covering. A Mutation
  Probe against the scheduling call, run in a throwaway copy, is the concrete way to confirm the
  remaining gap rather than assume the fix closed it.

## Related Issues

- `agents/docs/solutions/conventions/vitest-retry-fire-and-forget-side-effect-poisoning-2026-05-04.md`: closest existing
  entry by mechanism family (an unawaited production async call becomes a latent vitest hazard whose
  fix lives in the test environment). Moderate overlap; different substrate (DB side effects under
  `retry`) and a different failure (double counting, not an exit code).
- `agents/docs/solutions/conventions/promise-race-loser-rejection-handled-2026-05-15.md`: the contrast case. Promises
  passed to `Promise.race` / `all` / `allSettled` / `any` get an internal handler and never surface
  as unhandled; the `$nextTick` callback here calls `_mountEditors()` with no combinator and no
  `.catch`, which is why this rejection is genuinely unhandled.
- `agents/docs/solutions/conventions/synchronous-flag-before-await-idempotency-guard-2026-05-16.md`: same symbols and
  files, different bug (the `_editorsInitialized` guard placement for concurrent re-entry). Its
  mutation-kill example assigns `comp.$refs = { abstractEditor: null, bodyEditor: null }` after
  `createComponent()`; that override stays correct with the new default and is now a restatement
  rather than load-bearing setup.
- `agents/docs/solutions/conventions/alpine-destroy-wipes-pinned-field-before-flipping-mounted-2026-09-02.md`: sibling
  test-fidelity trap in the same page-lifecycle family (a hand-simulated lifecycle flag keeps the
  suite green while skipping the real path).
- `agents/docs/solutions/conventions/completion-note-coverage-claim-run-suite-at-intake-2026-05-26.md` and
  `agents/docs/solutions/conventions/re-review-intake-green-suite-not-held-item-completion-2026-06-09.md`: the "a green
  run is not the evidence it looks like" family this entry extends to the exit-code case.
- `agents/docs/solutions/runtime-errors/constructor-throw-in-settimeout-escapes-as-uncaught-exception-2026-05-01.md`:
  sibling mechanism on the backend (an error originating inside a callback nobody awaits escapes
  the normal catch path, as `uncaughtException` there and `unhandledRejection` here).
- `agents/docs/solutions/test-failures/assertion-vacuity-from-upstream-bail-in-mocked-tests-2026-05-17.md` and
  `agents/docs/solutions/conventions/test-fabricated-error-shape-masks-dead-branch-2026-06-09.md`: the wider "the
  pass count you read is not the ground truth" and "a hand-built fixture omits a field the real
  thing always has" families.
