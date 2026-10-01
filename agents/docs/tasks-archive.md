## Correct the Playwright retry-model comments in six e2e specs, and the trace scan's spec list (archived 2026-10-01), two rounds, archived clean

### Architect archive note (2026-10-01)

Re-reviewed `795f6df0` with `/ce-code-review` (correctness, project-standards, in-process
adversarial): no findings. All 5 held items are FIXED (items 1-3 held 2026-09-30, items 4-5
added 2026-10-01). The diff is comment-only: the token streams match and the non-comment
changed-line filter is empty. The anchor gate has no hit on the added lines, and its control
line fires. Each Playwright claim was checked against installed 1.59.1 and by throwaway
probes. The signal's reason for leaving out the item-5 qualifier is accepted.

Triage at archive (user-approved as recommended):
- The false "the test.fixme below" pointer, and the pointers that locate a test by position
  or count in `settings-orcid-factor.spec.js`, are filed as
  `ui-settings-orcid-factor-test-pointers`.
- The missing trace opt-out in `authorship-consent-actions.spec.js` and
  `authorship-pending-discovery.spec.js` is filed as `ui-authorship-specs-trace-opt-out`.
  `unzip` is absent on the dev host, so the trace scan never runs there.
- Dismissed as loose but true: the `login-email` docblock's "the seeded row starts fresh
  each time", and the hook comments' UNIQUE(email) framing (both seeds upsert
  ON CONFLICT (email)).
- Extending the trace scan to the other typed password literals stays out of scope, as
  before.

**Owner:** ui
**Created:** 2026-09-30

Routed out of the architect round-3 review of `ui-light-account-fresh-auth-e2e-coverage`
(archived 2026-09-30). That task corrected one false comment about how Playwright
retries run, in the two fresh-auth specs it owned. The same false model is still written
in six sibling specs, so the e2e directory now states two incompatible retry models. One
adjacent false sentence in the trace scan's docblock rides along. Comment-only work: no
assertion, fixture, or harness behavior changes.

## Why

**The retry model.** Installed Playwright (1.59.1, `frontend/node_modules/playwright`)
stops the worker process whenever a test in it fails, and runs the retry in a newly
started worker. Verified at review in `lib/runner/dispatcher.js`: the job-finished path
stops the worker when the result reports a failure, and the requeued job gets a worker
from `_createWorker`. `frontend/playwright.config.js` sets `workers: 1, retries: 1`. So on
a retry:

- the spec module is loaded again, which means module scope IS evaluated again;
- `beforeAll` runs again in the new worker;
- nothing runs "in the same worker" as the failed attempt.

The seven comment sites below say otherwise, in two shapes.

Shape 1, "retries re-run X but do NOT re-evaluate module scope" (false: module scope is
re-evaluated):

- `login-email.spec.js`, the comment above `TEST_PASSWORD` ("Identity strings derived
  from RUN_SUFFIX are computed in beforeAll ...").
- `password-recovery.spec.js`, the comment above `RUN_SUFFIX` inside the
  "user requests password reset ..." test body.
- `settings.spec.js`, the comment above `NEW_LOCALE` ("Stable constants stay at module
  scope ...").
- `settings-orcid-factor.spec.js`, the comment above `let RUN_SUFFIX` ("Populated in
  beforeAll from (Date.now, testInfo.retry) ...").

Shape 2, "retries in the same worker re-evaluate it" (false: a retry is never in the same
worker):

- `email-signup.spec.js`, the comment above `RUN_SUFFIX` inside the "fresh visitor signs
  up and verifies email" test body.
- `password-recovery.spec.js`, the comment above `OLD_PASSWORD` ("Stable constants stay
  at module scope ...").
- `seed-phrase.spec.js`, the comment above `TEST_PASSWORD` ("Constants that don't depend
  on RUN_SUFFIX stay at module scope ...").

The code under every one of these comments is fine. Each suffix is built from a timestamp
plus `testInfo.retry`, which is what keeps one attempt's seeded rows from colliding with
the previous attempt's. Only the stated reason is wrong.

**The scan's spec list.** `global-teardown.js`'s `scanTracesForSecrets` docblock says the
known password `E2eTestPass1` is "used by seed-phrase, email-signup, login-email,
password-recovery, settings". Only `seed-phrase.spec.js` and `email-signup.spec.js` type
that literal. `login-email` uses `E2eLoginPass1`, `password-recovery` uses `E2eOldPass1`
and `E2eNewPass2`, and `settings` uses `E2eSettingsPass1`.

## Scope

1. Reword the seven comments so each states only what is true of the code beneath it. The
   invariant, not a fixed sentence: a retry runs in a fresh worker process, so module
   scope is evaluated again; the suffix is computed inside a hook or a test body because
   that is where `testInfo` (and so the retry index) is available; the retry index plus
   the fresh timestamp are what keep each attempt's rows distinct. The corrected comments
   above `let RUN_SUFFIX` in `non-consent-fresh-auth.spec.js` and
   `consent-op-fresh-auth.spec.js` are the accepted wording for a `beforeAll` site. Do not
   paste them onto the per-test sites unchanged: a suffix computed inside a test body is
   recomputed on every attempt by construction, and those three comments should say that
   rather than talk about `beforeAll`.
2. Sweep for the claim, not for one phrasing. After the edits,
   `git grep -n -i -E "module scope|same worker|re-?evaluate" -- frontend/tests/e2e`
   must return no line that says a retry skips module scope or shares a worker. Read each
   remaining hit; a true sentence that happens to contain one of those words stays.
3. Correct the `E2eTestPass1` bullet in the `scanTracesForSecrets` docblock so it names
   only specs that type that literal, or names none. A list of spec names is a drift
   vector (it is how this sentence went stale), so dropping the enumeration is acceptable;
   say which you chose and why in the signal block.

## Out of scope

- **Extending the trace scan to the other typed password literals** (`E2eLoginPass1`,
  `E2eOldPass1`, `E2eNewPass2`, `E2eSettingsPass1`, `OrcidFactorPass1`, `NewE2ePass1`).
  Every spec that types one sets `trace: 'off'`, so nothing leaks today and the scan would
  be a backstop only. Whether to add that backstop is an open triage decision, recorded in
  the archive note of the routing task. Do not add scan arms here. Scope item 3 must not
  claim the scan covers a literal it does not.
- Any change to how a suffix is computed, where it is computed, or what it contains.
- The fresh-auth specs the routing task already corrected.

## Acceptance criteria

1. None of the six specs states that a Playwright retry runs in the same worker as the
   failed attempt, or that it does not re-evaluate module scope.
2. Every reworded comment is true of the code directly beneath it, including whether that
   code runs in `beforeAll` or in a test body.
3. The `E2eTestPass1` docblock bullet names no spec that does not type that literal.
4. The diff is comment-only: no executable line under `frontend/tests/e2e` changes.
   `frontend/tests/unit/global-teardown.test.js` still passes unchanged.
5. New comment text follows root `CLAUDE.md` "Comment anchors": no task slug, round or
   hold ordinal, line number, commit SHA, or bare positional reference.

## Notes

The e2e suite does not need to be run for this change; a comment-only diff cannot change
its result. State in the signal block that it was not run.

If while in these files you find a further sentence about retries that is false in a way
neither shape above covers, fix it and list it in the signal block. If you find one you
cannot verify either way against the installed Playwright source, leave it and list it.

UI implementation signal (2026-09-30, commit `3c9f3b10`):

- **Scope 1.** All seven comments reworded in `3c9f3b10` (self-verified: the SHA is an
  ancestor of `main` and its `--name-status` lists exactly the seven e2e files). The three
  `beforeAll` sites (`login-email`, `settings`, `settings-orcid-factor`, all above the
  module-scope declarations) use the accepted fresh-auth wording, extended with "and
  beforeAll runs again". The four test-body sites (`email-signup` and `password-recovery`
  test bodies, plus the module-level comments above `OLD_PASSWORD` in `password-recovery`
  and `TEST_PASSWORD` in `seed-phrase`, which describe a test-body computation) say the
  suffix is computed in the test body, where `testInfo` carries the retry index, so every
  attempt computes it afresh. None of them mentions `beforeAll`.
- **Scope 2.** The sweep grep returns nine lines, all read. Each either says module scope
  re-runs on a retry or says stable constants stay at module scope. None says a retry
  skips module scope or shares a worker. A wider read of every retry sentence under
  `frontend/tests/e2e` (fixtures and global setup and teardown included) found no further
  false sentence in either shape or a new one, so nothing extra was fixed.
- **Scope 3.** Dropped the enumeration. The bullet now reads "Known E2E-minted password
  literal `E2eTestPass1`." and names no spec. Reason: the list is what went stale, and a
  two-name list would go stale the same way the next time a spec picks up or drops the
  literal. The bullet claims no coverage of any other literal.
- **Verification.** Comment-only: filtering the diff's changed lines for anything that is
  not a `//` or ` *` line returns nothing. `frontend/tests/unit/global-teardown.test.js`
  passes unchanged (15 tests, exit 0). The e2e suite was NOT run, per the task's Notes.
  The retry model was re-checked against installed Playwright 1.59.1
  (`runner/dispatcher.js`, `worker/workerMain.js`, `worker/testInfo.js`).
- **One precision note, left as is.** Inside `beforeAll`, `testInfo.retry` is the retry
  index of the first test the new worker runs, not a count of `beforeAll` invocations. In
  a multi-test describe, two `beforeAll` runs can carry the same retry index (for
  example: test 1 fails twice, then a third worker runs test 2 at retry 0), and only the
  timestamp separates them. "The retry index plus the fresh timestamp" stays true as
  written, and the same holds for the accepted wording in the two fresh-auth specs, so I
  did not diverge from it. If the architect wants the comments to say the timestamp alone
  is the guarantee, that is a wording change across all five `beforeAll` sites including
  the two already-accepted ones.

## Architect re-review (2026-09-30) — HELD PENDING FIXES:

**All 5 items held (1-3 on 2026-09-30, 4-5 in the 2026-10-01 addendum) are FIXED in
`795f6df0`. Re-reviewed clean 2026-10-01.**

Reviewed commit 3c9f3b10 against its parent. Confirmed: the diff is
comment-only (the non-comment token streams of all seven files are identical
across the commit); the sweep grep returns the nine lines the signal states
and none of them carries either false shape; `global-teardown.test.js` passes
unchanged at 15 tests; the anchor gate has no hit on the 26 added lines; the
`E2eTestPass1` bullet names no spec and matches a real scan arm. Dropping the
enumeration is accepted. The retry model in the Why section holds against
installed Playwright 1.59.1 and was reproduced in throwaway runs: a failed
test stops its worker, and the retry runs in a new process that loads the spec
file again.

All seven reworded comments place the suffix computation correctly, three in
`beforeAll` and four in a test body. AC 1, 3, 4 and 5 are met. Three items
hold the task.

Items 1 and 2 are sentences 3c9f3b10 did not touch. They are held under the
Notes section ("a further sentence about retries that is false in a way
neither shape above covers, fix it and list it"); the signal's Scope 2 line
reports none. The task's own seven-site list missed them too, so the miss is
not the implementer's alone.

1. **The in-hook `beforeAll` comments credit the retry index with a guarantee
   it does not give.** Two sites, both inside `test.beforeAll`:
   `login-email.spec.js` ("Playwright runs beforeAll again on retries, so
   including `testInfo.retry` guarantees retries see a distinct suffix ...
   against rows left by the failed attempt") and `settings.spec.js` (the same
   sentence with "re-runs beforeAll on retries"). The first half is true. The
   second half is not.

   In a `beforeAll`, `testInfo` belongs to the test whose start triggered the
   hook, which is the first test the worker runs in that describe. The retry
   index is per test. After a failure with a retry left, the runner requeues
   the failed test at its next index together with the tests that have not run
   yet, and the new worker runs that group in file order. Both describes hold
   two tests, so this run is reachable under `workers: 1, retries: 1`:

   - Worker A: the hook reads 0. Test 1 fails.
   - Worker B runs test 1 at retry 1, then test 2 at retry 0. The hook is
     triggered by test 1 and reads 1. Test 1 passes. Test 2 fails, having used
     rows seeded under a suffix that ends `r1`.
   - Worker C runs test 2 at retry 1. The hook reads 1 again.

   Test 2's failed attempt and its own retry both ran under a suffix ending
   `r1`. The timestamp tail was the only part that differed. Two reviewers
   reproduced it with a two-test stand-in describe: three processes, and the
   hook read 0, then 1, then 1.

   The signal's precision note describes the same property and is right that
   the header wording stays true. These two in-hook sentences are the ones it
   does not leave true.

   Fix, comment-only, both sites. The invariant, not a fixed sentence: the
   hook runs again because a retry starts a fresh worker; the index the hook
   reads is the triggering test's, and it can repeat from one worker to the
   next, a test's failed attempt and its own retry included; the retry index
   plus the fresh timestamp are what keep the seeded rows distinct. Do not
   attach "guarantees" to the retry index.

2. **`seedActiveUser`'s comment says a retry can hit UNIQUE(email).** In
   `password-recovery.spec.js`: "Clean any leftover row from a prior partial
   run (test DB is reset between runs by global-setup, but a retry within the
   same run can hit UNIQUE(email))". The file has one test. It builds the email
   and the username in its body from the timestamp tail plus `testInfo.retry`,
   and in a test body that index is the test's own: 0 on the first attempt, 1
   on the retry. The two attempts therefore never share an email or a
   username, and the `DELETE`, which is keyed on this attempt's own pair,
   matches no row a failed attempt left. The sentence also says the opposite
   of the two comments 3c9f3b10 reworded in the same file.

   Fix, comment-only: describe the `DELETE` as defensive cleanup and drop the
   claim about a retry. Leave the `DELETE` itself alone. The "reset between
   runs by global-setup" clause is true (`global-setup.js` runs the backend's
   `test-db:reset` before every run) and can stay.

3. **"beforeAll runs again" above `let RUN_SUFFIX` in
   `settings-orcid-factor.spec.js` is true only for the happy-path describe.**
