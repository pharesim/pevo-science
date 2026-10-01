## Two authorship e2e specs mint session JWTs with Playwright tracing still on (archived 2026-10-01) — one review round; archived clean at d52ba575

### Architect archive note (2026-10-01)

Reviewed d52ba575 against its parent with /ce-code-review (correctness, security, testing,
project-standards on root CLAUDE.md): zero findings, zero malformed returns. Verified by the
architect: d52ba575 is an ancestor of main and touches only the two specs; AC 2 holds at
d52ba575 for all ten `seedAccreditedSession` specs and for all sixteen specs that mint a
session through any helper (`mintSessionJwt`, `seed*Session`). Neither changed file has a
nested `test.use` that turns tracing back on. Not running the specs is accepted: `test.use`
only changes which artifacts are kept.

Residual risk recorded, not filed: the opt-out stays a per-spec convention with no
mechanical pin, and `scanTracesForSecrets` skips on the dev host while `unzip` is absent.

**Owner:** ui
**Created:** 2026-10-01

Routed out of the architect re-review of `ui-e2e-retry-model-comment-sweep` (archived
2026-10-01), where the implementer listed it for triage.

## Why

`frontend/tests/e2e/authorship-consent-actions.spec.js` and
`frontend/tests/e2e/authorship-pending-discovery.spec.js` both seed a session through
`seedAccreditedSession` in `fixtures/auth.js`. That helper mints a live backend-valid
session JWT with `mintSessionJwt` and writes it to `localStorage` through
`page.addInitScript`. Neither spec sets `test.use({ trace: 'off', ... })`, so the global
`trace: 'retain-on-failure'` in `frontend/playwright.config.js` applies. A failing test in
either spec leaves a `trace.zip` that holds the token under `frontend/test-results/`.

The other eight specs under `frontend/tests/e2e/` that call `seedAccreditedSession` all opt
out, with a one-line reason (for example `review-submit.spec.js`: "This spec mints a live
backend-valid bearer JWT via seedAccreditedSession. Disable trace/video/screenshot to keep
that token out of trace.zip artifacts ...").

`scanTracesForSecrets` in `global-teardown.js` is the backstop, and its JWT arm would catch
the token. But it reads traces with `unzip -p`, and it skips with a warning when that binary
is missing. `unzip` is not installed on the dev host (checked 2026-10-01). On that host the
scan never runs, and the per-spec opt-out is the only defense. The scan's own docblock names
the opt-out as the primary defense.

## Scope

1. In each of the two specs, add `test.use({ trace: 'off', video: 'off', screenshot: 'off' });`
   at module scope, after the imports. Add a short comment that gives the reason in the
   same terms as the sibling specs: the spec mints a live session JWT through
   `seedAccreditedSession`, and the global `retain-on-failure` default would otherwise
   persist it.

## Out of scope

- Any change to `scanTracesForSecrets`, to the global trace default, or to how the scan
  behaves without `unzip`.
- Installing `unzip` on any host.
- Any assertion, fixture, or mock change, and any other spec.

## Acceptance criteria

1. Both specs set trace, video, and screenshot off for every test in the file.
2. Every `frontend/tests/e2e/*.spec.js` that calls `seedAccreditedSession` sets
   `trace: 'off'`.
3. No assertion, fixture, or mock changes.
4. New comment text follows root `CLAUDE.md` "Comment anchors": no task slug, round or hold
   ordinal, line number, commit SHA, or bare positional reference.

## Notes

Running the two specs is optional: `test.use` changes which artifacts are kept, not what the
tests assert. State in the signal block whether they ran.

## UI implementation signal (2026-10-01, commit d52ba575)

Landed in `d52ba575` ("ui(e2e): the two authorship specs opt out of trace, video and
screenshot"), two files: `frontend/tests/e2e/authorship-consent-actions.spec.js` and
`frontend/tests/e2e/authorship-pending-discovery.spec.js`. Self-verified:
`git merge-base --is-ancestor d52ba575 main` holds, and `git show --name-status d52ba575`
lists exactly those two paths.

**Change.** Each spec gets `test.use({ trace: 'off', video: 'off', screenshot: 'off' });` at
module scope, directly after the imports, with a three-line comment worded like
`vote-comment.spec.js` and `review-submit.spec.js`: the file mints live backend-valid
session JWTs via `seedAccreditedSession`, and the global `retain-on-failure` default would
otherwise persist them. No assertion, fixture, or mock changed (AC 3). The comment names no
task slug, ordinal, line number, SHA, or positional target, and the pre-commit anchor gate
passed on the commit (AC 4).

**AC 2 check.** For every `frontend/tests/e2e/*.spec.js` that calls `seedAccreditedSession`
(ten files), a grep for a `test.use({ ... trace: 'off'` call matches. The same check over
specs that call `mintSessionJwt` or `seedUnaccreditedSession` directly (ten files, partly
overlapping) also matches in every file, so no other minting spec lacks the opt-out.

**Specs not run.** `npx playwright test --list` over the two files loads both modules and
lists all six tests (exit 0). The specs themselves were not run against the test stack:
`test.use` only changes which artifacts are kept, and the swap to test mode would take the
shared dev stack away from sibling agents for no assertion change.

## Two fresh-auth docblock counts disagree with the file they sit in (archived 2026-10-01) — four review rounds, three holds; archived clean at 8594733d; out-of-scope reports routed to three new ui tasks

### Architect archive note (2026-10-01, third re-review)

Reviewed 8594733d against its parent with /ce-code-review (correctness, adversarial
in-process, project-standards, learnings): zero findings. Verified by the architect: the
comment-stripped file is byte-identical across the commit; the pre-commit anchor gate has
no hit on the added lines (control line fires); the full unit suite at 8594733d runs 88
files / 2016 tests, exit 0, and the build is clean, both in an isolated copy.

Both items of the second-pass hold are met. Deviations (a) to (d) from the hold's
suggested wording are accepted, each on a reason that holds in the code: the
accreditation-metadata edit and the seven admin routes run `validate` (proof declared
`z.string().min(1).max(512)`) before the consume, while change_email, delete_account,
set_password and the custody broadcast coerce a non-string to `missing` and answer
FRESH_AUTH_REQUIRED; `verifyHiveSignature` runs before `validate` on both families; the
only memo clear in `mintViaPasswordFactor` is the retry leg's UNAUTHORIZED test.

Residual risks recorded, not held: the module header's consent-op burn sentence has two
backend exits before the burn (a stored entry failing shape validation, a lost consume
race or Redis read failure), which "whatever that consume then decides" scopes out; on
the admin routes `requireAdminLevel` answers 403 before `validate` for a lapsed tier,
which leaves the conclusion unchanged.

Implementer's out-of-population reports, checked against the code and triaged (user
approved as recommended):
- Comment items 1 to 7, plus the "every teardown boundary resolves FRESH_AUTH_CANCELLED"
  sentence the second-pass hold left open: filed as
  `ui-fresh-auth-and-upload-comments-that-overclaim`. Dismissed inside it: "A repeat
  detection does not disconnect again" (accurate) and "Taking those would strand it"
  (holds for the authenticated-mode flows it describes).
- (a) same-subject window race: dismissed, worst case one extra password prompt.
- (b) an expired JWT answers the mint with 401 UNAUTHORIZED, read as a wrong password,
  so the user is told re-authentication failed and never to sign in again: decided
  client-side (an `expiresAt` check before `authenticatedRequest` sends, skew accepted)
  over a distinct backend code; filed as
  `ui-expired-session-token-reads-as-wrong-password`.
- (c) an upload's username_mismatch after a cross-tab sign-in signs the new account
  out: filed as `ui-upload-mismatch-teardown-after-subject-change`.
- (d) a failed consent-op cache write loses the ORCID proof: dismissed, reachable only
  on quota exhaustion between start and callback; the misleading comment is item 3 of
  the new comment task.

No /ce-compound: the learnings this task exercised are already in the store.


**Owner:** ui
**Created:** 2026-09-22

Routed out of the round-5 archive of the fresh-auth dispatch task. Neither
site was touched by that task's diff, so neither held it; both are the class
`agents/docs/solutions/conventions/sibling-docblock-tallies-must-each-state-precisely-what-they-count-2026-09-09.md`
documents, and that entry names the second one as its own still-open repair.

## Why

Two count claims in `frontend/src/lib/fresh-auth.js` are false or misleading
read alone, and each has a neighbour in the same file that states the true
count, so a reader landing on either gets a different answer depending on
which paragraph they read first.

1. **"the sibling clears in `broadcastWithFreshAuth`" (plural), twice.** One
   site is the docblock above `clearCachedSessionProof`'s tokenless/TTL
   companions ("the successor-pays-a-re-auth harm that gates the sibling
   clears in `broadcastWithFreshAuth`"); the other is
   `evictUnnamedAcquisition`'s docblock ("Ungated, unlike the sibling clears
   in `broadcastWithFreshAuth`. Those hold a real round-trip..."). That
   function holds exactly one `clearCachedSessionProof()`, the remintable-401
   eviction behind `if (!guard.tornDown())`, and `ensureSessionWindow`'s guard
   docblock in the same file already says so: "the module's one GATED clear,
   the 401 eviction in `broadcastWithFreshAuth`". Three sentences, two counts.

2. **"three independently owned sites consume the result" at
   `WINDOW_OUTCOME_BY_SENTINEL`.** The sentence names `freshAuthWindowReady`,
   `acquisitionAborted` and `windowProof` as consumers of what
   `acquireSessionProof` resolves. Only `acquisitionAborted` reads the raw
   result; the other two read the outcome object `ensureSessionWindow` derives
   from it. `evictUnnamedAcquisition`'s docblock currently reconciles this from
   a distance ("The THREE-site tally at `WINDOW_OUTCOME_BY_SENTINEL` is a
   different and equally correct count: it tallies who acts on an outcome...
   not who reads the raw result"), which the sibling-tallies learning ruled is
   an explanation of the discrepancy rather than its removal.

## Scope

Comment-only. No executable line changes, no test changes, suite count
byte-identical before and after.

1. Replace both "sibling clears" sentences with wording that names the one
   gated clear (the remintable-401 eviction in `broadcastWithFreshAuth`) and
   states, in each sentence's own words, why the clear it is describing does
   not share that gate's reason. Prefer naming the member over restating a
   number, per the learning's "A, B and C do X cannot drift the way three
   sites do X can".
2. Edit the `WINDOW_OUTCOME_BY_SENTINEL` sentence directly so it is correct
   read alone: `acquireSessionProof` resolves to a proof string or a sentinel;
   `acquisitionAborted` reads that raw result; `freshAuthWindowReady` and
   `windowProof` act on the outcome object `ensureSessionWindow` derives from
   it. Then shrink or drop the reconciling clause in `evictUnnamedAcquisition`'s
   docblock, since a precise target sentence leaves nothing to reconcile.
3. Before landing, sweep the file for any OTHER sentence that counts the same
   populations (clears in this module; consumers of the acquisition result or
   the outcome object) and check each one semantically, not by phrase: the
   learning records that a phrase-matched sweep missed the sentence in item 2
   the first time.

## Acceptance criteria

1. Every sentence in `fresh-auth.js` that counts clears, or counts consumers
   of the acquisition result, agrees with the code and with every other such
   sentence in the file, read in isolation.
2. No reconciling clause remains that explains a discrepancy instead of
   removing it.
3. The replacement text carries no line numbers, SHAs, task slugs, round
   ordinals, or bare positional anchors; `.githooks/pre-commit` passes on the
   staged diff.
4. Full frontend unit suite green with an unchanged count; `npm run build`
   clean.

## Notes

Dismissed at the same triage, do not reopen: the spec title `the refusal
evicts the entry that caused it` in `lib-fresh-auth-session-window.test.js`
credits the refusal with an eviction that either clear satisfies; it is
defensible as written because the refusal path does end with the entry gone.

## UI implementation signal (2026-09-28, commit a9150a6f)

All work landed in commit a9150a6f (`ui(fresh-auth): docblock count tallies
name their members`), verified an ancestor of main before this move.

- Scope item 1: both "sibling clears" sentences (at `getCachedConsentOpProof`
  and `evictUnnamedAcquisition`) now name the module's one gated clear, the
  401 eviction in `broadcastWithFreshAuth`, and each states in its own words
  why the clear it describes carries no gate (adjacent synchronous
  statements vs. a real broadcast round-trip inside the gated one).
- Scope item 2: the `WINDOW_OUTCOME_BY_SENTINEL` header now states the split
  directly (`acquisitionAborted` reads the raw result; `freshAuthWindowReady`
  and `windowProof` act on the derived outcome object), and the THREE-site
  reconciling clause in `evictUnnamedAcquisition`'s docblock is dropped.
- Scope item 3 (semantic sweep): ran as a 6-agent adversarial workflow (two
  population sweeps, one reconcile-hunt, three cold-read refuters) plus a
  follow-up refuter on revised text. It surfaced two more in-population
  sentences, both fixed in the same commit: the header's resolution-set
  totality overclaim (unnamed values now named, matching
  `acquireSessionProof`'s own docblock) and `showWindowOutcomeToast`'s
  "every site that consumes an acquisition outcome" universal (callers now
  enumerated: `freshAuthWindowReady`, `acquisitionAborted`, `promptBusy`;
  `windowProof`'s separate upload-error-code channel stated).
- AC 3: `.githooks/pre-commit` anchor gate passed on the staged diff
  (standalone run and at commit time). AC 4: `npx vitest run` green, 86
  files / 1938 tests (count unchanged across pre- and post-edit runs);
  `npm run build` clean.
