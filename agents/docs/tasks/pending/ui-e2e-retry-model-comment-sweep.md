# Correct the Playwright retry-model comments in six e2e specs, and the trace scan's spec list

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
