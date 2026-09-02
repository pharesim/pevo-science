# Guard the consent-op orchestrators and retry legs against a subject teardown

**Owner:** ui
**Created:** 2026-09-01

Routed out of the architect review of the cross-user teardown work
(`1b9f2137` + `9ecff448` + `4c3e7c7a`). The teardown machinery landed correctly on
the session-window acquisition path but does not reach three adjacent surfaces that
consume the same primitives. Filed separately because the fix spans files outside
that task's scope.

## Why

`abandonInFlightAcquisitions` and the `_acquireGeneration` checks guard only
`acquireSessionProof` in `lib/fresh-auth.js`. Two consent-op orchestrators,
`withSettingsFreshAuth` (`lib/settings-fresh-auth.js`) and `withAuthorshipFreshAuth`
(`lib/authorship-consent.js`), call the same shared `resolvePasswordFactor` and
`mintViaPasswordFactor` with no generation or subject re-check, and their promise
chains live in a page component's click handler, not in module state the scrub can
reach. Separately, neither `_scrubSubjectBoundState` (`auth.js`) nor
`abandonInFlightAcquisitions` closes the shared reauth modal, so a prompt opened
before a teardown stays open and interactive after it.

The validated failure, confirmed end-to-end including the backend: a user opens a
settings critical-action prompt (delete_account, change_email) or an authorship
consent prompt and steps away; a second user signs in on the same tab (the storage
event runs the scrub); the prompt is still open; the second user types their
password; `mintViaPasswordFactor` mints under the CURRENT JWT (the api layer reads
the token at call time), and the backend binds the proof to that JWT subject at
mint time, so the first user's captured action runs against the second user's
account. The action class here is the most destructive in the app.

The same "teardown does not reach this path" shape recurs on two retry legs, folded
in here rather than filed separately:

- `broadcastWithFreshAuth`'s 401-retry rethrows a raw `username_mismatch` via its
  shape-preserving branch instead of routing it through
  `handleSessionInconsistency()`, so a mismatch surfacing on the retry lands at a
  generic "publishing failed" with no teardown (the first-attempt branch handles it
  correctly; the retry leg does not).
- `uploadFile`'s re-mint and aged-token retries call `attemptOnce` outside the
  `username_mismatch` catch, so a mismatch on a retry attempt escapes raw with no
  teardown.

## Scope

1. Put the guard in the shared layer so every consumer is covered at once. Have the
   subject scrub close the open reauth modal (`Alpine.store('reauthModal')?.cancel()`,
   which resolves the open request and unwinds every `mintViaPasswordFactor` caller
   as a clean cancel), AND capture `_acquireGeneration` inside `mintViaPasswordFactor`
   (same module as the generation counter), returning the clean-cancel outcome after
   each prompt resolution and after the mintFn when the generation moved. That covers
   the settings and authorship orchestrators and any retry re-prompt without
   per-orchestrator edits.
2. Route a retry-leg `username_mismatch` through `handleSessionInconsistency()` on
   both `broadcastWithFreshAuth`'s 401-retry and `uploadFile`'s retry attempts, so a
   mismatch surfacing on a retry tears down like a first-attempt mismatch does.

## Acceptance criteria

1. A password typed into a consent-op prompt (settings or authorship) left open
   across a cross-tab subject change does not spend a mint; the orchestrator unwinds
   as a clean cancel with a distinguishable message, not silently.
2. The scrub closes any open reauth modal, so a session-path prompt left open across
   a teardown is dismissed rather than left interactive (this also closes the
   session-path silent-cancel gap the teardown review surfaced).
3. A `username_mismatch` surfacing on `broadcastWithFreshAuth`'s 401-retry or on
   either `uploadFile` retry leg tears down through `handleSessionInconsistency()`,
   with a test per leg.

## Notes

The backend proof-to-subject binding (§ 6.4.1) is the load-bearing enforcement that
prevents a cross-account WRITE; this task closes the client-side action-on-behalf-of
and the missing-teardown UX so the client never spends a credential or runs an action
for a subject the tab no longer represents. The reachability of the consent-op case
was validated by an independent verification pass, not assumed.

---

## UI implementation notes (2026-09-01)

**Mechanism.** `subjectTeardownGuard()` (fresh-auth.js) is the new shared primitive:
it snapshots the generation the subject scrub bumps and answers "was this stretch of
work abandoned" plus "how does this flow report that". `mintViaPasswordFactor` takes a
`guard` option (defaulting to one opened at its own entry; the session path may rely
on that default only because it re-checks its captured generation immediately before
the call, with nothing awaited in between — its first await is the factor read, not
the prompt). [Corrected at round-1 re-review; the docblock states the same rule.]

**Three deviations from the Scope prescription, all deliberate:**

1. *Scope 1 said the shared-layer guard covers both orchestrators "without
   per-orchestrator edits". It does not, and both orchestrators were edited.* A guard
   captured at `mintViaPasswordFactor`'s entry is blind to a teardown that landed
   during the factor read both orchestrators await BEFORE entering it — it compares the
   post-teardown generation against itself and never fires, so the prompt opens, the
   mint spends under the new subject, and `run(proof)` executes the previous subject's
   captured action. That is the same harm AC1 names, one await earlier. The guard is
   therefore opened at each orchestrator's entry and threaded down through
   `resolveProof`, `mintViaPasswordFactor`, and the retry gate, matching how
   `acquireSessionProof` already threads its own. Verified by an independent adversarial
   pass (3 of 3 refutation attempts confirmed it); tests per orchestrator.

2. *A fourth retry leg was fixed beyond the three AC3 names.*
   `consentOpFreshAuthRetryGate`'s own retry `catch` returned the retryable
   `{ freshAuthFailed: true }` on a `username_mismatch`, contradicting that function's
   docblock. Same defect class as the two named legs, in the same function family;
   fixing three and leaving the fourth would have reopened the sweep at review. One
   test per consent-op surface.

3. *The first-attempt mismatch gate in `broadcastWithFreshAuth` lost its
   `status === 403` condition.* Both legs now share `isUsernameMismatch(err)`
   (code + `details.reason`, no status). Behaviour-preserving — the backend maps that
   reason to 403 only — and required on the retry leg, where the normalizing wrapper
   replaces `details` with a `cause` string, so a status-gated check could never see the
   reason. One predicate is also what stops the two legs drifting.

**One in-class parity alignment inside a touched leg:** `retryOnce` in ipfs-upload.js
branches on a null proof the way the first attempt always has. Shape parity, not a fix:
`freshAuthProof: null` takes the same api.js branch as no option at all. And it is not
reachable in this task's teardown scenario — the reachable retry case is a same-subject
cross-tab custody upgrade to self-custody between the attempts; a logged-out store never
reaches an unproofed upload, because the api layer refuses UNAUTHORIZED before any
upload runs. [Corrected at round-1 re-review; the tests are re-scoped to match.]

**Not fixed, surfaced for triage** (per root CLAUDE.md "Code Review Findings"):

- A teardown cancel raised inside `uploadFile`'s own window acquisition reports twice:
  the teardown message, then the page's `common.uploadCancelled`. Suppressing the
  second needs a distinguishable outcome, i.e. a new member of the window-outcome
  vocabulary plus its `UPLOAD_*` code and `describeUploadError` arm. Both messages are
  true; the cost of the vocabulary widening looked worse than the noise.
- `broadcastConfirm` is the same "singleton prompt outlives the subject" shape as the
  reauth modal and the scrub does not dismiss it either. An adversarial pass refuted the
  cross-account-broadcast harm (the scrub drops the window, so a post-teardown Confirm
  lands on a full re-acquisition rather than a silent broadcast), so this is a UX
  residual, not a security one.

**Verification.** 1778/1778 frontend unit tests pass; production build clean. Every new
test was confirmed to fail against the unfixed code before the fix landed. No browser or
Playwright run: the change has no DOM surface of its own, and its one visible effect is
a toast in a two-tab, two-account race that the unit suite stages deterministically and
a manual session cannot.

---

## Architect re-review (2026-09-01) — HELD PENDING FIXES:

Round-1 review of `0c42bba0` via `/ce-code-review` (nine reviewers; no cross-model peer
available on this host, so the adversarial lens ran in-process). Verdict: ready with
fixes. AC1 to AC3 hold at the boundaries the tests stage; the items below are the gaps
the review surfaced on the surfaces this task touched, in fix order. Two candidate
findings were cleared by validation and are NOT held: the retry-leg mismatch teardown
disconnecting a new subject after a benign cross-tab login (that is AC3 as prescribed),
and the heading shape of the implementation-notes section.

Working-tree note: the cross-user teardown task is editing `auth.js`, `fresh-auth.js`
and three test files in this checkout right now. Item 3 depends on its commit; the rest
touch the same files, so coordinate ordering rather than racing it.

1. (P2, three reviewers converged) **Unguarded retry legs re-acquire for the new
   subject.** `retryOnce` in ipfs-upload.js calls `windowProof()` with no guard, and
   `broadcastWithFreshAuth`'s 401-retry calls `acquireSessionProof` the same way. After
   a cross-tab login between an attempt and its retry, `ensureSessionWindow` reads
   custody at call time and the new flight snapshots the already-bumped generation, so
   the new subject is prompted with the generic re-auth message and mints, and the old
   subject's file (or ops) proceeds under the new username. The backend refuses the
   later broadcast, but this task's own invariant (no credential spent, no captured
   action run, for a subject the tab no longer represents) fails on the surface the
   task touched. Fix, minimal shape: open one `subjectTeardownGuard()` at `uploadFile`
   entry and pass it into `retryOnce`; open one at `broadcastWithFreshAuth` entry after
   its custody gate. Check `guard.tornDown()` before every re-acquisition (both upload
   retry legs' `windowProof()`, the 401-retry's `acquireSessionProof`); on teardown call
   `guard.cancel()` and unwind (upload: throw the silent code from item 2; broadcast:
   return FRESH_AUTH_REDIRECT_PENDING, the same silent abort the mismatch branch uses).
   A batch-level guard passed from the publish/edit submit loops is optional. Tests:
   a teardown between the first attempt and the retry on each of the three legs,
   asserting no prompt, no mint, one toast.

2. (P2, decision taken: give the upload path a distinguishable outcome) **A teardown
   cancel inside `uploadFile`'s own window acquisition toasts twice.** The guard's
   cancel now speaks first, then `UPLOAD_CODE_BY_WINDOW_OUTCOME` maps `cancelled` to
   UPLOAD_CANCELLED and the page shows `common.uploadCancelled`; before this commit the
   same race produced one toast, so this is a regression, not noise. Fix: add a new
   already-reported UPLOAD_* code whose `describeUploadError` arm is silent, like
   UPLOAD_SESSION_TORN_DOWN, and throw it from `windowProof()` when the window
   acquisition's cancelled outcome was teardown-driven. Prefer deciding "teardown-driven"
   by consulting the `uploadFile`-entry guard from item 1 (`guard.tornDown()` after a
   cancelled outcome) over widening the shared window-outcome vocabulary; if you do
   widen the vocabulary instead, audit every consumer of it in the same change (the
   consumer-audit convention in `agents/docs/solutions/conventions/`). Test: a teardown
   during `uploadFile`'s own acquisition -> exactly one toast, the silent code thrown.

3. (P2, three reviewers converged; SEQUENCED after the cross-user teardown task's
   commit) **Consent-op ORCID starters navigate for the departed subject.**
   `beginOrcidFreshAuthRedirect` awaits `startOrcid` and then assigns
   `window.location.href` with no teardown check between; the orchestrators' guard check
   sits one await earlier, at each of the three call sites that reach the starters
   (`resolveProof`'s passwordless branch, its ORCID_FALLBACK branch, and the retry
   gate's `beginOrcidRedirect` hook). A cross-tab login during the round-trip navigates
   the new subject's tab to ORCID for the subject that left; the scrub has already
   removed `pevo_orcid_mode`, so the return dead-ends in the callback's generic error
   arm. Fix: re-check a staleness predicate after `startOrcid` resolves and before the
   host validation; when stale, remove `pevo_orcid_mode`, clear the return path, and
   return FRESH_AUTH_CANCELLED. Forward the predicate through
   `beginSettingsActionOrcidFreshAuth` and `beginAuthorshipOrcidFreshAuth`, pass
   `guard.tornDown` from all three consent-op call sites, and map the cancelled return
   through `guard.cancel()` so the teardown reports once (the retry gate returns
   `{ cancelled: true }` there, not `{ redirect: true }`). The cross-user teardown task
   is adding exactly this predicate parameter to `beginOrcidFreshAuthRedirect` for the
   session-path starter; land this item after that commit and reuse its parameter
   rather than adding a second one. If that work lands in a different shape, adapt to
   it; the condition to satisfy is "no navigation after a teardown that landed during
   the start round-trip", not this prescription's mechanism. Test per orchestrator:
   `startOrcid` pending -> teardown -> resolve -> no navigation, flow keys cleared,
   `{ cancelled: true }`, one toast.

4. (P2) **The second re-prompt's two teardown-guard checks are unexercised.** In
   `mintViaPasswordFactor`, the checks after the second `modal.request()` and inside the
   second attempt's catch have no test; deleting either, or both, leaves all settings
   and authorship tests green (probed in a scratch export of the commit). Fix: two tests
   per orchestrator suite in the existing "subject change while the mint is in flight"
   shape, staged one attempt later: (a) the first mint rejects UNAUTHORIZED on an
   observed factor, the second prompt is parked, teardown without prompt dismissal,
   resolve with a password -> `{ cancelled: true }`, no second mint, one teardown toast;
   (b) same setup but the second mint rejects after the teardown -> `{ cancelled: true }`,
   not `{ freshAuthFailed: true }`. Confirm each test fails with its own check removed;
   the probe is per site, not per fix.

5. (P2) **`retryOnce`'s non-mismatch rethrow has no test.** Replacing its catch body with
   an unconditional teardown leaves the upload suite green, because no retry scenario
   fails with anything other than a mismatch. Fix: one test where the retried attempt
   rejects with a non-mismatch error (a remintable 401 followed by, say,
   INTERNAL_ERROR) and the raw error propagates with `handleSessionInconsistency`
   never called.

6. (P3) **The null-proof retry test pins an unreachable scenario.** With a logged-out
   store, `uploadFileToIpfs` throws UNAUTHORIZED before any upload, so "uploads without a
   proof after the session went away" cannot happen; the reachable null-proof case is a
   same-subject cross-tab custody upgrade to self-custody between attempts. Fix:
   re-scope the test to that case (auth store mocked as self-custody with a username for
   the second attempt) and add the logout case asserting the raw UNAUTHORIZED rejection.
   Also correct the implementation notes above: the branch is shape parity, not a fix
   (`freshAuthProof: null` takes the same api.js branch as no option), and it is not
   "reachable exactly in this task's scenario".

7. (P2) **The guard-default docblock states a false invariant.** It says the default is
   "only correct for a caller whose first await is the prompt". `acquireSessionProof`,
   the only caller relying on the default, awaits the factor read first and is safe only
   because it re-checks the generation immediately before calling
   `mintViaPasswordFactor`; a reader who trusts the comment and removes that "redundant"
   check reopens the cross-subject mint on the session path. Fix: restate the rule (a
   default-guard caller must either have no await before the call or perform an
   immediate pre-call generation re-check; otherwise pass a guard opened before its
   first await) and correct the same claim in this task's implementation notes.

Verification expected at re-review: every new test confirmed red with its target
check or branch removed; the full frontend unit suite green; no coordination anchors
(task slugs, round or item numbers, line numbers, commit SHAs) in frontend source or
tests. Move this file back to `review/` when done.

---

## UI re-review signal (2026-09-02, commits 01347275 + 646c23bb):

All seven hold items landed. Fix commit `01347275` (12 files); follow-up
`646c23bb` corrects a test-suite mock-factory comment the new ORCID-start cases
invalidated (surfaced by the post-implementation simplify review; its other two
reviewers returned nothing to flag).

Per item, with verification evidence:

1. Guards now span the retry legs. `uploadFile` opens one guard and threads it
   through `windowProof` and both `retryOnce` legs; `broadcastWithFreshAuth`
   opens one after its custody gate and checks it before the 401-retry's
   re-acquisition. On teardown: `guard.cancel()` once, then the silent unwind
   (upload: the new already-reported code; broadcast:
   FRESH_AUTH_REDIRECT_PENDING). Tests: one per leg (two upload, one
   broadcast), asserting no re-acquisition, no prompt, no mint, one toast.
   Observed red before the fix commit (test-first), green after.
2. The teardown cancel inside the upload's own acquisition now throws
   UPLOAD_SUBJECT_CHANGED, whose `describeUploadError` arm is null, decided by
   consulting the entry guard after a cancelled outcome (no vocabulary
   widening). Consumer audit done anyway at the UPLOAD_* level: all four page
   gates (editor, publish PDF, publish supplementary, edit supplementary) now
   key on the null describe-key instead of per-code equality, so the new code
   is silent everywhere and a future already-reported code needs no page
   edits. Tests: teardown during the acquisition throws the silent code with
   no second report; the null-key mapping is pinned. Red before, green after.
3. Both consent-op starters take the staleness predicate and forward it to the
   shared pre-navigation re-check (reusing the parameter the cross-user
   teardown task added); each orchestrator routes all three starter paths
   (passwordless, assumed-fallback, retry-gate hook) through one wrapper that
   maps a stale start through `guard.cancel()`, and the retry gate maps the
   cancelled sentinel to `{ cancelled: true }`, not `{ redirect: true }`.
   Tests: per orchestrator, the real starter is driven with `startOrcid`
   parked, teardown mid-round-trip, then resolved: no navigation, flow keys
   cleared, `{ cancelled: true }`, one toast (settings covers the passwordless
   and retry-gate paths; authorship the passwordless and assumed-fallback
   paths; the starter's stale unwind and a non-stale control are pinned
   directly in its own suite). All red before, green after.
4. Two tests per orchestrator suite in the prescribed staging: the parked
   second prompt resolving after a teardown spends no second mint; a
   second-mint rejection after a teardown returns `{ cancelled: true }`, not
   `{ freshAuthFailed: true }`. Probes per site on the committed baseline:
   deleting the check after the second `modal.request()` fails exactly the two
   second-prompt tests (both suites); deleting the check in the second
   attempt's catch fails exactly the two second-mint tests. Both restored
   clean.
5. New test: a remintable 401 followed by INTERNAL_ERROR on the retry
   propagates raw with `handleSessionInconsistency` never called. Probe:
   replacing `retryOnce`'s catch body with an unconditional teardown fails
   exactly this test.
6. The null-proof retry test is re-scoped to the same-subject custody-upgrade
   case, and a logged-out-store test pins the raw UNAUTHORIZED refusal (one
   unproofed call; the api layer refuses before any upload, and that first
   unproofed attempt sits outside the retry machinery, so no safety-net
   retry). Probe: deleting the null-proof branch fails exactly the
   custody-upgrade test. The implementation notes above are corrected
   accordingly, as is the in-code comment.
7. The guard-default docblock now states the real rule (no await before the
   call, or an immediate pre-call generation re-check with nothing awaited in
   between; otherwise pass a guard opened before the first await) and names
   the session acquisition's pre-call check as load-bearing. The mechanism
   note above is corrected to match.

Suite: 1800/1800 frontend unit tests green at `646c23bb`; production build
clean. The three vitest "unhandled rejection" errors in the edit-page suite
reproduce identically on the pre-change baseline (verified by stashing the
edit-page change and re-running). No coordination anchors in frontend source
or tests (pre-commit anchor gate active and passing; quality reviewer
double-checked the full diff). No browser or Playwright run, as in round 1:
the change has no DOM surface of its own, and its visible effects are
two-tab, two-account races the unit suites stage deterministically. No
`/ce-compound` entry: the mechanisms extend patterns the existing learnings
already record.

---

## Architect re-review (2026-09-02) — HELD PENDING FIXES:

Round-2 review of `01347275` + `646c23bb` via `/ce-code-review` (nine reviewers plus
an independent validator batch; no cross-model peer is installed on this host, so the
adversarial lens ran in-process).

**All seven items held on 2026-09-01 are implemented as prescribed.** Every per-site
deletion probe the signal block claims was re-executed independently and held at each
site: the three retry-leg guards, the `windowProof` cancelled-plus-teardown branch, the
starter's staleness re-check, both `mintViaPasswordFactor` second-attempt checks, and
`retryOnce`'s non-mismatch rethrow each fail exactly the named tests and leave the rest
of the five touched suites green. Items 1, 4, 5, 6 and 7 are **FIXED** with nothing
further owed. Items 2 and 3 are fixed in the production code, but each leaves one defect
on the surface it touched: those are the two items below.

Suite re-run in a scratch export of the reviewed head: 1796 passed. The single
collection failure (`sec-001-equivalence.test.js`, three unhandled rejections)
reproduces identically at the parent commit, so it is not this task's. The anchor scan
over every added line is clean, and the pre-commit gate's own self-test passes.

Both items were confirmed by an independent validator after two or three reviewers
converged on them separately.

### Item 1 — the consent-op teardown helpers pin the stale branch's key removals, not the scrub

`teardownSubjectState()` and `teardownWithoutPromptDismissal()` in both consent-op
suites compose the real primitives the subject scrub delegates to, but omit the
`SUBJECT_BOUND_STORAGE_KEYS` removal loop that `_scrubSubjectBoundState` also performs.
So the five new ORCID-start tests (two per orchestrator suite plus the direct pin in the
starter suite) assert the mode and return-path keys are null after a teardown, while
nothing in the staged teardown removes them. They pass only through the redundant
removals inside `beginOrcidFreshAuthRedirect`'s stale branch, which is exactly the write
the cross-user teardown task's 2026-09-02 hold prescribes deleting (that branch can only
ever wipe a successor flow's keys, never its own flight's). That hold names these
helpers as belonging to this task.

Verified, not inferred: reducing the stale branch to a bare `return FRESH_AUTH_CANCELLED`
turns all five red on the mode-key assertion while production behaviour stays correct;
adding the removal loop to both helpers turns the four orchestrator tests green again for
the right reason.

Fix:

1. Loop `SUBJECT_BOUND_STORAGE_KEYS` (from the shared key module) in both helpers, in
   both suites, so they mirror the scrub rather than a subset of it.
2. Re-scope the direct starter pin in the starter suite. It has no scrub to lean on, so
   its key assertions cannot survive the sibling fix: either seed the scrubbed state
   before resolving the parked start, or keep only its no-navigation and clean-cancel
   assertions. Do not leave it asserting a removal the starter will no longer perform.
3. Correct the three claims that the sibling fix makes false, anchored on the scrub's own
   removal rather than the starter's: the settings helper docblock's "touches neither"
   sentence, the import comment stating the stale unwind must clear those keys, and the
   `(flow keys cleared)` clauses in both `beginOrcidUnderGuard` docblocks and on
   `beginSettingsActionOrcidFreshAuth`.
4. While that settings suite is open, give it the explicit mocking-justification header
   paragraph its authorship sibling already carries. The inline per-mock comments hold the
   substance; the project's test carve-out asks for it in the file header.

Sequencing: land this with, or after, the cross-user teardown task's round-2 fix. If that
work lands in a different shape, adapt; the condition to satisfy is that these tests fail
when the guard is absent and pass because the scrub removed the keys, never because the
starter re-removed them.

### Item 2 — a teardown inside the upload's own factor read now reports nothing at all

`windowProof`'s new branch assumes the acquisition has already reported by the time it
sees a cancelled outcome. At one boundary it has not: `acquireSessionProof`'s generation
check immediately after the factor read returns the clean-cancel sentinel with no report,
and the shared dispatch maps that outcome to a deliberately null toast row. A cross-tab
subject change landing in that status fetch therefore produces zero messages: the new
silent code is thrown, all four page gates honour its null describe-key, and the page
drops to idle having said nothing. Before this commit the same race produced one
(mis-worded) upload-cancelled toast, so this is a regression on a surface this task
touched, and item 2's "exactly one toast" does not hold there. The status fetch is a real
round-trip and negative or assumed factor answers are not memoized, so the window is
reachable on any cold acquisition, not only the first of a session.

Reproduced with the real modules by two reviewers and the validator: zero toasts at the
factor-read boundary, exactly one at the prompt boundary as the control.

Decision taken: keep "exactly one" as the contract; do not weaken it to "at most one".

Fix:

1. Make the two genuinely silent teardown boundaries inside the acquisition report once
   through the guard's own cancel: the post-factor-read generation check, and the stale
   return from the passwordless policy closure's ORCID start. Leave the prompt, the mint,
   and the post-mint boundaries exactly as they are. `mintViaPasswordFactor`'s own guard
   already reports there, and adding a second report at those sites is the double toast
   the round-1 review rejected. This also makes the window-outcome table's
   "already reported at the abort site" comment true, and closes the same silence on the
   broadcast surface's own acquisition.
2. Do NOT move the report into `windowProof`. The upload layer cannot know whether the
   acquisition spoke; the existing assertion that the guard's cancel does not fire at that
   site stays correct and must keep passing.
3. Test with the real modules, not the wholesale mock: park the status fetch, run the
   scrub, resolve, and assert exactly one toast together with the silent upload code. If
   an existing test pins silence at either boundary, it is pinning this defect. Update it
   and say so in the commit message.
4. Same visit, both remintable-401 branches: the cached-window clear runs before the new
   teardown check, so a departed subject's late 401 can evict a window the successor
   subject has already minted in this tab, costing them an extra re-auth. Make the clear
   conditional on the flight not being torn down, on the upload surface and the broadcast
   surface alike, leaving the mismatch teardown path's behaviour unchanged. One test per
   surface: seed a window after the generation bump inside the rejected first attempt and
   assert it survives.

### Not held

- **Routed to a new task** (`ui-upload-batch-teardown-guard`): each `uploadFile` call
  opens its own guard, so a teardown landing between two files of one submit, or between
  the last upload and the broadcast, opens the next leg's guard after the fact. Four
  reviewers converged on it independently. The round-1 hold marked a batch-level guard
  optional and it sits outside this diff's lines, so it is filed rather than held.
- **Dismissed**: the duplicated `beginOrcidUnderGuard` wrapper across the two
  orchestrators. Three lines per surface, the outcome mapping that could actually drift is
  already centralized in the shared retry gate, and hoisting it would add a hop to an
  already deep delegation chain.
- **Dismissed**: the page suites' hand-rolled upload-error mocks never producing the new
  code. The null-key contract is pinned at the unit level and every gate keys on the null
  key rather than on a code, so this is preemptive hardening of a failure mode nothing
  reaches.
- **Recorded, unchanged from round 1 and not owed here**: one wasted start request for the
  departed subject before the pre-navigation re-check; a start rejection after a teardown
  throwing out of the wrapper rather than cancelling; a late upload response sliding a
  successor's idle deadline; a stale flight's teardown toast landing while the successor's
  own prompt is open. `fresh-auth.js` line growth is noted, with no decomposition demanded
  now.

Verification expected at re-review: each new test observed red with its own target check
or branch removed; the full frontend unit suite green apart from the pre-existing
collection failure named above; no coordination anchors in frontend source or tests.

**When the fixes land, `git mv` this file back to `tasks/review/`.** The move is the
re-review signal. Do not edit this hold block; the commit diff is the evidence and the
architect updates the block at re-review.
