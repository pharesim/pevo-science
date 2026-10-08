## An upload's username mismatch after a cross-tab sign-in signs the new account out (archived 2026-10-08): clean review; Remintable Rejection reason dropped, two pre-existing misreports filed, two items already filed, two dismissed

### Architect archive note (2026-10-08)

- **Review:** `/ce-code-review` full path on `ffbfce29` and `083e2577` (branch-remote, base `2401ad5d`): correctness, security, adversarial (in-process, no cross-model peer), julik-frontend-races, testing, project-standards, learnings. Verdict "Ready to merge"; every scope item and AC met, zero findings. Account-state defense review clean: the new branch keys on the client-side subject generation only, every generation bump runs through `_scrubSubjectBoundState`, which clears the session-proof slot first, and no JWT-only path is added. Testing re-measured the signal's six mutants, all killed; m4 killed 4, not the claimed 3 (the extra is the real-window "two uploads" test). The orchestrator checked each planted mutant against the brief, re-ran all six with identical counts, and re-ran the full suite (98 files, 2297 tests, exit 0) and `npm run build` on `083e2577` in an isolated copy.
- **Triage (user: "approved" as recommended):**
  - Fixed in place: `CONCEPTS.md` "Remintable Rejection" drops the corrupt-session because-clause; the mismatch stays terminal (`2a9d3cb8`, signal out-of-scope item 2).
  - Filed: signal out-of-scope items 3 and 4 -> `ui-upload-misreports-a-mid-upload-account-switch` (low). At filing, the self-custody branch was found to rethrow the transfer's 401 raw too, so the task covers both transfer codes there.
  - Already filed: item 1 -> `ui-orcid-callback-caches-a-departed-subjects-proof`; item 5 -> item 2 of `ui-teardown-message-and-mapper-mock-wording`.
  - Dismissed: the broadcast and consent-op mismatch arms read no subject guard (reaching them needs an already-corrupted departed session, the ORCID task closes the main source, and the task ruled out symmetry-only changes). The guard-report learnings entry's "sign in again" sentence (historical, true wherever a teardown fires).
- **Learnings checkpoint:** the learnings reviewer checked `guard-report-dedupes-per-event-not-per-holder-2026-09-02.md`, `await-is-not-a-teardown-boundary-unless-it-yields-to-a-macrotask-2026-09-03.md` (the `083e2577` narrowing is accurate), `subject-divergence-guard-earns-its-place-only-where-the-flow-acts-unpinned-2026-09-03.md`, `fresh-auth-guard-coverage-must-sweep-the-callee-graph-2026-09-01.md` and `shared-verifier-primitive-canonical-status-mapping-2026-05-16.md`; none is contradicted. The only contradicted text was the `CONCEPTS.md` sentence, fixed above. No new entry: the rationale lives in `mismatchError`'s docblock.

**Owner:** ui
**Created:** 2026-10-01
**Priority:** normal

Routed out of the architect archive of the fresh-auth count-tally task (archived
2026-10-01). The implementer's last sweep reported it as behaviour outside that
comment-only task; an architect-side check against the code confirmed it, and the
user approved filing it.

## Why

`uploadFile` (`lib/ipfs-upload.js`) opens a subject teardown guard at entry and checks it
before each retry leg re-acquires, so a cross-tab subject change during an upload unwinds
with `UPLOAD_SUBJECT_CHANGED` instead of acting for the new account. The two mismatch
branches do not check it: on `isUsernameMismatch(err)` both the first-attempt catch and
`retryOnce`'s catch throw `tornDownSession()`, which calls `handleSessionInconsistency()`.
That function disconnects whenever the store is connected, and its own docblock says so:
"This gate does not protect a session established after the flight began; a detector
that finds the store connected always disconnects it."

A reachable sequence: account X starts an upload. `uploadFileToIpfs` (`api.js`) hashes the
file (`sha256File`) before `authenticatedRequest` reads the JWT for the pre-flight. While
the file hashes, the user signs in as Y in another tab. The storage event scrubs this tab
and adopts Y. The pre-flight then sends X's window proof with Y's JWT, and the backend
answers 403 `username_mismatch`. The upload leg tears down Y's session, which removes the
stored session and signs Y out in every tab, with "Session inconsistency detected".

The mismatch is the departed subject's, not a corrupted session belonging to Y. The
retry legs already treat a teardown that landed mid-upload as the departed subject's
business; the mismatch branches should too.

The broadcast and consent-op mismatch arms are also unguarded, but this sequence does not
reach them: signer.js reads the token before its first await, and the consent-op `run`
callbacks call the API directly. Check this before deciding whether they need the same
treatment; do not change them on symmetry alone.

## Scope

1. A `username_mismatch` surfacing on any upload leg after the guard reads torn-down must
   not end the session the tab now holds. It unwinds the way the retry legs' torn-down
   branch does (`guard.cancel()`, then the subject-change code).
2. A mismatch while the guard is NOT torn down keeps today's behaviour (tear the session
   down, `UPLOAD_SESSION_TORN_DOWN`).
3. Update the comments that describe the mismatch branches and
   `handleSessionInconsistency`'s new-session caveat so they match, without line
   numbers, slugs or round ordinals.
4. Pin both halves with unit tests: a mismatch after a teardown leaves the new session
   connected and resolves the subject-change code; a mismatch without a teardown still
   tears down. Use the real guard and the real window where the existing upload suites
   already do.

## Acceptance criteria

1. The sequence in "Why" no longer disconnects the new account; the user sees the
   subject-change outcome, once.
2. A same-subject mismatch still tears the session down exactly as before.
3. Both halves are pinned by tests that fail if the torn-down check is removed.
4. Full frontend unit suite green; `npm run build` clean.

## Notes

`ui-session-inconsistency-report-idempotency` (in review at filing) changes how a second
detector behaves once the store is already disconnected. This task covers a different
case, a store connected as a different subject, and should compose with whichever way
that task lands. Check the state of `handleSessionInconsistency` on main before starting.

## UI implementation signal (2026-10-07, commits ffbfce29, 083e2577)

Both SHAs verified on `main` with `git merge-base --is-ancestor`.

- **ffbfce29** `ui(upload): a mismatch after a subject change no longer signs the new account out`.
  `tornDownSession()` becomes `mismatchError(guard)` in `lib/ipfs-upload.js`, called from both
  upload catch sites (`uploadFile` and `retryOnce`). When the guard reads torn-down it returns
  `subjectChangedError(guard)` (`guard.cancel()`, then `UPLOAD_SUBJECT_CHANGED`), the same helper
  `retryOnce`'s torn-down prologue now uses. Otherwise it keeps `handleSessionInconsistency()` plus
  `UPLOAD_SESSION_TORN_DOWN`.
- **083e2577** `ui(learnings): narrow the macrotask-boundary entry's coverage claim [skip-zone-audit]`.
  This is the learnings checkpoint (see the last line of this block).

**Acceptance criteria**

1. The "Why" sequence no longer disconnects the new account, and the user gets one subject-change
   message. Two tests pin this:
   - `a mismatch after a cross-tab sign-in as another account leaves that account signed in`
     (`lib-ipfs-upload-real-window.test.js`, real guard and real window).
   - `a sign-in as another account inside the PDF pre-flight, answered username_mismatch, leaves
     that account signed in` (`pages-publish-batch-teardown.test.js`). It runs the real auth store,
     its storage-event handler and scrub, and the real publish page, and checks that the store stays
     `mallory`, the stored session survives, and the messages are `[TEARDOWN_MESSAGE]`.
2. A same-subject mismatch still tears down. The existing `a mismatched session tears down instead
   of reporting a generic failure` and both retry-leg mismatch tests are unchanged. The first
   upload in `two uploads detecting the same corrupted session ...` still gets
   `UPLOAD_SESSION_TORN_DOWN`, with one disconnect and the inconsistency message.
3. Both halves are pinned. Mutation probes ran in scratchpad copies against a green baseline, and
   every mutant was killed:
   - Removing the guard check fails 6 tests, including both cross-tab cases and the three new
     per-leg torn-down tests in `lib-ipfs-upload.test.js`.
   - Always taking the subject-change path fails 4 (the same-subject half).
   - Unguarding only the retry leg fails 2. Unguarding only the first attempt fails 3.
   - Dropping the cancel in `subjectChangedError` fails 7.
   - Returning `UPLOAD_SESSION_TORN_DOWN` on the torn-down branch fails 5.
4. Full frontend unit suite: 98 files, 2297 tests, exit 0. `npm run build` is clean (only the
   standing dhive `eval` and chunk-size warnings).

**Notes**

- **Changed expectation.** In the real-window `two uploads ...` test, the second upload now expects
  `UPLOAD_SUBJECT_CHANGED`. The first detector's disconnect bumps the generation, so the second
  guard reads torn-down. Both codes describe to `null`, and the disconnect and message counts are
  unchanged. `handleSessionInconsistency` on main already has the repeat-detection behaviour
  (790eee0e), and this composes with it.
- **Broadcast and consent-op arms: checked, left unchanged.**
  - Broadcast: `broadcastWithFreshAuth` calls `signer.js` `broadcastOps`, which reads `auth.token`
    before its first await.
  - Consent-op: `mintViaPasswordFactor` re-checks the guard after the mint await. Every `run`
    callback (four in `settings.js`, plus `admin.js` and `paper-detail.js`) calls
    `authenticatedRequest` or `broadcastOps`, and both read the token synchronously.
  - So the hash-gap sequence reaches neither arm. Out-of-scope finding 1 is a different sequence
    that reaches all three arms; its fix belongs at the write site, not in the arms.
- **Comments.**
  - Rewritten or narrowed: the `mismatchError` and `retryOnce` docblocks, the `uploadFile` catch
    comment, and the `UPLOAD_SUBJECT_CHANGED` docblock ("a subject teardown" instead of "a
    cross-tab subject change").
  - `handleSessionInconsistency`: the new-session caveat gained one sentence naming the upload
    surface's guard read.
  - `isUsernameMismatch`: narrowed to "no leg treats that as a retryable re-auth failure".
  - Real-window suite header, clause-a: narrowed to "every `api.js` export mocked here performs a
    real fetch()". Its `alpinejs` mock made the old wording false.
- **Verification before commit.**
  - Adversarial workflow: four lenses (correctness, comment truth, sibling arms, test quality), two
    refuters per finding. The correctness lens found no defect. In-scope findings were fixed before
    the commit: a stale "stale under a subject change" test comment, the cross-tab case moved out of
    the "corrupted session" describe, the store-state matcher made able to fail, the real-store page
    case added, and the `mismatchError` re-mint claim deleted.
  - `/ce-simplify` applied the shared `subjectChangedError`, the real `ApiRequestError` in the page
    test, and comment trims. Skipped: two optional new test helpers and a rename.

**Out-of-scope findings, for follow-up filing**

1. **Medium, pre-existing.** `pages/orcid-callback.js` `_verify` writes a departed subject's proof.
   - `await completeOrcid(...)` mints for X, the `/start` user.
   - A cross-tab sign-in as Y during that round-trip scrubs both proof slots.
   - `_handleSessionAuth` / `_handleFreshAuth` then call `cacheSessionProof` /
     `cacheConsentOpProof` with no guard.
   - Y's next broadcast, upload, or consent op on the same target opens a fresh guard, which is not
     torn down. It meets `username_mismatch`, and `handleSessionInconsistency` signs Y out in every
     tab.
   - A verifier probe reproduced this on all three surfaces.
   - Suggested ui task: `_verify` opens a `subjectTeardownGuard()` before `completeOrcid`. For the
     `session_auth` and `fresh_auth` modes it skips the cache write when the guard reads torn-down.
2. **Low, docs, architect-owned.** `CONCEPTS.md` "Remintable Rejection" says a mismatch "means the
   session is corrupt and a fresh proof would be rejected the same way". That rationale is false
   for a mismatch after a subject change: a fresh proof minted under the new JWT would be accepted.
   Terminal still holds, because no retry on that pair can succeed. Suggest narrowing the reason.
3. **Low, pre-existing.** A self-custody upload with a cross-tab sign-in as a light account in the
   hash gap misreports. `uploadFileToIpfs` reads `auth.custody` after hashing and throws
   `FRESH_AUTH_REQUIRED`/`missing` client-side. `uploadFile`'s self-custody branch only consults
   `unwindIfSessionEnded`, so the error surfaces as "upload failed" with no subject-change message.
   The reverse direction (light to self) signs with Keychain as the departed username.
4. **Low, pre-existing.** A subject change between the pre-flight and the transfer, with an
   unaccredited successor: the transfer answers 403 `FORBIDDEN`, which is rethrown raw as "upload
   failed".
5. **Low, pre-existing.** In `tests/unit/pages-publish.test.js`, the `describeUploadError` mock says
   it "Mirrors the real mapper" but maps only `UPLOAD_SESSION_TORN_DOWN` to null. It is harmless
   today because that suite mocks `uploadFile`.

**Learnings checkpoint**

- `/ce-compound-refresh` (Update) ran on
  `await-is-not-a-teardown-boundary-unless-it-yields-to-a-macrotask-2026-09-03.md` and landed in
  083e2577. It deleted "which is exactly the set of points the code already checks". The upload's
  hash await was an unchecked real I/O point.
- `guard-report-dedupes-per-event-not-per-holder-2026-09-02.md` was checked and still holds:
  `mismatchError`'s torn-down cancel follows its "speaks because nothing below will" rule.
- No new entry. The rationale lives in `mismatchError`'s docblock and the ffbfce29 message.

## Light accounts can vouch and retract a vouch on the profile page (archived 2026-10-08): clean review; one P3 filed as a follow-up, stale contract prose fixed, route comment folded, composer task unblocked

### Architect archive note (2026-10-08)

- **Review:** `/ce-code-review` full path on `f3cc369e` and `c064b5ea` (branch-remote, base `e5eec2ff`): correctness, security, adversarial (in-process, no cross-model peer), project-standards, testing, julik-frontend-races, learnings. Verdict "Ready to merge"; every scope item and AC met. Account-state defense review clean: states A, B and C reach the custody route under a session-kind proof, state D and a stale light JWT fail closed, and the voucher is bound server-side. Testing re-ran the signal's seven per-site mutants, all killed (the orchestrator checked each planted mutant against the brief); baseline 24/24.
- **Triage (user: "approved" as recommended):**
  - Filed: a 403-refused vouch notify shows success-pending copy (P3, validator-confirmed, incidence not measured; unaccredited Keychain viewers already reached it), plus the ignored `accreditation_outcome` timeout and chain-error copy -> `ui-vouch-notify-refusal-shows-success-copy` (normal). Narrowed at filing to the vouch handler: the vouch status read lists only accredited vouchers, so `canRetract` is false for a voucher outside the accredited set, and the retract twin is out of scope.
  - Fixed in place: `api-contracts/common.md` "What Still Requires Keychain" now names both signing paths, and `accreditation.md`'s two notify sentences drop "via Hive Keychain" (`443e06dd`).
  - Folded: the `POST /vouch` route comment in `routes/wot.ts` ("via Hive Keychain") -> `backend-wot-comments-cite-deleted-retract-suite`.
  - Unblocked: `ui-composer-surfaces-navigate-over-undrafted-work` moved to `pending/`, as its 2026-10-01 sequencing note prescribed.
  - Dismissed: no spec runs the handlers under light custody and none mounts the profile template (speculative: the handlers read no custody and the template binds the tested getters directly). The lost-notify auto-accreditation gap is covered by `backend-wot-enrollment-has-a-single-trigger`. The global re-auth modal outliving an SPA navigation is shared with votes and comments, user-started and password-gated.
- **Learnings checkpoint:** no `solutions/` entry names `isLightAccount` or `wot.keychainRequiredToVouch` or claims light accounts cannot vouch (learnings reviewer grep), so none is contradicted. No new entry: the one finding is a plain bug, filed as a task.

**Owner:** ui
**Created:** 2026-10-01
**Priority:** normal

## Why

Light accounts are meant to vouch (user decision, 2026-10-01). The profile page hides both
forms from them: `canVouch` and `canRetract` in `frontend/src/components/vouch-section.js` carry
`!this.isLightAccount`, and `frontend/src/pages/profile.js` renders `wot.keychainRequiredToVouch`
in their place. That block only mirrored the custody broadcast's refusal, which
`backend-custody-admits-vouch-and-retract` lifts.

The handlers need no new broadcast path. `handleVouch` and `handleRetract` already go through
`broadcastWithFreshAuth`, which takes a light account through the session window and the custody
route (`ARCHITECTURE.md` § 6.4, the non-consent broadcast row, which now names vouches).

## Scope

1. Drop `!this.isLightAccount` from `canVouch` and `canRetract`. Remove the `isLightAccount`
   getter if nothing else reads it.
2. Remove the light-account message branch in `profile.js` and the `wot.keychainRequiredToVouch`
   key from all 16 locale files under `frontend/public/messages/` (`STUBS.md` has no line for
   it).
3. Flip the two specs in `frontend/tests/unit/components-vouch-section.test.js` that pin the
   light-account refusal: a light account now passes `canVouch` and `canRetract` under the same
   other conditions as a Keychain account.

## Out of scope

- Keeping the relationship choice and the retraction reason across a passwordless account's
  ORCID round-trip. `ui-composer-surfaces-navigate-over-undrafted-work` covers that, after this
  task.
- The retract handler's branches on `revocation_outcome` values the backend no longer returns.

## Acceptance criteria

1. A light account sees the vouch form on an unaccredited profile it has not vouched for, and the
   retract control on one it has, and both handlers broadcast through the custody route.
2. The self, already-vouched and accredited-target conditions still hide the vouch form for a
   light account.
3. No locale file carries `wot.keychainRequiredToVouch`.
4. Each assertion is probed by reverting its own site; list probe and spec in the signal block.
5. New comments follow root `CLAUDE.md` "Comment anchors".

## [BLOCKED by Architect] (2026-10-01) — sequenced behind the backend task

Until `backend-custody-admits-vouch-and-retract` lands, a light account that submits a vouch gets
403 from the custody route and sees "Vouch failed". The architect moves this file to `pending/`
once that task is archived.
