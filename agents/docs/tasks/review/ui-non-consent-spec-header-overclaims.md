# The mis-cited spec's own header still claims the coverage it lacks

**Owner:** ui
**Created:** 2026-09-06

Routed out of the architect round-5 review of `ui-consent-op-teardown-guard` (archived
2026-09-06). That review corrected five suite headers which cited
`frontend/tests/e2e/non-consent-fresh-auth.spec.js` as exercising broadcast, upload, or
window acquisition against the real backend. The five citers were fixed. The spec they
cited was not, and its own docblock is where the claim originates.

## Why

The spec's opening paragraph states its subject as:

> Non-consent broadcast paths must attach a `fresh_auth_proof` to
> `/api/custody/broadcast`, and the `/orcid/callback` page must handle the `session_auth`
> mode by caching the issued proof in sessionStorage and bouncing the user back to the
> page that initiated the broadcast.

The file contains one test. It registers a single route stub, on `**/api/orcid/callback`,
hand-seeds the ORCID mode and return path that `beginSessionAuthOrcidRedirect` would have
written, and asserts the `session_auth` handler caches the issued window in
sessionStorage. It issues no broadcast: every occurrence of `/api/custody/broadcast` in
the file is inside a comment. The first half of that opening sentence describes a
requirement the spec does not exercise, stated in the same voice as the half it does.

This is the sentence that made the five downstream citations plausible. Anyone reading the
spec's header rather than its body would conclude it drives a proof-carrying broadcast,
which is exactly the inference those five headers encoded and the round-5 review had to
unwind. Leaving it in place leaves the trap armed for the next reader.

Two further claims in the same header need checking, both the same unverified-prose class:

1. **Its own clause-(c) companion sentence** says the `orcid-link` / `orcid-no-password`
   specs cover the `/api/orcid/start` and `/api/orcid/callback` real-path edges for
   sibling modes, and that this spec "layers the session_auth mode atop the same proven
   plumbing." Partially supported, not wholly. `orcid-link.spec.js` does contain a
   genuine real-path test that posts to both endpoints against a live backend, but its
   earlier tests stub `/api/orcid/callback`, and `orcid-no-password.spec.js` stubs
   `/api/orcid/start` with an error in at least one test. The "layers atop the same proven
   plumbing" clause is the weakest part: this spec stubs the callback outright, so its own
   test layers on nothing real.
2. **The real-path companion can silently not run.** `orcid-link.spec.js`'s real-path test
   calls `test.skip(true, ...)` when `/api/orcid/start` returns a non-success status,
   on the theory that ORCID config is missing in that environment. A companion that skips
   itself when its dependency is absent discharges clause (c) only when it actually runs,
   and nothing reports that it did not. Compare `settings-orcid-factor.spec.js`, whose
   equivalent real-path test carries no conditional skip, so a missing sidecar fails
   loudly instead of quietly voiding the companion.

The clause-(a) sentence is sound and should be left alone: the cryptographic verification
it points at is genuinely covered by `backend/tests/routes/custody-non-consent-fresh-auth.test.ts`,
which runs the real `verifyHiveSignature` against signed requests.

## Scope

1. Rewrite the opening paragraph so it states what the single test actually drives, and
   names the broadcast-attach requirement as the thing this spec does **not** exercise.
   The five corrected headers are the model for the wording: say what runs, then say what
   does not, plainly. Keep the paragraph's explanation of *why* the requirement matters if
   it still reads as useful background, but it must not read as a description of this
   spec's coverage.
2. Resolve the clause-(c) companion sentence against what `orcid-link.spec.js` and
   `orcid-no-password.spec.js` actually drive. Credit the real-path test that exists,
   drop or qualify the parts the stubs contradict, and drop the "layers atop the same
   proven plumbing" claim unless you can defend it.
3. Decide the conditional-skip question and record the decision in the header. Either
   remove the skip so a missing ORCID sidecar fails loudly, or state in the citation that
   the companion is environment-gated and does not always run. Removing the skip is
   preferred if the sidecar is a standard part of the e2e environment; check before
   changing it, since a hard failure in an environment that legitimately lacks the config
   is worse than a disclosed gap.
4. Do not re-sweep the six suites that cite this spec. All six already carry the corrected
   form, describing what the spec does not do. Confirm that is still true at the head you
   work from, then leave them alone.

## Acceptance criteria

1. No sentence in `non-consent-fresh-auth.spec.js`'s docblock describes coverage the file
   does not provide, in either half of a compound sentence.
2. The docblock names, in behavioural terms, what its single test drives and what it does
   not.
3. The clause-(c) companion sentence resolves to specs that genuinely exercise what is
   claimed of them, or states the gap.
4. The environment-gated behaviour of the cited real-path test is either removed or
   disclosed in the header.
5. No added line carries a task slug, a path or file redirect to a task, a round or hold
   ordinal, a line-number or SHA anchor, or a bare positional anchor. State the condition,
   not the coordination artifact.
6. The e2e suite is no worse than its recorded baseline. This is a comment-only change
   unless scope item 3 removes the skip, in which case say which specs you ran and what
   they returned.

## Notes

Nothing mechanical will catch a regression here. The carve-out citation canary resolves
citations under `backend/tests/` only, so a frontend spec can describe coverage it does
not have indefinitely with every check green. That gap is recorded separately and is not
this task's job to close.

Scope item 3 may turn out to be a real decision rather than an edit. If removing the skip
would red the suite in a normal developer environment, say so in this file and take the
disclosure option instead; do not remove a guard that is load-bearing for people without
the ORCID sidecar.

## Note (2026-09-14, from the light-account fresh-auth e2e task)

The docblock this task targets was rewritten at 58ad7918 and 306d84f4, when the spec gained
three light-account tests against the real backend. Scope 1 is overtaken: the opening
paragraph now names the four tests and what each drives. Scope 2 is overtaken: the clause-(c)
sentence credits `settings-orcid-factor.spec.js` as the real ORCID round-trip (no conditional
skip), names `orcid-link.spec.js`'s cross-user test as environment-gated by its skip, and the
"layers atop the same proven plumbing" claim is gone. Scope 4's premise is now false: all six
citing suites were re-swept for the new coverage. Scope 3 took the disclosure option inside
the docblock; whether to remove the skip in `orcid-link.spec.js` remains this task's
decision. Re-read acceptance criteria 1 to 5 against the current file before editing.

## UI implementation signal (2026-09-21, commit b6866ddc)

Re-audited the current docblock sentence by sentence against the four tests, the
custody broadcast handler, the four SPA post-building surfaces, the cited unit
suites, and the ORCID specs. Findings were adversarially verified before any edit.

**Acceptance criteria 1 and 2.** Three sentences described coverage the file does
not provide; all three are corrected.

1. "refuses at its first post-gate step, the posting-key decrypt" was wrong on both
   halves. Five steps run between `consumeSessionFreshAuthToken` and `decryptKey`
   (the idempotency block, the pool guard, the account-row read, the missing-row
   401, the upgrade-stamp 403). The seeded row stops at the posting-key
   availability guard immediately before the decrypt, and the envelope
   `expectPostGateStop` pins is that guard's, so the decrypt provably never runs.
   The header now says so.
2. "Where the real-backend broadcast legs stop" read as a claim about all three
   broadcasts. Only the vote reaches the gate; `ALLOWED_OPS` refuses the comment
   and publish bundles inside the per-op validation loop, before
   `findGatedOpsInBundle` and before either consume call. The known-defect
   paragraph already said this, so the topic sentence contradicted its own
   docblock. Now scoped to the vote, with the earlier refusal named.
3. Clause (a) said the ORCID test "covers the return leg's cache write only",
   which contradicted the opening paragraph and understated the test: it also
   polls for the bounce to the seeded return path and asserts the in-flight mode
   and return-path keys are cleared. Clause (a) now names all three.

**Acceptance criterion 3.** The clause-(c) parenthetical listed four citing unit
suites as a closed set. `lib-ipfs-upload-real-window.test.js` carries the same
"Clause-c real-path companion" citation and was missing; added.
`lib-fresh-auth-teardown.test.js` names this spec only to say no companion exists
for its risk class, so its omission is correct and stays.

**Acceptance criterion 4 (scope 3) — the skip is REMOVED.** The decision, and the
evidence behind it:

- The guard was added 2026-04-21 while upgrading a `test.fixme` into a real test.
  Its commit cites no observed failure; it is a hedge.
- The orcid-stub OAuth sidecar landed 2026-06-09, seven weeks later.
  `docker-compose.test.override.yml` sets `ORCID_CLIENT_ID`,
  `ORCID_CLIENT_SECRET` and `ORCID_BASE_URL` unconditionally, and
  `deploy.sh test-up` always layers that override, which the UI role file
  mandates for every executing Playwright run. The one non-200 cause that means
  "not configured" cannot fire in the documented environment.
- The guard fired on ANY non-200. A start-limiter 429, a bearer the backend
  rejects (a drifted `frontend/.env.test` SESSION_SECRET is the likely one), a
  session-check 503 and a Redis-flap 500 were all reported as a missing ORCID
  config and turned green. The current design converted the one plausible flake
  into a silent pass, which is worse than the red it was avoiding.
- It protected nothing that was not already unprotected. Four tests across
  `settings-orcid-factor.spec.js` and `orcid-no-password.spec.js` drive the real
  `/api/orcid/start` through `routeOrcidStubBridge` with no skip, so an
  unconfigured environment already reds the suite four times over.

Replaced with `expect(startResp.status(), await startResp.text()).toBe(200)` so a
failure carries its own status and body. The spec's inline rationale claiming
`/start` on mode=link "requires the victim to be accredited in some backends, and
it requires admin key to be configured" was itself unverified prose and is gone:
`AUTHENTICATED_MODES` contains `link`, the handler runs no accreditation check for
any mode (the `getAccreditedSet` / `hasUnliftedSanction` pair lives in
`handleAccredit`, on the callback side), and `/start` reads no admin key. The
clause-(c) sentence in the non-consent docblock was updated to match: neither
cited ORCID companion is environment-gated any more.

**Acceptance criterion 5.** Clean. Ran `anchor_violation()` from the pre-commit
gate standalone over every added line with `ALLOW_MARKER` set explicitly, proving
the harness non-vacuous first with three control lines (slug + round-ordinal,
bare positional, file:line) that all fired. Zero hits on the added lines.

**Acceptance criterion 6.** Specs run against the test stack (`deploy.sh restart`
-> `test-db-up` -> `test-up`, dev routing restored afterwards):

- `orcid-link.spec.js` — 3 passed. The formerly-skipped test now RUNS and passes
  (409-461ms across two runs), which is the empirical answer to scope 3: the
  assertion works in the documented environment and the guard was masking a
  passing test.
- `non-consent-fresh-auth.spec.js` — 4 passed, including the publish test (HAF
  indexed an accredited researcher, so the upload leg ran and pinned a CID).
- All three specs that hit the real `/api/orcid/start` in one run — 13 passed,
  1 failed. No rate-limit refusal, which was the named residual risk of removing
  the skip.

The one failure is PRE-EXISTING and unrelated: `settings-orcid-factor.spec.js`
"the fresh_auth callback caches the proof under (set_password, username, "") and
the re-submit sends it" fails a `toEqual` because the cached consent-op object now
carries `authorIndex: null` and `claimer: null`. That file is unmodified, imports
none of the files touched here, and fails identically when run standalone. The
extra fields come from the recent fresh-auth work in `authorship-consent.js` /
`settings-fresh-auth.js`; the spec's exact-match assertion was not updated. Not
fixed here, flagged for triage.

## Out-of-scope findings, surfaced not fixed (user triaged: leave alone)

Three defects surfaced during the audit that sit outside this task's scope. The
user reviewed them and chose not to widen scope; recorded here for the architect.

1. `frontend/tests/unit/lib-fresh-auth-outcome-dispatch.test.js` states that this
   spec drives "a window carried on a real broadcast and a real upload pre-flight"
   with no qualification, while its three sibling citers all disclose that the
   upload leg skips when HAF indexes no accredited researcher. Same half-true
   compound-sentence class this task exists to fix, one sentence, in the UI zone.
   Scope item 4 says to leave the citers alone, which is why it was not touched.
2. `backend/tests/routes/custody-non-consent-fresh-auth.test.ts` cites
   `tests/routes/custody-consent-ops.test.ts` by a header line range. That is the
   cross-file line-number anchor class the convention forbids; it has not rotted
   yet. Backend zone and pre-existing.
3. Clause (a) says "the publish test stubs nothing". The spec imports `test` from
   `fixtures/keychain.js`, which `addInitScript`s a fake `window.hive_keychain`
   into every page including that one. It is inert there (`broadcastOps` branches
   to `/api/custody/broadcast` on light custody and never touches the shim), and
   the sentence sits in a semicolon contrast about route interception, so two of
   three refuters read it as defensible. Left as written.

The audit also cleared, on the record so they are not re-litigated: the
known-defect paragraph (all seven claims verified against `ALLOWED_OPS`, the four
comment-building surfaces, the gate ordering, and the two pinning tests), the four
`above`/`below` citations in the file (all the durable carve-out form, a stable
behavioural name in the noun slot), and clause (b).
