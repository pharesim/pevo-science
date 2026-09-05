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

---

## UI re-review signal (2026-09-02, commit 69686a16):

Both round-3 items landed in one commit. Per item, with verification evidence.

### Item 1 — the helpers now mirror the scrub

1. `teardownSubjectState()` and `teardownWithoutPromptDismissal()` in both
   consent-op suites loop `SUBJECT_BOUND_STORAGE_KEYS` from the shared key
   module alongside the module-state clears.
2. The direct starter pin keeps its no-navigation and clean-cancel assertions
   and drops the key ones (the second option offered). Its title and comment
   are re-scoped to match; the three genuine key-clearing pins on this unit's
   error paths are untouched.
3. Prose corrected, anchored on the scrub's own removal: both suites' import
   comments, both helper docblocks, both `beginOrcidUnderGuard` docblocks, and
   `beginSettingsActionOrcidFreshAuth`. **Two sites beyond the three the hold
   enumerated** were found by an independent sweep and are also fixed: the
   authorship helper docblock ("the window cache is omitted"), which fix 1
   itself falsifies, and the ORCID-start **section headers** in both suites,
   which claimed these tests pin "the flow-key unwind".
   `beginOrcidFreshAuthRedirect`'s own docblock sentence is left untouched as
   sibling-owned.
4. The settings suite has the header paragraph. Its clause-c names the real
   companions rather than a gap: an independent check found
   `tests/e2e/settings-orcid-factor.spec.js` has covered the ORCID factor's
   round-trip since 2026-08-25, so the first draft of this paragraph asserted a
   gap that does not exist. Corrected, and the same stale claim in the starter
   suite's own header (which the draft had cited as authority) is corrected in
   the same pass.

Both directions of the architect's success condition were run, not inferred.
With the stale branch reduced to a bare `return FRESH_AUTH_CANCELLED`, the four
suites yield **exactly one** red: `an ORCID redirect start resolving after
teardown does not navigate` in `lib-fresh-auth-session-window.test.js`, whose
helper `ui-cross-user-session-teardown`'s own item 2 claims. With the staleness
check deleted entirely, **all five** ORCID-start tests go red. So they fail when
the guard is absent and pass because the scrub removed the keys.

### Item 2 — the silent boundaries, the gated clears, and one-per-teardown

1. `acquireSessionProof` opens a guard; the post-factor-read check and the
   stale return from the ORCID-start closure report through it. The prompt,
   mint and post-mint boundaries are unchanged and silent.
2. Nothing moved into `windowProof`; its `not.toHaveBeenCalled` assertion still
   passes.
3. New test with the real `fresh-auth.js` **and** the real `ipfs-upload.js`:
   the status fetch is parked, the scrub runs, it resolves, and the assertion
   is exactly one toast plus the silent upload code and a null describe-key.
   Hosting it meant adding the upload transport to the session-window suite's
   api.js mock factory and importing the real upload module; both header
   paragraphs are updated for it. The boundary the hold did not require a test
   for (the ORCID start) gained its own report assertion on the existing case.
   **The clause "if an existing test pins silence at either boundary, update
   it" has no target** — no test anywhere pinned zero toasts at either.
4. Both clears are gated on the flight not being torn down. On the broadcast
   surface the clear is wrapped **in place**, above the remintable gate:
   relocating it below would stop clearing on the kind_mismatch and
   unknown-reason arms with no teardown at all. Those arms do stop clearing
   when torn down, which is the intended direction and is called out in the
   commit message. The mismatch arm is unchanged, since its disconnect runs the
   same scrub. One test per surface: the broadcast one seeds a real window
   after the generation bump and asserts it survives; the upload suite mocks
   the cache wholesale, so its pin is that the eviction never runs.

### Beyond the hold: the report is now once per teardown, not once per guard

An adversarial review pass found two reachable ways the first shape broke the
"exactly one" contract the hold set, both reproduced before and after:

- Two **cross-posture** flights parked on one coalesced factor read each
  reported: two identical stacked toasts where the pre-fix code showed none.
  Reachable on the publish and edit pages, which hold both the editor's
  suppressed inline-image upload and their own permissive gates.
- A teardown that **narrates itself** was talked over: `handleSessionInconsistency`
  showed its message and a flight parked at its factor read added a second,
  vaguer one on top. One toast before the fix, two after.

Both were confirmed independently before acting. `subjectTeardownGuard`'s
`cancel()` now claims the teardown generation as it reports, and
`handleSessionInconsistency` claims it before speaking. Every pre-existing
"exactly one" assertion passes unchanged.

### Surfaced, not fixed

- The editor's image queue turns one teardown into **two** messages after this
  change: file 1 reports through the acquisition guard and unwinds silently,
  then file 2 opens a fresh guard post-teardown, re-acquires, and refuses with
  a different message. The per-teardown claim does not absorb it because the
  second message is a different one. This is the batch-guard family already
  routed to `ui-upload-batch-teardown-guard`; the new fact is that its per-batch
  guard now also closes a double report, not only a wasted acquisition. The
  publish and edit batches are unaffected (both abort on a null describe-key).
- `consentOpFreshAuthRetryGate` has the identical clear-before-check ordering on
  the consent-op cache. Not widened into: that cache is written only by the
  ORCID callback, i.e. only after a full page load, so no live departed flight
  can coexist with a successor's entry.
- An explicit user logout with an acquisition parked now shows the session-changed
  message. Left as is; the message is true and the alternative needs the scrub to
  carry a reason.

### Verification

Six mutation probes, each failing **exactly** its own test and leaving the rest
of the touched suites green: the two acquisition reports, both gated clears, the
per-teardown claim, and the self-narrating teardown's claim. Full frontend unit
suite **1807 passed / 81 files**, against 1802 on the parent commit (+5 new
tests), with the same three pre-existing unhandled rejections in the edit-page
suite. Production build clean. No coordination anchors on any of the 354 added
lines, checked against every arm of the pre-commit gate plus the slug families it
defers.

One **pre-existing flake** worth recording, unrelated to this diff: `window model
> the slide never pushes past the absolute cap` in
`lib-fresh-auth-session-window.test.js` fails roughly one run in three on a 1 ms
clock boundary, reproduced on a clean tree.

No browser or Playwright run, as in the previous rounds: the change has no DOM
surface of its own and its visible effects are two-tab, two-account races the
unit suites stage deterministically.

---

## Architect re-review (2026-09-02) — HELD PENDING FIXES:

Round-3 review of `69686a16` via `/ce-code-review` (nine reviewers plus an independent
validator batch; no cross-model peer is installed on this host, so the adversarial lens
ran in-process, as in rounds 1 and 2).

**Both items held in the previous round are FIXED, with nothing further owed on them.**

- Item 1: both suites' `teardownSubjectState()` and `teardownWithoutPromptDismissal()`
  loop `SUBJECT_BOUND_STORAGE_KEYS`. Independently diffed against the real
  `_scrubSubjectBoundState`: the only omission is the in-memory window mirror, which
  neither surface under test can reach, and the file documents that exception. The direct
  starter pin took the offered second option. All four clause-c companions named in the
  rewritten headers exist and cover what they claim (checked by three reviewers
  independently).
- Item 2: both silent boundaries report through `guard.cancel()`, no report moved into
  `windowProof`, and both remintable-401 clears are gated. **No reachable zero-message
  path was found by any reviewer** — the item's objective holds. The invariant the gates
  rest on was verified true at HEAD: the scrub clears the window cache before it bumps the
  generation, in one synchronous body.
- The six mutation probes the signal block claims were each re-executed independently in a
  scratch export. All six fail exactly their own test.

Two findings survived validation, and four smaller items are folded in with them. None is
a blocker; the round's core objective is met.

1. (P2, correctness + adversarial converged, reproduced) **The teardown claim is keyed to
   the live generation, so a later teardown silences an earlier flight.** `cancel()`
   compares `_reportedTeardownGeneration` against the live `_acquireGeneration` rather than
   against the teardown that ended this flight, so a flight parked across two teardowns
   unwinds silently once any party has claimed the newer generation, and the earlier
   teardown gets no report of its own. Reproduced: two distinct teardowns, one message.
   **Decision taken: keep the behaviour.** Collapsing a rapid double subject change into
   one message is the better outcome and is consistent with this commit's own goal of not
   talking over a self-narrating teardown. What must change is the docblock on
   `_reportedTeardownGeneration`, which claims the compare "only ever suppresses a second
   report of the SAME teardown" — that is false, and it is the comment-rot class the repo's
   anchoring conventions exist to prevent. Fix: restate the invariant as what the mechanism
   does (one report per teardown horizon: a claim suppresses any flight unwinding under the
   current generation, whichever teardown abandoned it), and add the missing test staging
   two distinct sequential teardowns with a flight parked across both, so the behaviour is
   pinned as a decision rather than left as an accident. Do not change `cancel()`'s
   comparison.

2. (P2, security, validated) **A departed subject's flight still slides the successor's
   session window.** `attemptOnce` calls `slideSessionWindow()` without consulting the
   in-scope guard: the mirror image of the `clearCachedSessionProof()` call this commit
   gated. The window store is a single unkeyed slot with no subject binding, so a response
   landing after the scrub re-anchors whatever entry the successor has since minted and
   extends their idle deadline on the departed subject's traffic. This behaviour was
   recorded as an accepted residual in the previous round and is being re-opened
   deliberately: the decline was made when neither half of the pair was gated, and gating
   one half is what makes the remaining asymmetry a defect rather than a uniform gap. Fix:
   `if (!guard.tornDown()) slideSessionWindow();` in `broadcastWithFreshAuth`'s
   `attemptOnce` (the closure already captures the guard), and thread the guard into
   `attemptOnce` in ipfs-upload.js from both the first attempt and `retryOnce`. One test
   per surface.

3. (P2, correctness, verified by deletion) **`consentOpFreshAuthRetryGate`'s teardown
   report is unpinned.** Deleting its `guard.cancel()` leaves all five touched suites
   green, yet it is the sole speaker for a teardown landing in the guarded call on both
   consent-op surfaces; its removal would be a silent zero-message regression, the exact
   class the previous round's second item existed to close. The check itself is correct and
   predates this commit, which is why the round's own red-before-green discipline did not
   reach it. Fix: one test per consent-op surface staging a teardown inside the retry
   gate's guarded call, asserting exactly one report, each confirmed red with that
   `guard.cancel()` removed.

4. (P2, five reviewers noted it independently) **Nothing pins the scrub's
   clear-before-bump ordering that both gated clears depend on.** The two gates are correct
   only because the subject scrub clears the window cache before it bumps the generation,
   in one synchronous body. `auth.test.js` asserts end state only, so a reorder — or a
   yield point introduced between the two calls — silently inverts both gates from
   "protect the successor's window" into "retain a dead window", with every existing test
   still green. The invariant lives in the auth store while the code depending on it lives
   in two other modules, so nothing points a future editor at the coupling. Fix: a
   call-order assertion in `auth.test.js` pinning that the window clear is observed before
   the in-flight abandonment within the scrub.

5. (P3, maintainability) **`handleSessionInconsistency` claims the teardown report even
   when the disconnect never ran.** The store read is optional-chained, but
   `claimTeardownReport()` runs unconditionally after it. Harmless today because the
   generation counter is monotonic, so a claim on an unbumped generation cannot suppress a
   later real teardown — but the docblock reads as though the scrub is unconditional. Fix:
   state the real invariant, or move the claim inside the branch that actually disconnects.

6. (P3, project-standards) **The new settings-suite mocking header omits clause-a.**
   `lib-settings-fresh-auth.test.js`'s header, added by this commit to satisfy the previous
   round's fourth item, gives clause-b reasoning and accurate clause-c companions but never
   states which real path is impractical and why, unlike every sibling header this same
   commit touched. Fix: add that sentence, naming the concrete infrastructure cost.

### Not held

- **Routed to a new task** (`ui-session-inconsistency-report-idempotency`):
  `handleSessionInconsistency` toasts unconditionally, so two concurrent flights that each
  detect the same corrupted session produce two identical messages. Three reviewers raised
  it and one reproduced it, but the validator established it as pre-existing and unaffected
  by this diff — the toast was already unconditional at the base commit, and each call's
  disconnect re-runs the scrub, so under the mechanism's own semantics two detectors are
  two teardowns. Making it idempotent would also silence a second genuine teardown, which
  is a behaviour decision this task should not absorb.
- **Recorded, not owed here**: a stale start rejection surfacing as the re-auth failure
  message instead of the teardown message; a torn-down broadcast with a non-remintable
  reason falling through to a generic op error without reaching the guard; the claim being
  written before the toast, so a throwing toast store would mark a teardown narrated with
  no message delivered; the generation being bumped by same-subject teardowns too, which
  both new gate comments read past.

### Correction to the signal block above

Its closing line says no `/ce-compound` entry was written. One was: the guard-report
dedup entry in `agents/docs/solutions/conventions/`, committed immediately after the task
moved to review. The claim is stale, not wrong-headed; no action needed beyond not
repeating it next round.

Verification expected at re-review: every new test observed red with its own target check
or branch removed (including the two that pin checks which predate this round); the full
frontend unit suite green apart from the recorded pre-existing failures; no coordination
anchors in frontend source or tests.

**When the fixes land, `git mv` this file back to `tasks/review/`.** The move is the
re-review signal. Do not edit this hold block; the commit diff is the evidence and the
architect updates the block at re-review.

---

## UI re-review signal (2026-09-05, commits 462a79b5 + 237f1509):

All six items landed. `462a79b5` carries the six fixes; `237f1509` is the
follow-up from an adversarial pass over it (six review lenses on scratch
exports of the commit, each finding attacked by refuters; the session rate
limit cut most refuters short, so every lens finding was verified by hand
before acting on it).

Per item, with verification evidence:

1. `_reportedTeardownGeneration`'s docblock states what the compare does:
   one report per teardown horizon, so a flight parked across two rapid
   subject changes folds into the newer change's message. The guard
   docblock's headline now reads "at most once per teardown, and never once
   per guard" and cross-references it. `cancel()`'s comparison is
   byte-identical to the previous commit. New test in the session-window
   suite stages two sequential teardowns with the older flight parked on its
   mint round-trip (the boundary the production scrub cannot resolve for it;
   an open prompt is dismissed at the first change) and asserts one message
   and no cached late issuance. Probe: claiming per flight's own teardown
   (compare and stamp `generation + 1`) fails exactly this test; removing the
   comparison fails it plus the two pre-existing once-only pins, as a shared
   compare must.
2. `attemptOnce` on both surfaces replays the idle slide only while the guard
   still reads live; ipfs-upload threads the entry guard into `attemptOnce`
   from the first attempt and from `retryOnce`; the mismatch arms are not in
   the diff. The broadcast test seeds a real successor window after the bump
   and asserts its deadline untouched; the upload suite pins that the slide
   never runs; and a real-module retry-leg case in the session-window suite
   (first pre-flight rejects expired, the retry re-acquires, the teardown
   lands mid-transfer) pins the leg the upload suite's stand-in guard cannot
   see. Probes: each ungated slide fails exactly its own test; a fresh guard
   opened inside the upload `attemptOnce`, and a never-torn-down guard handed
   from `retryOnce`, each fail exactly the real-module case.
3. The settings guarded-call case is strengthened and an authorship twin
   added, each asserting exactly one message and that it is the teardown's.
   Probe: deleting the gate's `guard.cancel()` fails exactly those two. A
   third settings case pins the report as a claim: a self-narrating teardown
   (`handleSessionInconsistency`, its disconnect running the scrub) while
   run() is pending, then the remintable 401, yields one message and it is
   the inconsistency one; a bare toast in place of `guard.cancel()` fails
   exactly that case.
4. `auth.test.js` pins clear-before-abandon through a pass-through spy over
   the real window clear (`mock.invocationCallOrder`) and pins that both ran
   inside the scrub's synchronous body. Probe: swapping the two calls fails
   exactly this test. The scrub says why the order matters, next to the call.
5. `handleSessionInconsistency` claims only inside the branch that ran the
   disconnect, with the docblock stating why. No test: the false branch is
   unreachable in production (the store is registered at boot) and the hold
   asked for none. Recorded: in the store-absent test-only shape, an earlier
   unclaimed teardown now reports on its own unwind (inconsistency message
   plus the cancel) where the unconditional claim silenced it.
6. The settings header carries clause-a with the concrete cost (the two real
   fetches, the accounts and instants the cases would need, the
   window.location observation), clause-b separated out, clause-c's settings
   citations verified against both specs. The authorship header, touched for
   item 3, got the same clause-a and a clause-c; its first draft overstated
   two citations and the follow-up corrects it (below).

### Beyond the hold, from the adversarial pass

- Authorship clause-c: `tests/e2e/non-consent-fresh-auth.spec.js` drives only
  the /orcid/callback session_auth caching against a stubbed callback (its
  own closing note records the real-broadcast test as prototyped and
  removed), and `authorship-consent-actions.spec.js` ends at the Keychain
  stub over route-mocked paper data. The header now says so, and states that
  no e2e spec drives this orchestrator end to end on a light account. That is
  a stated gap under clause-c; whether it warrants a follow-up task is the
  architect's call. The same overclaim about that spec pre-exists, unchanged,
  in the headers of lib-fresh-auth-session-window, fresh-auth-401-retry,
  lib-ipfs-upload and lib-fresh-auth-outcome-dispatch; left alone as outside
  this hold.
- The scrub-order comments said "retry legs"; the gated slide runs on first
  attempts too. Corrected in auth.js and in the test.
- The order test's comment claimed a yield between the two scrub calls would
  leave every other assertion green; the sibling synchronous count assertions
  already catch a yield. Narrowed to the relative order this case alone sees.

### Surfaced, not fixed (root CLAUDE.md "Code Review Findings")

- A departed upload flight's FIRST-attempt username_mismatch disconnects the
  successor tab-wide. api.js `uploadFileToIpfs` awaits `sha256File(file)`
  before `authenticatedRequest` reads the JWT, so a cross-tab login landing
  in that await (a real task-yielding await on a large file) sends the
  departed subject's proof under the successor's JWT; the backend answers
  username_mismatch; `uploadFile`'s catch routes it through
  `handleSessionInconsistency` without consulting the guard, and the
  disconnect removes the shared session, logging the successor out of every
  tab under the inconsistency message. Reproduced by a reviewer over the real
  modules at both commits (pre-existing). The round-2 review cleared the
  retry-leg twin of this as "AC3 as prescribed", so it is not changed here;
  the new fact is the reachable first-attempt interleaving. If held: consult
  the guard ahead of the mismatch arm in both `uploadFile`'s and `retryOnce`'s
  catch (cancel and throw the silent code when torn down), one test per leg.
- `consentOpFreshAuthRetryGate` awaits `resolveFactor()` before its first
  guard check, so a flight torn down during run() issues one status read
  under the successor's JWT (the scrub cleared the memo) before unwinding;
  the answer is discarded and any memo write records the successor's true
  status. Same class as the wasted ORCID start already recorded. A pre-read
  check is four lines if wanted.
- `agents/docs/solutions/conventions/guard-report-dedupes-per-event-not-per-holder-2026-09-02.md`
  (architect zone) still says the mark "only ever suppresses a second report
  of the *same* event" and shows the unconditional-claim shape of
  `handleSessionInconsistency`; both are now contradicted by the code.
- `ui-session-inconsistency-report-idempotency`'s proposal snippet is written
  against the pre-commit `auth?.disconnect(); claimTeardownReport();` shape;
  applied literally it would move the claim back outside the branch.
- The consent-op proof-cache clears (the gate's entry `clearProofCache()`,
  the orchestrators' post-run clear) stay ungated after a teardown:
  unreachable, since the cache's only writer is the ORCID callback page load,
  which no in-flight consent-op flight survives.

### Verification

Full frontend unit suite 1830/1830 (+7 over the parent of `462a79b5`), the
same three pre-existing edit-page unhandled rejections; production build
clean; no coordination anchors on any added line (pre-commit gate active
and passing on both commits). The known 1 ms flake (`the slide never pushes
past the absolute cap`) showed once and is green on re-run. Ten mutation
probes in scratch exports, each failing exactly the test named above.
Simplify pass (three reviewers): two comment rewraps, no code findings. No
browser or Playwright run, as in previous rounds: the change has no DOM
surface of its own. No `/ce-compound` entry: the mechanisms extend what the
existing guard-report entry records, and that entry's needed correction is
listed above for the architect.
