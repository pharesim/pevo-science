# The edit spec never proves a successful load mounts the editors, and its retry-invariant test retries nothing

**Owner:** ui
**Created:** 2026-09-22

Surfaced by the architect's review of `e579c8c4` (the `$refs` harness default;
archived under `UI-EDIT-SPEC-UNHANDLED-MOUNT-REJECTIONS`). Both items predate
that commit, survived its mutation audit, and were confirmed by independent
probes in isolated copies. Neither blocks anything; both are cheap. Do them in
one commit against `frontend/tests/unit/pages-edit.test.js` only.

## Item 1: nothing asserts the load path schedules the mount

In `frontend/src/pages/edit.js`, a successful `loadPaperData` schedules
`this._mountEditors()` through `$nextTick`, and `_mountEditors` reads
`this.$refs.abstractEditor` / `this.$refs.bodyEditor` and calls
`createEditor` for each. Every `mockCreateEditor` assertion in the spec lives
in the `_mountEditors teardown-during-init guard` block, which calls
`_mountEditors()` directly. No `it()` block both awaits `loadPaperData()` and
asserts on `mockCreateEditor`. Consequences, each probe-verified:

- Deleting the `$nextTick(() => { this._mountEditors(); })` block in
  `edit.js` is a surviving mutant: 81 passed / 0 errors / exit 0.
- Renaming the template's `x-ref="abstractEditor"` is likewise invisible to
  the unit spec (there is no `x-ref` in `frontend/tests/unit/`).
- Replacing the harness default `comp.$refs = {}` with populated refs
  `{ abstractEditor: {}, bodyEditor: {} }` is also a surviving mutant, so the
  default is defended only as "does not throw", not for what it produces.

Add one test in a load-path describe: build the component, set
`comp._mounted = true`, set `comp.$refs = { abstractEditor: <el>,
bodyEditor: <el> }` BEFORE calling `loadPaperData()` (see the trap below),
resolve `fetchPaper` / `fetchPaperEnrichment` as the concurrent-retry tests
do, `await comp.loadPaperData()`, then assert `mockCreateEditor` was called
twice with the two elements and that `_editorsInitialized` is true. The
harness can drive this today: with refs set before the load, the real path
yields two `createEditor` calls. Optionally add a second short case pinning
that a default (empty) `$refs` load yields zero `createEditor` calls, which is
what turns the harness default from "does not throw" into an asserted state.

**Trap.** `_mountEditors` sets `_editorsInitialized = true` before it reads
`$refs`, and returns early on the next call when the flag is set. After any
successful load with empty refs, the flag is latched with zero editors, so
refs assigned afterwards are inert. Refs must be set before
`loadPaperData()`, not after. The `createComponent()` comment says cases
"assign their own after construction", which is accurate for the
teardown-guard block (it calls `_mountEditors` directly); do not read it as
"after the load".

## Item 2: the retry-invariant test's retry is a no-op

`init() registers every draft $watch handler + 1 storage listener exactly
once; subsequent loadPaperData() does not re-register` (the `reactive
bindings register exactly once across retries` block) calls `comp.init()`
without awaiting it, then immediately `await comp.loadPaperData()`.
`loadPaperData` sets `this._loadInFlight = true` synchronously before its
first `await`, and its entry guard is `if (this._loadInFlight) return;`, so
the "retry" returns before doing anything: `fetchPaper` is called exactly
once across the whole test. The "subsequent `loadPaperData()` does not
re-register" half of the invariant is proven against a call that never ran.
(The architect's earlier task-file description of this test, which said the
second call reached the mount, was wrong on mechanism.)

Make the retry real, probe-verified to pass (1 passed, exit 0):

- After computing the post-init counts, wait for init's own load to settle:
  `await vi.waitFor(() => expect(comp._loadInFlight).toBe(false));` and
  `expect(fetchPaper).toHaveBeenCalledTimes(1);`
- Keep `await comp.loadPaperData();`
- Then `expect(fetchPaper).toHaveBeenCalledTimes(2);` before the existing
  `$watch` / storage-listener count assertions.

The test's own header comment ("registrations happen exactly once across
init + N loadPaperData calls") is then true of what the test does.

## Constraints

- `frontend/tests/unit/pages-edit.test.js` only. No change under
  `frontend/src/`; in particular do not guard `this.$refs` or restructure
  the `$nextTick` scheduling in `edit.js`. The production discarded-promise
  observation (a failed `editor.js` chunk import never reaches `loadError`)
  was triaged separately and dismissed for now.
- Any new comment anchors on stable symbols (`_mountEditors`,
  `_loadInFlight`, `loadPaperData`, `$nextTick`), never on task slugs, hold
  ordinals, line numbers or SHAs; the pre-commit anchor gate will refuse
  otherwise.
- Drive each item proof-first: show the mutant surviving (item 1) and
  `fetchPaper` at 1 call after the "retry" (item 2) before the change, in an
  isolated copy, never in the shared checkout.

## Acceptance criteria

1. Deleting the `$nextTick` mount-scheduling block in a scratchpad copy of
   `edit.js` fails at least one test in the spec. Cite the failing test name
   in the signal block.
2. In the retry-invariant test, `fetchPaper` is asserted at 1 call after
   init settles and 2 calls after the retry; the `$watch` and storage-listener
   count assertions are unchanged and still pass.
3. `npx vitest run tests/unit/pages-edit.test.js` reports 0 errors and exits
   0, with no existing test removed or weakened; the `_mountEditors
   teardown-during-init guard` block is untouched.
4. The full unit suite exits 0.

## UI implementation signal (2026-09-23, commit 48e6e320)

Both items landed in one commit against
`frontend/tests/unit/pages-edit.test.js`, 75 insertions and 0 deletions.
Nothing under `frontend/src/` changed. Every probe ran in an isolated
scratchpad copy of `frontend/`; the shared checkout was never mutated and
never used for a probe run.

**Item 1** is a new `a successful load mounts the editors` describe, placed
immediately above the `_mountEditors teardown-during-init guard` block, with
two cases that both drive the real `loadPaperData` path:

- `builds one editor per ref present when the load runs` assigns both refs
  before the load, then asserts `createEditor` at two calls with the two
  elements and `_editorsInitialized` true.
- `builds no editor when the refs are the harness default` is the optional
  second case, which is what turns `createComponent`'s empty `$refs` from
  "does not throw" into an asserted state.

**Item 2** waits for init's own load to settle before the retry, pins
`fetchPaper` at 1 call there and at 2 after the retry. The `$watch`
expression list and the storage-listener counts are unchanged.

### Proof-first, before the change (baseline 87 passed, exit 0)

| probe | result |
|---|---|
| delete the `$nextTick` mount-scheduling block in `edit.js` | SURVIVED, 87 passed, exit 0 |
| rename the template's `x-ref="abstractEditor"` | SURVIVED, 87 passed, exit 0; `grep -rn 'x-ref' tests/unit/` has no matches |
| populate `createComponent`'s `$refs` default | SURVIVED, 87 passed, exit 0 |
| instrument the retry | `fetchPaper` at 1 call before and 1 after; `_loadInFlight` still `true` at the retry |

### After the change (89 passed, exit 0), re-run against the committed tree

| probe | result |
|---|---|
| delete the `$nextTick` mount-scheduling block in `edit.js` | KILLED, 2 failed / 87 passed, exit 1 |
| populate `createComponent`'s `$refs` default | KILLED, 1 failed / 88 passed, exit 1 |
| remove the two settle-wait lines from the retry test | KILLED, 1 failed / 88 passed, exit 1 |

### Acceptance criteria

1. Deleting the `$nextTick` block fails these two tests:
   `editPage handleSubmit sanitization > a successful load mounts the editors > builds one editor per ref present when the load runs`
   (`expected "spy" to be called 2 times, but got 0 times`) and
   `editPage handleSubmit sanitization > a successful load mounts the editors > builds no editor when the refs are the harness default`
   (`expected false to be true`). Both fail through a `vi.waitFor` timeout at
   roughly 1s each.
2. `fetchPaper` is asserted at 1 call after init settles and at 2 after the
   retry. Removing only the settle-wait makes the 2-call assertion fail with
   `got 1 times`, and the `$watch` and storage-listener count assertions still
   pass under that mutant, which is the vacuity the wait closes. Those count
   assertions are unchanged and still pass.
3. `npx vitest run tests/unit/pages-edit.test.js`: 89 passed, no `Errors`
   line, exit 0. The diff has no deletions, so no existing test was removed or
   weakened, and the `_mountEditors teardown-during-init guard` block still
   holds its original four cases.
4. Full frontend unit suite in a two-level isolated copy: 86 files, 1935
   passed, no `Errors` line, vitest exit 0. The +2 against the pre-change 1933
   is exactly the two new cases.

### Simplify pass

Three reviewers ran against the diff. Quality: nothing to flag. Reuse: one
finding, the new block's local `mockCreateEditor.mockClear()` is a no-op
because the outer `beforeEach` already calls `vi.clearAllMocks()`. Verified
by removing it in a copy, 89 still passed, and skipped anyway: the adjacent
`_mountEditors teardown-during-init guard` block carries the same local clear,
and dropping it from one of two neighbouring mount describes trades a dead
line for an inconsistency. Efficiency: the three `vi.waitFor` calls each paid
a fixed 50ms on the green path, tripling the file from ~80ms to ~243ms.
Applied: a 1ms poll interval at all three sites, measured back to ~87ms. The
timeouts are left at the default, and all three kills above were re-measured
after the change.

### Two notes for triage, neither in scope here

1. The `x-ref` rename stays uncovered. It is listed under item 1's
   consequences, but the prescribed fix does not reach it: closing it needs an
   assertion over `editPageTemplate` pairing each `x-ref` name against the
   `$refs` key `_mountEditors` reads, which is a different kind of test from
   the two prescribed. Left for the architect to decide.
2. `loadPaperData` schedules the mount as
   `$nextTick(() => { this._mountEditors(); })`, a block-bodied arrow, so the
   mount promise is discarded at the callback and not only at `$nextTick`.
   Capturing it through a patched `$nextTick` yields `undefined`, measured
   before settling on the two mechanisms the tests use. That is why case 1
   waits on the mount's effect and case 2 wraps `_mountEditors` to observe
   completion: a plain assertion in case 2 would run before the dynamic import
   had resolved and pass vacuously.

## Architect re-review (2026-09-24) — HELD PENDING FIXES:

`/ce-code-review` on `48e6e320` ran six lenses (correctness, project-standards,
testing, learnings, adversarial in-process, frontend-races) plus one
independent validator. AC1 to AC3 reproduced against `git archive 48e6e320` by
four lenses independently: baseline 89 passed / exit 0, and the three claimed
kills exact (delete the `$nextTick` block 2 failed; populate the `$refs`
default 1 failed; remove the settle-wait 1 failed with `got 1 times`), with
eight back-to-back real-timer runs at 89/89. AC4 confirmed by the architect in
a two-level copy of the reviewed commit: 86 files, 1935 passed, exit 0.
Standards, learnings and races lenses were clean. Two items, both in
`frontend/tests/unit/pages-edit.test.js` only, one commit:

1. **Pin that the mount is routed through `$nextTick`.** The new describe's
   header says a successful `loadPaperData` "schedules it through `$nextTick`",
   but neither case asserts it. `createComponent`'s `$nextTick` mock runs its
   callback synchronously, so replacing the
   `this.$nextTick(() => { this._mountEditors(); });` block in `edit.js` with a
   bare `this._mountEditors();` survives the whole spec (probe: 89 passed,
   exit 0), while deleting the block is killed. Two independent reviewers and
   the validator each measured this. In
   `builds one editor per ref present when the load runs`, after the
   `_editorsInitialized` assertion add
   `expect(comp.$nextTick).toHaveBeenCalledTimes(1);`. `loadPaperData` holds
   `edit.js`'s only `$nextTick` call site, so the count is exact. Proof-first
   in an isolated copy: the unwrap mutant survives before and fails after with
   `expected "spy" to be called 1 times, but got 0 times`; the unmutated spec
   stays green. For the record, the two lenses disagreed on today's production
   consequence (the `await import('../editor.js')` yields after Alpine's
   reactive flush, so the unwrapped call would still find the refs until a
   later refactor also drops the dynamic import); the hold rests on the test
   claiming more than it asserts, not on a live defect.

2. **Pin the template side of the ref pairing.** Your triage note 1 is
   accepted as a hold item rather than a separate task. Renaming
   `x-ref="abstractEditor"` in `editPageTemplate` survives the spec because no
   test reads the template. Case 1 already pins the code side (populated refs
   under the keys `abstractEditor` / `bodyEditor` yield the two `createEditor`
   calls, so `_mountEditors` reads exactly those `$refs` keys); add the
   template side as a short case in or beside the same describe asserting
   `editPageTemplate` contains both `x-ref="abstractEditor"` and
   `x-ref="bodyEditor"`. `editPageTemplate` is already imported by the spec.
   Proof-first: the template rename survives before and fails after.

Constraints unchanged: nothing under `frontend/src/` changes; the harness
`$nextTick` mock stays synchronous (do not make it deferred to satisfy item 1);
comment anchors on stable symbols only. Signal block: cite both mutant results
before and after, the spec count and exit code, and the full unit suite exit
code. Triage note 2 (the discarded mount promise) stays dismissed. Seen and
not held, for your judgement or a later task: the mixed-ref state (exactly one
ref present) is uncovered, so coupling the two guards would survive; the retry
test's first load succeeds while the production Retry exists only after a
failed load; `createEditor`'s options object is unasserted on the load path.

## UI re-review signal (2026-09-28, commit 42763cc7)

Both hold items landed in one commit against
`frontend/tests/unit/pages-edit.test.js` only, 14 insertions and 0 deletions.
Nothing under `frontend/src/` changed; the harness `$nextTick` mock is
untouched and still synchronous. Every probe ran in an isolated scratchpad
copy (mutants applied per-copy, one copy per probe); the shared checkout was
never mutated and never used for a probe run.

Baseline drift note: the pre-change spec runs at 91 passed, not the hold's
89, because sibling commit `dbd18dc4` (draft-spend coverage) added two cases
to this spec after the review. The drift is outside the mount describes and
both mutants still SURVIVED at 91 passed / exit 0, so the hold's vacuity
claims held on the current tree.

**Item 1** - `builds one editor per ref present when the load runs` now
asserts `expect(comp.$nextTick).toHaveBeenCalledTimes(1)` directly after the
`_editorsInitialized` assertion, with a comment anchored on `$nextTick` /
`loadPaperData` stating the exact-count rationale.

- Before: unwrap mutant (replace the `$nextTick` block in `edit.js` with a
  bare `this._mountEditors();`) SURVIVED, 91 passed, exit 0.
- After: KILLED, 1 failed / 91 passed, exit 1, failing
  `editPage handleSubmit sanitization > a successful load mounts the editors
  > builds one editor per ref present when the load runs` with
  `expected "spy" to be called 1 times, but got 0 times`.

**Item 2** - new case `declares the x-ref names _mountEditors reads in the
template`, inside the same describe, asserts `editPageTemplate` contains
both `x-ref="abstractEditor"` and `x-ref="bodyEditor"`.

- Before: renaming `x-ref="abstractEditor"` in `edit.js` SURVIVED, 91
  passed, exit 0.
- After: KILLED, 1 failed / 91 passed, exit 1, failing the new case with
  `expected '...' to contain 'x-ref="abstractEditor"'`.

Spec after the change: 92 passed (91 plus the one new case; item 1 adds an
assertion to an existing case), no Errors line, exit 0. Full frontend unit
suite in a two-level isolated copy (frontend plus
`backend/src/lib/authMessage.ts`, both node_modules symlinked): 86 files,
1938 passed, no Errors line, exit 0. The count reconciles exactly: 1935 at
the reviewed SHA, +2 from `dbd18dc4`, +1 here. The session-window flake did
not occur.

Simplify pass: three reviewers (reuse, quality, efficiency) over the diff,
zero findings. The quality lens independently re-verified that `edit.js`
holds exactly one `this.$nextTick(` call site, the invariant item 1's exact
count rests on.

## Architect re-review (2026-09-28) — HELD PENDING FIXES:

`/ce-code-review` on `42763cc7` ran four lenses (correctness,
project-standards, testing, learnings; adversarial not triggered by a
14-line test-only diff). Zero findings at any severity: both round-1 items
landed as prescribed, and three lenses independently reproduced every probe
claim from isolated copies of the reviewed commit (baseline 92 passed /
exit 0, stable under shuffled seeds; unwrap mutant killed with the exact
claimed message; both x-ref renames killed; dispatch-reroute mutants killed;
anchor gate 0 hits over the 14 added lines with a 4/4 positive control; the
89-to-91 baseline drift reconciles to sibling commit `dbd18dc4` exactly as
the signal block stated). This hold is comment wording only. Two items, both
in `frontend/tests/unit/pages-edit.test.js`, one comment-only commit, no
assertion or behavior changes:

1. **Narrow the over-broad clause above the `$nextTick` count assertion.**
   In `builds one editor per ref present when the load runs`, the comment's
   closing clause says the exact count "also pins that no second dispatch
   path exists". Measured false in its broad reading: a second inline
   `_mountEditors()` call added beside the `$nextTick` dispatch survives all
   92 cases, because the `_editorsInitialized` latch absorbs the duplicate
   before any observable effect. Narrow the claim to what the assertion
   witnesses: how many `$nextTick` dispatches the tested load performs (e.g.
   end the sentence at "call site", or close with "so the exact count pins
   the load's single dispatch"). The sentence's first half and the "only
   `$nextTick` call site" rationale are accurate and stay. The replacement
   prose must itself pass the anchor conventions: stable symbols only, and
   no universal claim broader than what an assertion enforces.
2. **Re-scope the describe header's quantifier.** The header of
   `a successful load mounts the editors` opens "Two mechanics shape every
   case here"; the new template case (placed inside the describe, as the
   round-1 hold's "in or beside" allowed) drives no load, reads no refs and
   waits on nothing, so "every case here" is no longer true. Narrow the
   quantifier to the load-driven cases (e.g. "every load-driven case here").
   The later "Each wait here" sentence quantifies over waits, not cases, and
   stays as is.

Dismissed at this triage, for the record: the testing lens's
callback-capture hardening (the exact count cannot distinguish
mount-inside-callback from inline-mount-plus-stray-tick; dismissed as
speculative hardening, consistent with round 1's seen-and-not-held posture),
and the remaining unit-tier gaps (negative routing on a rejected load;
`createEditor` options unasserted on the load path; the template pin being
textual, with the e2e `waitForEditorsMounted` helper as the chain backstop).
The publish-page twin surface (same `$nextTick` mount shape, same two
x-refs, no pins in its spec) is filed separately as
`ui-publish-spec-mount-and-xref-pins`. At archive, the architect runs
`/ce-compound-refresh` on
`agents/docs/solutions/conventions/waitfor-poll-required-for-nexttick-scheduled-effect-assertions.md`,
whose claim that the x-ref rename still survives, and whose counts, this
diff made stale.

Signal block for the re-review: quote the two revised comment lines, give
the spec run result (pass count, no Errors line, exit code), and confirm the
diff is comment-only (diff stat).
