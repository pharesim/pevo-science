## Flip the non-consent spec's known-defect pin now that the allowlist admits `comment_options` (archived 2026-10-01) — one review round; archived clean at 1f8c5cc0

### Architect archive note (2026-10-01)

Reviewed 1f8c5cc0 against its parent with /ce-code-review (correctness, project-standards on
root CLAUDE.md, testing, adversarial in-process, learnings): zero actionable findings, zero
malformed returns, one anchor-50 P3 advisory suppressed. Verified: 1f8c5cc0 is an ancestor of
main and touches only the two files. The signal's claims hold against the code (`workers: 1`,
the `seedLightAccount` ON CONFLICT branch nulling the key columns, the citer sweep, the anchor
gate at zero hits with the control firing). The e2e run was not repeated at review; the code
read agrees with it.

Residual risks recorded, not filed: the header's "400 or 403" omits a pre-gate throw that
surfaces as the error handler's generic 500 (the message pin rejects it); the review page and
the edit-page continuation post have no real-backend binding pin; the publish leg now reaches
the row read under a real researcher's username, and the keyless seeded row is what keeps it
short of signing. The signal's "six clause-(c) unit suites" is loose wording:
`lib-fresh-auth-teardown` cites the spec but says no clause-(c) companion exists.

**Owner:** ui
**Created:** 2026-09-30

Routed out of the architect re-review of `ui-non-consent-spec-header-overclaims`
(archived 2026-09-30) and out of the `[TODO Architect] ui follow-up routing` row on
`backend-custody-allowlist-comment-options`.

## Why

Backend commit `4cb4347b` added `comment_options` to the custody broadcast allowlist
(`ALLOWED_OPS` in `backend/src/routes/custody.ts`), bound to its bundled `comment` op.
`frontend/tests/e2e/non-consent-fresh-auth.spec.js` was written against the defect that
commit fixes. It pins the old refusal as a positive assertion and describes it in its
header and in several inline comments. All of that is now stale:

- The header says the vote is the only broadcast in the file that reaches the gate, and
  that the comment and publish bundles are refused earlier at the op allowlist.
- The header's known-defect paragraph says the allowlist admits `comment`, `vote` and
  `custom_json` only, and that the handler refuses the bundle before the fresh-auth gate.
- The comment test carries a `known-defect` annotation and asserts a 403 `FORBIDDEN`
  whose message names `comment_options`.
- The publish test's comments say the allowlist refuses before the gate, and that the end
  state is "refused before the gate as today".

This was established by reading at the archive review. The e2e suite was not run, so
whether the comment test is red at HEAD is not yet measured.

One trap to check before trusting a green run. Every binding refusal `4cb4347b` added
(author mismatch, bundled-comment mismatch, nonzero `percent_hbd`, non-empty
`extensions`, the pinned `max_accepted_payout` and `allow_votes` / `allow_curation_rewards`
values) also answers 403 `FORBIDDEN` with `comment_options` in the message. The old pin's
three assertions are satisfied by any of those. If the composer's op misses a binding, the
comment test stays green while reporting the old defect. A green comment test before the
flip is therefore a finding about the SPA's op, not evidence that nothing needs doing.

## Scope

1. Run `non-consent-fresh-auth.spec.js` against the test stack first and record what the
   comment test returns at HEAD. If it is green, read the refusal body: it is a binding
   refusal, and the SPA's `comment_options` op disagrees with the backend's bindings. Stop
   and record which binding in this file; that is a backend or composer decision, not a
   pin flip.
2. Replace the comment test's 403 pin with `expectPostGateStop` on the broadcast response
   and drop the `known-defect` annotation.
3. Rewrite the header so it describes the admitted allowlist: which broadcasts in the file
   now pass the gate and where each stops. Delete the known-defect paragraph or reduce it
   to what is still true. Rewrite the inline comments in the comment test and the publish
   test that describe the allowlist refusal.
4. Decide whether the publish test can now pin its broadcast response. It currently
   asserts the request only. Its account is the HAF-indexed accredited researcher, not
   necessarily the seeded keyless row, so check what the handler answers for that account
   before pinning anything, and say in this file what you found.
5. Reword the tail of `expectPostGateStop`'s JSDoc in
   `frontend/tests/e2e/fixtures/light-account.js`. It says the outer catch's generic
   envelope "would mean a step past the guard threw". The account-row read sits inside the
   same `try` ahead of the guard, so a row-read throw produces the same generic envelope.
   Say that the generic envelope would mean something inside the handler's `try` threw:
   the account-row read ahead of the guard, or a step past it.
6. Sweep the citers. `git grep -n -i "known.defect\|allowlist" -- frontend/tests` and read
   every hit that describes this spec or the old refusal. The unit suites that cite this
   spec as a clause-(c) companion describe the vote only and were true at the archive
   review; confirm that at the head you work from rather than assuming it.

## Acceptance criteria

1. No sentence in `non-consent-fresh-auth.spec.js` or its citers says the custody
   allowlist refuses `comment_options`, in either half of a compound sentence.
2. The comment test asserts the post-gate stop, and no `known-defect` annotation remains
   for this defect.
3. The header states, per test, how far the real backend leg runs, and matches what the
   tests assert.
4. The `expectPostGateStop` JSDoc names the row read as a source of the generic envelope.
5. No added line carries a task slug, a task redirect, a round or hold ordinal, a
   line-number or SHA anchor, or a bare positional anchor.
6. The signal block names the specs run against the test stack and what each returned,
   including the pre-flip result from scope item 1.

## Notes

The solutions entry
`agents/docs/solutions/conventions/carve-out-clause-a-impracticability-claims-are-unverified-prose-2026-09-22.md`
is refreshed by the architect separately. Do not edit it here.

## UI implementation signal (2026-10-01, commit 1f8c5cc0)

Landed in `1f8c5cc0` ("ui(e2e): the non-consent spec pins the comment and publish
broadcasts at the post-gate stop"), two files: `frontend/tests/e2e/non-consent-fresh-auth.spec.js`
and `frontend/tests/e2e/fixtures/light-account.js`. Self-verified:
`git merge-base --is-ancestor 1f8c5cc0 main` holds.

**Specs run against the test stack.** Backend rebuilt from current main with
`./deploy.sh restart` (4cb4347b is an ancestor), then `test-db-up` and `test-up`. Each
run was `npx playwright test tests/e2e/non-consent-fresh-auth.spec.js --retries=0`.

- Pre-flip, the spec unmodified (scope item 1): 3 passed, 1 failed, exit 1. The comment
  test was red. The old pin expected 403 and received 500
  `{"code":"INTERNAL_ERROR","message":"Posting key not available"}`. That is the
  post-gate stop, not a binding refusal, so the composer's `comment_options` op satisfies
  every binding 4cb4347b added (its values match `COMMENT_OPTIONS_MAX_ACCEPTED_PAYOUT`,
  `percent_hbd: 0`, empty `extensions`, `allow_votes` and `allow_curation_rewards` true).
  No binding disagreement to record. The ORCID, vote and publish tests passed. The
  publish test ran rather than skipping.
- Post-flip: 4 passed, exit 0. The publish test ran rather than skipping, and its new
  broadcast pin held. After this run the header's tampered-control sentence was reworded
  (see scope items 2 and 3). The change was comment-only and no assertion moved, so the run
  stands.

Stack restored to dev routing with `./deploy.sh up`.

**Scope items 2 and 3.** The comment test ends in `expectPostGateStop` on the broadcast
response, and the `known-defect` annotation is gone. The header's known-defect paragraph
is deleted rather than reduced. Nothing in it is still a defect. The bundle facts it
carried (the composer adds `comment_options` to every new post) now sit in a per-test
paragraph that says how far each test's real backend leg runs. The comment and publish
inline comments that described the allowlist refusal are rewritten. The header's
tampered-control sentence is also reworded. It used to say the control is "what separates
passed the gate from refused before it", which read as true of every broadcast once the
paragraph covered all three. It now says the control shows the route checks the proof,
and that a bundle the handler refuses before the gate answers 400 or 403, so the posting-key
stop's 500 is what places a request past the gate.

**Scope item 4, publish broadcast: pinned with `expectPostGateStop`.** The JWT subject is
the HAF-indexed researcher's username. The handler reads
`accounts WHERE username = <JWT subject>`, and the test seeds that row with
`seedLightAccount`. Its `ON CONFLICT (username)` branch nulls `posting_key_enc`,
`iv_posting`, `upgraded_at` and `sessions_invalidated_at`, so the row is keyless whether
or not one existed before. Playwright runs with `workers: 1`, so no other spec touches
the row mid-test, and `afterAll` deletes it. Measured: the broadcast answers the
post-gate stop (green in the post-flip run). The pin matters beyond coverage. Now that
the allowlist admits the bundle, this broadcast reaches the posting-key guard under a real
researcher's username, and the pin asserts it stops there. The leg stays
environment-gated by the test's existing HAF skip.

**Scope item 5.** The `expectPostGateStop` JSDoc now says the generic envelope means
something inside the handler's `try` threw, either the account-row read ahead of the
guard or a step past it.

**Scope item 6, citer sweep.** `git grep -n -i "known.defect\|allowlist" -- frontend/tests`
returns 14 hits outside the spec. All are about the ORCID redirect-host allowlist
(`fixtures/orcid.js`, `lib-fresh-auth-settings-orcid.test.js`, `pages-login`,
`pages-recover` and `pages-signup` tests) and none describe this spec. The spec's citers
(`git grep -n non-consent-fresh-auth`) are the six clause-(c) unit suites
(`fresh-auth-401-retry`, `lib-fresh-auth-session-window`, `lib-fresh-auth-outcome-dispatch`,
`lib-fresh-auth-teardown`, `lib-ipfs-upload`, `lib-ipfs-upload-real-window`) and
`consent-op-fresh-auth.spec.js`. Each citing header was re-read in full at the head this
work started from. They describe the vote leg and the upload legs only, and every
sentence is still true, so no citer needed an edit.

**Other verification.** The pre-commit hook's `anchor_violation` was run over every added
line with `ALLOW_MARKER` set by hand: zero hits, and the control line fires. A read-only
adversarial pass found no surviving defect in the two edited files. It had four lenses
(backend truth, header against assertions, acceptance criteria, citers), with three
skeptics per finding. The pass also flagged three stale docs outside the ui zone. All of
them are already queued on `backend-custody-allowlist-comment-options`:
`api-contracts/custody.md` (the allowlist constraint and the endpoint intro) and the root
`CLAUDE.md` "(comment, vote only)" sentence.

**Noticed, out of scope.** `frontend/tests/e2e/publish.spec.js` calls the publish
bundle's second op "comment_options (rewards off)". That contradicts the rewards policy
(rewards allowed, `percent_hbd: 0`). Not touched here.

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
