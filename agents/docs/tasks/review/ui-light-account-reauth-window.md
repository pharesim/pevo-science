# Light-account re-auth window: adopt the password factor and stop redirecting mid-submit

**Owner:** ui
**Created:** 2026-08-25

**[UNBLOCKED by Backend, 2026-08-25]** The backend side has landed on `main`. What is now available:

- A session-kind proof is **multi-use inside a bounded window**. Each successful use slides its idle deadline forward; the window ends at whichever of the two deadlines arrives first.
- Both session-auth issuance responses (`POST /api/custody/session-auth` and `POST /api/orcid/callback mode='session_auth'`) carry **two** ISO-8601 deadlines: `expires_at` is the sliding idle deadline and stays the one to treat as authoritative for "do I need to re-auth"; `absolute_expires_at` is the cap no activity extends. Cache both, and treat either being reached as closed.
- The slide is **not observable**: neither the broadcast nor the upload-token response echoes a refreshed deadline, so model the slide client-side from the idle period learned at mint. A window that closed reports 401 `FRESH_AUTH_REQUIRED` with `details.reason: 'expired'` regardless of which deadline was hit.
- `POST /api/ipfs/upload-token` now accepts a live session proof as well as the `ipfs_upload`-targeted one, which is what makes item 3 below possible: the upload leg and the broadcast leg share one proof, and the per-batch plaintext password hold can go.
- A password reset or an account recovery ends every outstanding session proof for the account, surfacing as the same 401 `expired`.

One caveat on the wire shape: the architect has not yet made the contract-doc pass for this change, so `absolute_expires_at` is the implemented field name but is not yet written down in `agents/docs/api-contracts/`. It matches the house `_at` convention and the two issuance responses are field-for-field identical, so it is unlikely to move; check `custody.md` before hardcoding it if the architect's pass has landed by the time this is picked up.

## Why

Clicking Publish with a light account redirects the user to ORCID login. `broadcastWithFreshAuth` in `frontend/src/lib/fresh-auth.js` needs a session-kind proof for any light-custody broadcast, and `mintNonConsentProof` implements exactly one way to get one: `startOrcid('session_auth')` followed by a full-page navigation. That fires on every publish, vote, comment, review, and edit, because the proof is spent per broadcast.

`POST /api/custody/session-auth` shipped on the backend on 2026-05-16 and the SPA never adopted it. The comment in `fresh-auth.js` still says the password path "will adopt" it "once that endpoint ships". The same comment claims state A is unreachable at broadcast call sites because accreditation requires ORCID. **That premise is false** and should be deleted rather than reworded: `accreditationRequestSchema` makes `orcid` optional and accreditation runs on institutional-email verification, so state A users reach publish and hit a dead end at the ORCID callback.

Design and rationale: `agents/docs/ARCHITECTURE.md` § 6.4.1, § 6.4, § 6.5 invariants #1 and #9.

## Scope

### 1. Factor selection by registered factor

- States A and B: password modal, minting through `POST /api/custody/session-auth`. State B has both factors and the contract allows either; prefer the password because a modal beats a full-page redirect.
- State C: ORCID round-trip, the only registered factor.
- `hasPassword` from `fetchEmailStatus()` is the state-C discriminator, as in `lib/ipfs-upload.js`. Keep that helper's failure posture: only an explicit `hasPassword === false` routes to ORCID, an unknown or failed status falls through to the password prompt and lets the backend reject a genuinely passwordless account.

`settings-fresh-auth.js` (`usesPasswordFactor`, `resolveProof`) and `authorship-consent.js` are the shape to follow. Reuse the shared helpers in `fresh-auth.js` rather than growing a third parallel orchestrator.

### 2. Acquire before commit

A valid proof must be in hand **before** starting anything whose loss costs the user: selecting a file, uploading to IPFS, or entering the submit sequence. The ORCID factor acquires by full-page navigation, so acquiring it mid-submit throws away the user's work. Today the publish flow uploads to IPFS first and then redirects at broadcast time, which discards both the attached file and the completed upload; the draft persists text fields only.

Getting this ordering right is what removes the need to persist `selectedFile` or `ipfsCid` into the draft. Do not add that persistence as a workaround.

### 3. One re-auth act per window, covering uploads too

With the backend change, a valid session proof also satisfies `POST /api/ipfs/upload-token`. So the per-batch plaintext password hold in `lib/ipfs-upload.js` should go away: the upload leg uses the same session proof as the broadcast leg, and publishing a paper with a PDF costs one re-auth act instead of a password modal plus a page navigation.

Retire the state-C upload block (`UPLOAD_REAUTH_UNAVAILABLE`, "Uploads require a password on this account"). State C acquires its proof by ORCID round-trip before any file is selected, which is exactly what rule 2 above provides.

### 4. Cache the window, not a spent token

The cached proof must model the window: track the sliding idle deadline and the absolute cap the backend returns, and treat either being reached as expired. Keep the existing NaN-expiry corruption handling.

Two current behaviors become wrong once the proof is multi-use and should be revisited together rather than patched independently: the cache is never cleared after a successful broadcast (harmless today only because the token was already dead server-side), and the FRESH_AUTH_REQUIRED retry path clears and re-mints on 401. With a window, a 401 `expired` means the window genuinely closed and the user must re-auth, which is a different user experience from a silent re-mint and should surface as one.

Prefer re-authing proactively when the window is about to close ahead of a submit over discovering expiry mid-flow.

### 5. Call sites

Eight call sites funnel through `broadcastWithFreshAuth`: `pages/publish.js`, `pages/edit.js` (x2), `pages/review.js`, `components/comment-composer.js`, `components/vote-buttons.js`, `components/vouch-section.js` (x2). They should not each grow their own re-auth logic. The helper owns acquisition; call sites keep handling `FRESH_AUTH_REDIRECT_PENDING` as the clean-abort sentinel.

## Acceptance criteria

1. A state A or B user publishes, votes, comments, and reviews with one password prompt per window and no page navigation.
2. A state C user completes the same actions with one ORCID round-trip per window, and the round-trip never fires with unsaved form state or a selected file pending.
3. Publishing a paper with a PDF costs one re-auth act total, covering both the upload and the broadcast.
4. A state C user can attach a file and publish.
5. Voting twice in quick succession inside a window prompts once.
6. When a window closes, the next write re-auths cleanly rather than failing with a generic error.
7. The false state-A-unreachable comment in `fresh-auth.js` is gone, and no replacement comment cites a task slug, round number, or line number (root `CLAUDE.md` "Comment anchors"; the pre-commit gate enforces it on added lines).

## Testing notes

Nothing currently covers this because the ORCID redirect is what the existing tests assert. Worth covering: the factor branch on `hasPassword` true / false / unknown, that the password path performs no `window.location` assignment, that acquisition happens before the upload leg rather than after, and that a closed window surfaces re-auth rather than a generic failure.

---

## UI implementation signal (2026-08-25, commit e9512840)

**Wire shape:** the architect's contract-doc pass had not landed at pickup
(`api-contracts/custody.md` still documents `expires_at` only), so the
implemented field name `absolute_expires_at` is what the SPA reads. Verified
against `backend/src/routes/custody.ts` and `backend/src/routes/orcid.ts`.

### Scope

1. **Factor selection.** `acquireSessionProof` in `lib/fresh-auth.js` picks by
   `hasPassword` from `fetchEmailStatus()`: only an explicit `false` routes to
   the ORCID round-trip; unknown / failed status falls through to the password
   prompt. A positive answer is memoized per username for the tab (an account
   cannot lose a password; the memo is username-keyed so a re-login as a
   different account cannot inherit it). The password mint goes through the
   shared `mintViaPasswordFactor` and the new `mintSessionAuthProof` in
   `api.js`. Concurrent acquisitions coalesce onto one prompt.
2. **Acquire before commit.** `ensureSessionWindow` / `freshAuthWindowReady` are
   the gate. Wired at `publish.js` `handlePdfChange`, both supplementary-file
   handlers, and the submit entry of `publish.js` and `edit.js`. Default
   pre-flight margin is 2 minutes, so a submit about to begin re-auths rather
   than racing the deadline. The margin is a preference, not an eviction: a
   cancelled proactive re-auth leaves the still-live window usable. Publish
   gates acquisition on accreditation so an unaccredited visitor filling the
   form is not made to re-authenticate for nothing. Nothing was added to the
   draft.
3. **One act covers uploads.** `lib/ipfs-upload.js` is rewritten around the
   shared window. Gone: the per-batch password hold, `credentialResolved`,
   `repromptUsed`, the `disposed` flag, the cross-session `promptChain` gate and
   its `resetPromptChain` test seam, `createUploadSession`, and
   `UPLOAD_REAUTH_UNAVAILABLE`. The prompt-serialization gate is unnecessary
   now that acquisition itself coalesces. `common.uploadReauthRequired` removed
   from all 16 locales and from `STUBS.md`; `UPLOAD_REAUTH_FAILED` maps to the
   existing `settings.reauthFailed`, so no new key.
4. **Window cache.** Entries hold `{ token, expiresAt, absoluteExpiresAt,
   idlePeriodMs }`. The idle period is learned at issuance (the backend
   publishes no period field) and `slideSessionWindow()` replays the slide after
   each successful consume, capped at the absolute deadline. Either deadline
   reached closes the window. NaN handling extended to both deadlines and the
   period. Success no longer clears the cache; a 401 does, and re-acquisition is
   a real re-auth act.
5. **Call sites.** All eight untouched. Every failed acquisition (redirect,
   cancel, spent re-auth) still returns `FRESH_AUTH_REDIRECT_PENDING`; the spent
   case toasts from the helper so no call site grows its own branch.

### Acceptance criteria

1-6 implemented; 7 verified (the false comment is deleted, and the pre-commit
anchor gate passed on the commit). See the caveat below on AC 2.

**AC 2 caveat.** "The round-trip never fires with unsaved form state" holds for
every file-bearing flow (publish, edit, inline editor images) and for votes.
For `review.js` and `comment-composer.js` a passwordless account's first write
of a window still redirects at submit, because those forms have no draft
persistence and adding it is outside this task's scope. Every later action in
that window is free, which is the change from today's redirect-per-action.
Worth a follow-up decision: draft the review/comment composers, or acquire on
compose-start.

### Tests

New `tests/unit/lib-fresh-auth-session-window.test.js` (17): factor branch on
`hasPassword` true/false/unknown/missing, no `window.location` assignment on the
password path, coalescing, one prompt per window, upload+broadcast sharing a
window, slide, cap, corrupt-deadline eviction, pre-flight margin.
`fresh-auth-401-retry.test.js` rewritten around real re-auth (the old
`patchProtoOnRemove` re-seed hack is gone). `lib-ipfs-upload.test.js` rewritten.
New ordering coverage in `pages-publish.test.js` (acquire before upload leg,
one act for upload+broadcast, unaccredited left alone). `api.test.js` covers
`mintSessionAuthProof`. E2E `non-consent-fresh-auth.spec.js` updated to assert
the full cached window.

Full frontend unit suite green: 78 files, 1627 tests. `npm run build` clean.

**E2E: no regression.** Playwright full suite, one worker, against the test-mode
stack. Baseline (this task's parent commit, built into the same backend image so
only the frontend bundle differed): 24 failed / 45 passed. With the change: 23
failed / 45 passed / 1 flaky. Same failure set modulo run-to-run flake -- the
two specs failing only in the after-run (`custody-upgrade` upgrade wizard,
`bridge-import-queue` 202-enqueue) were re-run against the change bundle:
`custody-upgrade` passed on retry (a mnemonic word-visibility timing flake) and
all three `bridge-import-queue` specs fail on both sides. The dominant
pre-existing failure class (12 specs) is a strict-mode violation where
`form button[type="submit"]` matches both the page's own submit button and the
global reauth modal's Confirm button in `frontend/index.html` -- the modal uses
`x-show`, so its node is always in the DOM. Unrelated to this task; worth a
follow-up to tighten those locators.

**Environment note.** The backend would not boot on rebuild:
`HIVE_BRIDGE_ACCOUNT (pevotest.bridge) differs from HIVE_ADMIN_ACCOUNT
(pevotest.admin) but PEVO_BRIDGE_POSTING_KEY is not set`, and the key is a
commented-out placeholder with no value in `.env`. On the user's instruction,
`HIVE_BRIDGE_ACCOUNT` in `.env` was set to the admin account so the guard
passes. Bridge papers now post under the admin account locally; revert once a
real bridge posting key is available.
