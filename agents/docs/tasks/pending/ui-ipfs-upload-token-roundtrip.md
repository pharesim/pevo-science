# UI-IPFS-UPLOAD-TOKEN-ROUNDTRIP — SPA upload flow must do the two-step pre-flight + token round-trip

**Owner:** UI Agent
**Created:** 2026-05-30 (handoff from backend `backend-ipfs-upload-bind-file-to-signature`, flagged for the architect to file)
**Priority:** P1 (the SPA upload path is broken until this lands — `POST /api/ipfs/upload` now requires an `X-Upload-Token` header)

## Problem

The backend bound uploads to a single-use, fresh-auth-gated token. `POST /api/ipfs/upload` now rejects any request without a valid `X-Upload-Token` (401) and rejects a token whose declared SHA-256 does not match the uploaded bytes (400). The SPA's current single-shot upload in `frontend/src/api.js` will 401 until it adopts the two-step flow.

## Goal

Change the SPA upload to:
1. Compute the file's SHA-256 client-side (e.g. `crypto.subtle.digest('SHA-256', bytes)` → lowercase hex).
2. `POST /api/ipfs/upload-token` with `{ file_sha256, mimetype, size }`. On the light-account/JWT path, attach a `fresh_auth_proof` (mint one via the existing fresh-auth flow — see `backend-ipfs-upload-token-proof-binding` for whether this stays a session proof or becomes a per-action proof; coordinate before building). On the Keychain/signature path, the signed request body-hashes the descriptor automatically — no extra proof.
3. `POST /api/ipfs/upload` (multipart) with the returned token in the `X-Upload-Token` header.

## Acceptance

1. A successful supplementary-file upload works end-to-end from the SPA for both the Keychain path and the light-account/JWT path.
2. The SHA-256 sent in the pre-flight matches the bytes uploaded (no 400 mismatch on the happy path).
3. Clear UI error handling for `FRESH_AUTH_REQUIRED` (prompt re-auth), token expiry (re-mint), and SHA-256 mismatch.
4. Existing publish/edit flows that attach supplementary files continue to work.

## Blocked-by note

Confirm the proof kind with `backend-ipfs-upload-token-proof-binding` before wiring the JWT-path `fresh_auth_proof` so the client mints the correct kind. If that decision is still open when this is picked up, move to `blocked/` with a `[BLOCKED by Backend]` note.

## References

- `frontend/src/api.js` — `authenticatedRequest` (JWT path) and `signRequest` (Keychain path); the current upload call.
- `agents/docs/api-contracts/ipfs.md` — the `/upload-token` + `/upload` contract (request/response/error shapes, `X-Upload-Token`).
- `backend/src/routes/ipfs.ts` — the server side (for the exact field names and error codes).

## [BLOCKED by Backend] (2026-05-30) — RESOLVED 2026-06-08 (architect, moved to `tasks/pending/`)

**RESOLVED 2026-06-08.** The backend posture decision landed: `backend-ipfs-upload-token-proof-binding` archived 2026-06-06 choosing **(b) per-action target binding**. ARCHITECTURE.md § 6.4 no longer carries the "under review" note and documents that the JWT path requires a per-action `ipfs_upload`-targeted fresh-auth proof (target `(ipfs_upload, <username>, '')`); `api-contracts/ipfs.md` documents the per-action requirement; the server validates it via `ipfsUploadFreshAuthTarget` (`backend/src/lib/fresh-auth.ts`) in the upload-token route. The SPA must mint the per-action proof via `POST /api/custody/fresh-auth` with `action='ipfs_upload'` (password path) or `POST /api/orcid/start` with `mode='fresh_auth' action='ipfs_upload'` (ORCID path) before requesting the upload token. Original blocking detail preserved below.

The JWT-path proof kind is still undecided. `backend-ipfs-upload-token-proof-binding`
remains in `tasks/pending/` with its (a) session-class vs (b) per-action target-binding
decision unresolved, and ARCHITECTURE.md § 6.4 (Issue IPFS upload token row) still carries
"The session-proof choice (vs a per-action target binding) is under review in
`backend-ipfs-upload-token-proof-binding`." Per this task's "Blocked-by note", the SPA must
not be wired until the proof kind is fixed, or it will mint the wrong proof for the JWT path.

Unblock condition: backend lands the posture decision, removes the § 6.4 "under review" note,
and (if the decision is (b)) documents the per-action `action`/target the client must bind.
Backend moves this file back to `tasks/pending/` once resolved.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>

## UI implementation note (2026-06-08)

Implemented the two-step SPA upload. **This is auth-touching — apply the account-state
defense review (§ 6.1 / 6.4 / 6.5) at review intake.**

**Shape.** New per-file two-step HTTP in `frontend/src/api.js` (`uploadFileToIpfs`,
`mintIpfsUploadProof`); batch orchestration in new `frontend/src/lib/ipfs-upload.js`
(`createUploadSession` / `uploadFile` / `describeUploadError`); new promise-based password
modal `frontend/src/components/reauth-modal.js` (+ template in `index.html`, init in
`main.js`, modeled on `broadcast-confirm`). Callsites `publish.js` / `edit.js` wrap the
upload region in one session (`dispose()` in `finally`); `editor.js` inline-image upload
uses the single-shot `uploadFile`.

**Paths.**
- **Keychain (self):** signs the upload-token descriptor (binds the SHA-256, no proof). The
  upload step is gated by the single-use `X-Upload-Token`, not the auth method, so it goes
  out with the session JWT — self-custody pays exactly ONE Keychain prompt per file (the
  descriptor signature), not two. Relies on `verifyHiveSignature` skipping the proof on the
  signature branch (ipfs.ts upload-token handler) and accepting JWT on `/upload`.
- **Light + password (State A/B):** one password prompt per batch (held in the session
  closure, wiped on dispose), a fresh single-use `ipfs_upload`-targeted proof minted per file
  via `POST /api/custody/fresh-auth`. Wrong password re-prompts once; token-expiry re-mints +
  retries once.
- **Light, ORCID-only (State C, passwordless):** blocked up front with a "set a password in
  Settings" message (`common.uploadReauthRequired`). State C is detected via
  `fetchEmailStatus().data.hasPassword === false` (the backend returns an indistinguishable
  401 for wrong-password vs no-password, so the account-status flag is the only clean
  discriminator).

**Product decisions** (confirmed with the user, since the task text did not resolve them):
one password prompt per upload batch (vs per file), and block State C with a "set a password"
message (vs an ORCID redirect + file re-attach, which a `File` cannot survive across a
full-page navigation). A follow-up is NOT filed — State C users set a password once, then
upload normally.

**i18n.** Added `common.confirm`, `common.uploadReauthRequired`, `common.uploadCancelled`,
`reauth.title`, `reauth.message` to `en.json`; English stubs into the 15 other locales;
STUBS.md sweep `### Added 2026-06-08 (UI-IPFS-UPLOAD-TOKEN-ROUNDTRIP)`.

**Tests.** New `tests/unit/lib-ipfs-upload.test.js` (custody routing, State-C block,
prompt-once, per-file mint, wrong-password re-prompt, token retry, dispose) and
`tests/unit/components-reauth-modal.test.js`; upload HTTP-shape tests added to `api.test.js`
(self signs / light sends proof / X-Upload-Token); existing publish/edit/editor mocks
redirected from the old `uploadToIpfs` to the session. Full frontend unit suite green (1385);
build green. Not E2E-run (the two-step upload needs the full stack in test-mode); flagging for
the architect to decide whether an E2E spec is wanted before archive.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>

## Architect re-review (2026-06-09) — HELD PENDING FIXES

`/ce-code-review` ran on commit `1e1b2cde` (10 personas). Security is clean: §6.5
invariant #1 holds (the JWT path always carries the `ipfs_upload` proof, no JWT-only
reach to the upload token), no XSS in the modal/i18n, the password is never logged or
attached to an error, and the SHA-256 descriptor binds the exact uploaded bytes. The
happy paths for Keychain self-custody and light+password single-file upload are sound.
The following must land before archive. Anchor any code comments on the named symbols,
not on line numbers.

**1. (P1) `edit.js` supplementary-upload path has no page-level test, plus a dead mock.**
`pages-edit.test.js` mocks `uploadToIpfs` (a symbol `edit.js` no longer imports) and
never mocks `lib/ipfs-upload.js`, so the `createUploadSession()` upload region in
`edit.js`'s submit handler is entirely unverified while the structurally-identical
`publish.js` path is tested — the stale mock gives false green. Add a
`vi.mock('../../src/lib/ipfs-upload.js', ...)` mirroring `pages-publish.test.js`, add at
least one test that sets `supplementaryFiles` and asserts the session's `upload` is
called and `dispose()` runs in the `finally`, and remove the stale `uploadToIpfs` stub
from the api.js mock.

**2. (P2) Multi-image upload cancels all but the first image (light accounts).**
In `editor.js` the paste/drop/file-select handlers invoke `_handleImageUpload` per file
inside a `forEach`, firing concurrent `uploadFile` calls. Each opens its own session and
calls `reauthModal.request()`; the modal's refuse-while-open guard resolves every caller
after the first to `null`, surfacing a per-image "Upload cancelled" toast. Serialize
multi-image upload (drain the images sequentially through one session, or queue
concurrent `_handleImageUpload` invocations) so a light account can drop several images
at once. The same shared-`reauthModal` contention also bites an editor inline-image
upload that races a publish/edit batch — serializing, or gating on an "upload in
progress" flag, covers both.

**3. (P2) `mintProof` re-prompts on every UNAUTHORIZED, contradicting its own comment.**
In `lib/ipfs-upload.js`, `uploadOnce` calls `mintProof` for the initial mint and again on
the token-expiry retry; `mintProof` calls `ensureCredential` (a password prompt) on any
`UNAUTHORIZED`. The retry-path comment claims "the cached password means no re-prompt,"
but a session-JWT expiry or a mid-batch password change makes the retry mint return
`UNAUTHORIZED` and triggers a third, useless password prompt. Bound the re-prompt to once
per session (e.g. a `repromptUsed` flag that rethrows instead of re-prompting), and
correct the comment to state the actual behavior.

**4. (P2) `fetchEmailStatus()` failure hard-blocks a valid password-holder.**
`ensureCredential` awaits `fetchEmailStatus()` with no `try/catch`; a transient network
failure rejects and dead-ends the upload with a generic "upload failed," even for an
account that has a password. Wrap the status fetch so only an explicit
`hasPassword === false` blocks (the State-C carve-out); on a thrown/unknown status, fall
through to the password prompt (the backend re-verifies and 401s a genuine passwordless
account anyway).

**5. (P3) Production docblock cites a coordination path.**
The `api.js` upload docblock references `agents/docs/api-contracts/ipfs.md`. Per the
comment-anchor convention, replace it with a behavioral description of the two-step
pre-flight (the `/upload-token` then `/upload` round-trip), not an `agents/docs/` path.

**Architect-resolved — do NOT change in code (review finding on State C).** The State-C
"set a password" block is approved product behavior. I reconciled the docs to match
(commit subject `architect(ipfs-upload): record SPA State-C upload carve-out`):
ARCHITECTURE.md §6.4 and `api-contracts/ipfs.md` now record the SPA's password-only
carve-out. Do not wire the ORCID upload path.

**E2E decision.** A full-stack E2E spec for the two-step upload is NOT required for
archive. The unit suite plus fix #1 (edit-path page coverage) is sufficient. A real-stack
E2E can be a separate follow-up if wanted; it does not block this task.

**Reviewed and dismissed (no action).** Preemptive/theoretical or covered by the
project's stance against preemptive test-hardening: `describeUploadError` reimplemented in
two test mocks; retry tests not asserting the fresh proof is passed; untested editor
i18n-key error branch; untested publish primary-PDF failure toast; `api.test.js`
descriptor omitting the `size` assertion; no "incorrect password" feedback after the 2nd
wrong password; 503 treated as terminal (no `isRetriable503` retry); 403 binding-violation
not distinguished from 401 before the retry; orphaned API calls when navigating away
mid-modal; State-D routed to the Keychain path (not a new dead-end — the existing
broadcast step already Keychain-gates State D); lib reaching into `Alpine.store` (works;
design-purity only). The pre-existing `FE-ERR-MESSAGE-SANITIZE-SWEEP` task-slug comment in
`pages-publish.test.js` and the missing `isSubmitting` entry guard in `handleSubmit` are
pre-existing — fix opportunistically if you touch those lines, not required here.

When the five fixes land, `git mv` this file back to `tasks/review/` for re-review.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>

## UI re-review signal (2026-06-09, commit b469a935 on main)

All five hold-block fixes landed (worker implemented in a worktree; parent
cherry-picked the single commit cleanly onto main as b469a935; the original
worktree commit 87b46234 was a stale-base recovery, see note at the bottom).

- **Fix 1 (P1, `tests/unit/pages-edit.test.js`):** dropped the dead `uploadToIpfs`
  stub from the api.js mock; added `vi.mock('../../src/lib/ipfs-upload.js', ...)`
  mirroring `pages-publish.test.js` (hoisted `mockSessionUpload`/`mockSessionDispose`);
  added describe block `editPage handleSubmit supplementary-file upload session`
  with two tests — one asserts `createUploadSession().upload(sf.file)` runs per
  file with the cid embedded in the broadcast `json_metadata.supplementary_files`,
  the other asserts `dispose()` fires in the `finally` even when an upload throws.
- **Fix 2 (P2, `editor.js`):** chose the architect's second sanctioned option
  ("queue concurrent `_handleImageUpload` invocations") — a fire-and-forget
  sequential `_imageUploadQueue` + `_drainImageUploadQueue` with a re-entrancy
  guard; the three `forEach(_handleImageUpload)` call sites (`_bindFileInput`,
  `handleDrop`, `handlePaste`) now enqueue, and `handleDrop`/`handlePaste` keep
  their synchronous boolean return. This fixes the **primary** deliverable: a
  light account can drop several images at once without all-but-first cancelling.
  **OPEN FOR ARCHITECT:** the cross-surface sub-case you flagged ("an editor
  inline-image upload that races a publish/edit batch") is NOT covered by an
  editor-instance-local queue — neither editor-local option (one-session or
  queued-invocations) serializes the editor's session against a separate
  publish/edit-page batch session, because both call the singleton
  `reauthModal.request()` and the refuse-while-open guard resolves the second
  concurrent caller to null. Covering it needs a GLOBAL gate (reauthModal-level
  FIFO queue instead of refuse-while-open, or a shared upload-in-progress flag),
  which changes the reauthModal contract (modeled on broadcast-confirm) and is a
  larger, separate change. Please confirm whether the editor-local serialization
  satisfies Fix 2 as written, or whether you want the global gate (here or as a
  follow-up task).
- **Fix 3 (P2, `lib/ipfs-upload.js`):** `repromptUsed` flag (reset in `dispose()`)
  bounds the password re-prompt to once per session across both `mintProof` sites;
  a second `UNAUTHORIZED` rethrows. Retry-path comment corrected.
- **Fix 4 (P2, `lib/ipfs-upload.js`):** `ensureCredential` wraps `fetchEmailStatus()`
  in try/catch; only explicit `hasPassword === false` blocks (State-C), a
  thrown/unknown status falls through to the prompt.
- **Fix 5 (P3, `api.js`):** the `agents/docs/api-contracts/ipfs.md` citation in the
  `mintIpfsUploadProof` docblock is replaced with a behavioral description of the
  two-step `/upload-token` then `/upload` round-trip; the unrelated `orcid.md` /
  `common.md` references are untouched.

**Verification (parent, on main after cherry-pick):** full frontend unit suite
green — 1415 pass (up from 1413; +2 from the new edit-page tests). The 3
`pages-edit.test.js` `_mountEditors` "Unhandled Rejection" warnings are
PRE-EXISTING (reproduce on base before any edit here) and do not fail the suite.
`npm run build` green. Not E2E-run (architect's hold block: E2E not required).

**Stale-base note (for fan-out hygiene):** the worker's worktree was branched
127 commits behind main (HEAD `aa60d465`), the `feedback_worktree_fanout_stale_base`
failure mode; the worker recovered with `git merge --ff-only main` before working
(its HEAD was a clean ancestor, lossless) and committed 87b46234. Parent verified
parent `1150c50a` is an ancestor of main and cherry-picked to b469a935 with zero
conflicts (the two concurrent `ui(notifications)` commits touched disjoint files).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>

## Architect re-review (2026-06-09, round 2) — 5 prior fixes VERIFIED; HELD PENDING TESTS

Re-reviewed commit `b469a935` via `/ce-code-review` (9 personas; correctness/security/adversarial
on the session model). **All 5 fixes held on the prior round landed and verify.** Security is clean —
§6.5 invariant #1 holds (the JWT upload path always carries the `ipfs_upload` proof; the backend
re-verifies State C at mint time; the password never logs/leaks). The editor queue's re-entrancy,
FIFO ordering, per-file error isolation, and late-drop guard are correct; the `repromptUsed` bound and
the Fix-4 fallthrough are functionally sound; Fix 5 is anchor-clean. No P0/P1, no auth bypass.

**Cross-surface contention (your OPEN question) — RESOLVED: editor-local serialization satisfies
Fix 2.** The within-editor queue fixes the targeted multi-image-cancel bug. The cross-surface case (an
editor inline-image drain racing a publish/edit page batch on the singleton `reauthModal`) is
pre-existing — the prior concurrent `forEach` was strictly worse — and both the adversarial and
frontend-races reviewers agree the editor-local fix is sufficient for what Fix 2 targeted. Do NOT build
the global gate here; it is filed as a separate follow-up: `ui-reauth-modal-global-upload-gate`
(in `tasks/pending/`).

**HELD PENDING FIXES — add the 3 missing behavior tests.** Each fix shipped with no direct unit test;
reverting any one ships the suite green. These are this task's own deliverables, not preemptive
hardening.

1. **(P2) Queue-serialization test** (`editor.js` `_queueImageUploads`/`_drainImageUploadQueue`).
   Assert: N files in one enqueue → N sequential `_handleImageUpload` invocations in FIFO order; the
   `_imageUploadDraining` guard prevents a concurrent second drain; setting `this.editor = null`
   mid-drain stops iteration and resets the draining flag. Use the existing `editor.test.js`
   prototype-stub technique.
2. **(P2) `repromptUsed`-bound test** (`lib/ipfs-upload.js`). Assert: a first `UNAUTHORIZED`
   re-prompts once and retries; a second `UNAUTHORIZED` rethrows WITHOUT a third prompt (reauth
   requested exactly twice); `dispose()` resets `repromptUsed` so a fresh session re-prompts again.
   Construct the error via the real `ApiRequestError` shape (`code`, not `status`) per the
   test-fabricated-error-shape convention — not a hand-rolled `{ code: 'UNAUTHORIZED' }`.
3. **(P2) Fix-4 fallthrough test** (`lib/ipfs-upload.js` `ensureCredential`). Assert: when
   `fetchEmailStatus()` THROWS (transient), the session falls through to the password prompt and
   succeeds (does NOT dead-end); an explicit `hasPassword === false` still blocks with
   `UPLOAD_REAUTH_UNAVAILABLE`.

**Optional P3s — fold in while you are in these files (NOT blocking):**
- `editor.js` `destroy()` does not clear `_imageUploadQueue` or reset `_imageUploadDraining`. Nil live
  impact today (no PevoEditor re-mount path) but the `synchronous-flag-before-await-idempotency-guard`
  convention wants the teardown reset. One-line defensive add.
- `lib/ipfs-upload.js` Fix-4 `catch {}` is bare; it also swallows programming errors (e.g. a `TypeError`
  in `fetchEmailStatus`). Functionally safe (bounded by `repromptUsed`, backend-authoritative). If
  touched, narrow it to not swallow non-`ApiRequestError` throws — do NOT add a log line (PEvO
  minimal-logging stance).

**Reviewed and dismissed (no action):** the "`isUploading` flicker" three reviewers raised —
`isUploading` is write-only (no reader/binding), so the cluster is inert; the real per-file
`imgBtn.textContent` toggle is pre-existing `_handleImageUpload` behavior and acceptable for sequential
uploads. Pre-existing anchor rot in `pages-edit.test.js` (a SHA describe-header anchor and task-slug
describe headers) and the missing clause-(a) mock-justification comment are out of scope (fix
opportunistically only). The clause-(c) real-path-companion question is settled by the prior round's
"E2E not required for archive" decision.

When the 3 tests land, `git mv` this file back to `tasks/review/` for a quick re-review scoped to the
new commit.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>

## UI re-review signal (2026-06-09, round 2, commit 17dff0c3 on main)

All three round-2 hold tests landed (commit `17dff0c3`).

- **Test 1 (P2, editor queue serialization, `tests/unit/editor.test.js`).** New
  `describe('PevoEditor image-upload queue')` drives `_queueImageUploads` /
  `_drainImageUploadQueue` on a prototype-backed stub (no DOM / no Tiptap mount),
  with `_handleImageUpload` replaced by a recorder. Three `it`s pin: (a) N files
  in one enqueue drain in FIFO order, strictly one at a time (`maxInFlight === 1`)
  with the flag cleared at the end; (b) the `_imageUploadDraining` guard makes a
  concurrent second drain early-return without double-processing; (c) tearing down
  the editor mid-drain (`stub.editor = null`) stops iteration and resets the
  draining flag.
- **Test 2 (P2, `repromptUsed` bound, `tests/unit/lib-ipfs-upload.test.js`).** A
  first `UNAUTHORIZED` re-prompts once and retries; a second rethrows WITHOUT a
  third prompt (reauth requested exactly twice); `dispose()` resets the bound so a
  reused session re-prompts again. Errors are built via the real `ApiRequestError`
  (`code`, no `status`) per the test-fabricated-error-shape convention — the mock
  now uses `importOriginal` + spread to expose the real class, and `codedError`
  delegates to the real constructor (so every existing call site also builds the
  real type).
- **Test 3 (P2, Fix-4 fallthrough, `tests/unit/lib-ipfs-upload.test.js`).** A
  transiently-throwing status fetch falls through to the prompt and succeeds (does
  NOT dead-end); an explicit `hasPassword === false` still blocks with
  `UPLOAD_REAUTH_UNAVAILABLE`. The throw case uses a raw `TypeError` (fetch's real
  network-down shape) to actively guard the bare catch — see the P3 note below.

**Optional P3s.**
- **Taken:** `PevoEditor.destroy()` now clears `_imageUploadQueue` and resets
  `_imageUploadDraining` (teardown-side flag-before-await idempotency guarantee).
- **Deliberately NOT taken (with reason):** narrowing the `ensureCredential`
  Fix-4 `catch` to `instanceof ApiRequestError`. `request()` in `api.js` only
  wraps `!res.ok` HTTP responses in `ApiRequestError`; a genuine transient failure
  — network down (raw `TypeError`) or the 30s `AbortSignal.timeout` (raw
  `DOMException`) — escapes `fetch` UNWRAPPED. Narrowing to `ApiRequestError`-only
  would rethrow those and dead-end the upload, re-breaking the exact behavior Fix 4
  established. The bare catch is therefore intentional; Test 3's raw-`TypeError`
  case fails if anyone narrows it. Flagging in case the architect still wants a
  different shape (e.g. catch + rethrow only on a allow-list of programming-error
  constructors), but the safe default is to leave it bare.

**Verification.** `tests/unit/editor.test.js` green — 34 pass (up from 31);
`tests/unit/lib-ipfs-upload.test.js` green — 15 pass (up from 11). Full frontend
unit suite + build run at the end of the UI batch (this is one of three held tasks
landing together). Not E2E-run (architect's prior round: E2E not required for
archive).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>

## Architect re-review (2026-06-09, round 3) — HELD PENDING FIX (1 item)

Re-reviewed commit `17dff0c3` (the 3 round-2 hold tests + the `destroy()` queue
reset) via `/ce-code-review` scoped to that commit only (6 personas:
correctness on Opus; testing/maintainability/project-standards/frontend-races/learnings
on Sonnet; ce-agent-native skipped per PEvO).

**All 3 required round-2 tests landed and VERIFY as genuine mutation-killers.**
correctness, testing, and frontend-races each independently traced that reverting
any one production fix turns its test RED: (1) the editor queue test pins FIFO /
strict one-at-a-time via an intermediate `toHaveBeenCalledTimes(1)` and the
re-entrancy guard / mid-drain-break assertions; (2) the `repromptUsed` test asserts
reauth is requested EXACTLY twice and that `dispose()` re-arms it; (3) the Fix-4
fallthrough test uses a raw `TypeError` to actively guard the bare catch. Errors are
built via the real `ApiRequestError` (`code`, not `status`) per the
test-fabricated-error-shape convention. The learnings researcher's microtask-FIFO
false-pass concern was checked and cleared. Security posture unchanged (no new
production auth surface in this commit). All 3 changed test files green on HEAD.

**HELD PENDING FIX:**

1. **(P3) New anchor rot: a coordination-label prefix on a test comment.** The
   comment above the `ensureCredential` transient-status-fetch fallthrough test in
   `frontend/tests/unit/lib-ipfs-upload.test.js` opens with a `Fix 4:` hold-item
   ordinal. That ordinal is round-2-hold coordination state with no stable referent
   once this task archives, so it violates the comment-anchor convention. This is the
   exact failure mode `convention-enforcing-fix-must-audit-its-own-new-code` warns
   about (the commit that ADDS anchor-clean tests introduced a fresh coordination
   label). Flagged by correctness, maintainability, and project-standards (3
   reviewers; frontend-races dissented on the grounds that the behavioral text follows
   it). Fix: drop the ordinal prefix only; the behavioral sentence that follows it is
   already a stable anchor and stays. Do not substitute a task slug, SHA, or line
   number.

**Reviewed and dismissed (no action):**
- The optional-P3 `destroy()` queue/flag reset has no DIRECT unit test (sub-test 1c
  models the effect via `editor = null` rather than calling `destroy()`). This was
  explicitly optional / non-blocking in the round-2 hold; the 3 REQUIRED tests all
  landed and verify. Not held.
- The deliberately-NOT-taken P3 (narrowing the `ensureCredential` catch to
  `instanceof ApiRequestError`) is correctly left bare — `fetch` surfaces network /
  timeout failures as raw `TypeError` / `DOMException` that escape `request()`
  unwrapped, so narrowing would re-break Fix 4. Accepted as-is.

When the prefix is dropped, `git mv` this file back to `tasks/review/` for a quick
re-review scoped to the new commit.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
