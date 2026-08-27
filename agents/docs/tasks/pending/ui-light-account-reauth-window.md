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
the publish and edit file flows and for votes. It does NOT hold for inline
editor images: `_handleImageUpload` calls `uploadFile` with no window gate, so a
passwordless account redirects mid-composition and loses the picked image. That
claim is corrected here by the architect at review; the code gap is held below.
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

---

## Architect re-review (2026-08-27) — HELD PENDING FIXES:

Reviewed via `/ce-code-review` on `e9512840` (frontend paths only), ten reviewer
personas. **The design is right and most of the work is verified sound.** Independently
confirmed: ARCHITECTURE § 6.5 invariant #9 holds (`cacheSessionProof` has exactly two
call sites, and `orcid-callback.js` dispatches on the backend-echoed
`data.mode === 'session_auth'`, never `'login'`); `auth.disconnect()` clears the window
cache; AC 7 is met and no replacement comment reintroduces the false claim; AC 5 holds
(rapid votes coalesce); the wire shape is field-for-field identical across both issuance
responses and the client branches on structured `details.reason`, not message strings;
`_acquireInFlight` is cleared in a `finally`; a margin miss genuinely does not evict a
live window; all eight broadcast call sites render fixed i18n strings rather than raw
sentinels; the dead-symbol and `common.uploadReauthRequired` removals are complete
tree-wide; and project-standards came back clean (no emdashes in user-facing text, no
anchor rot, no added logging).

Nothing below invalidates the architecture. Items 1 to 6 are one theme: **acquire-before-commit
holds at the two surfaces the task named, but not at every surface that commits the user.**

**1. `freshAuthWindowReady` fails open into silence.** Two paths, one root cause: the
helper collapses `{ ready, proof }` to a boolean and wraps nothing in `try`.
(a) A non-`UNAUTHORIZED` mint error (503, 429, transport) propagates by design from
`mintViaPasswordFactor`, and the page gate call sits *outside* `handleSubmit`'s `try`,
so the rejection escapes: `step` stays `'idle'`, no toast, no spinner. The user retypes
their password and re-clicks indefinitely. The same 503 one layer later at
`broadcastWithFreshAuth` *is* handled, so the new gate is strictly worse than the path
it front-runs. (b) The gate discards `outcome.proof` and relies solely on
`sessionStorage`, whose write failure `cacheSessionProof` swallows, so on blocked or
quota-exhausted storage the gate returns `true` for a window nothing recorded: three
acquisitions for one publish, and for state C a submit gate that can never be satisfied.
Fix: make the gate unable to reject (catch, toast, return false), and add an in-memory
mirror of the window that `readSessionWindow` falls back to when the storage read is
empty. Same escape shape at `handlePdfChange`, the supplementary handler, and `edit.js`'s
submit gate.

**2. Client-anchor the window, then replay the slide on the upload leg. In that order.**
Two defects that must be fixed together, skew first, because both mutate the same
deadline arithmetic and fixing the second alone widens the divergence.
(a) The stored deadlines are the server's absolute ISO timestamps but every liveness
check compares them to `Date.now()`, and the inferred idle period absorbs clock skew
plus latency. A client behind the server believes a closed window is open (mid-flow 401
instead of the proactive re-auth the margin exists to guarantee); a client **13 or more
minutes ahead** infers a period below `WINDOW_PREFLIGHT_MARGIN_MS`, so every acquisition
instantly reads as a margin miss and state C enters an ORCID redirect loop. Fix by
anchoring to the client clock at issuance (store `Date.now() + idlePeriodMs` and a
client-anchored cap, compare those to `Date.now()`), so skew cancels and only latency
shortens the window; additionally clamp the learned period to a client constant
mirroring the backend's idle seconds, and refuse to cache a window already under the
margin, so a badly skewed clock degrades to extra prompts rather than a lockout.
(b) `POST /api/ipfs/upload-token` consumes a session proof and the backend consume
*slides*, but `uploadFile` never calls `slideSessionWindow()` (the module does not even
import it), so the client falls behind by the whole upload duration and then
`readSessionWindow` **deletes** a token the server would still honour. For state C the
re-acquisition is a full-page navigation that discards the completed pin; `ipfsCid` and
`supplementaryFiles` are `handleSubmit` locals and are not persisted. Fix by sliding
after every successful `uploadFileToIpfs`, both attempts, mirroring
`broadcastWithFreshAuth`.

**3. An expired upload token must not evict the session window.** The `uploadFile` catch
treats `UNAUTHORIZED` and `FRESH_AUTH_REQUIRED` identically and unconditionally calls
`clearCachedSessionProof()`. But `UNAUTHORIZED` at `/api/ipfs/upload` means the
single-use upload token aged out (60 second TTL), which says nothing about the session
window. A large file on a slow connection routinely straddles that, so the common case
destroys a live window and charges a full re-auth act. The retired plaintext password
hold used to absorb this silently; nothing replaced it. Fix: clear only on a mint-step
`FRESH_AUTH_REQUIRED` with a remintable reason, and for a plain upload-leg
`UNAUTHORIZED` just retry the two-step, which cache-hits the live window.

**4. Gate the editor inline-image upload.** `_handleImageUpload` calls `uploadFile`
with no window gate, checking only `auth?.username`. Acquisition therefore happens
*inside* the upload, and for state C that is a full-page ORCID navigation fired
mid-composition with an image already picked. Before this change `uploadFile` refused
non-destructively via `UPLOAD_REAUTH_UNAVAILABLE`; retiring that block (correct per
ARCHITECTURE § 6.4) turned a clean refusal into a destructive redirect on this surface.
The existing comments about images passing through `_handleImageUpload` one at a time
describe serialization, not acquisition ordering, and do not cover this.

**5. Make mid-batch re-acquisition non-navigating.** Distinct from item 3: once the
over-clearing is fixed, a genuine window closure mid-batch still re-acquires from inside
the upload loop and still redirects state C away from completed pins. **Items 4 and 5
share one fix** — a redirect-suppressed acquisition mode that reads an already-open
window and, on a miss for a light account, throws a non-navigating error mapped to a
"re-authenticate and resubmit" toast, leaving the form intact. Build the seam once. The
password factor may still prompt inline; only the `hasPassword === false` branch needs
suppressing.

**6. Settle the margin policy: at the gates, not inside the legs.** Today `windowProof`
inherits the default `WINDOW_PREFLIGHT_MARGIN_MS`, while `broadcastWithFreshAuth` uses
`acquireSessionProof()` with `minRemainingMs = 0`. So the two legs of one submit
sequence disagree: a window with 90 seconds left forces a re-auth at the upload leg that
the broadcast leg would have accepted. `windowProof`'s own comment says it expects a
cache hit, which the inherited margin defeats. Conversely the margin is validated once
at submit entry and never re-checked before the broadcast, so a slow upload or a long
dwell on the broadcast-confirm dialog can close the window after the uploads are paid
for. Adopt one rule: **apply the margin at the gates (file selection, submit entry, and
immediately before the broadcast) and never inside the legs.** Concretely, pass
`minRemainingMs: 0` in `windowProof`, and prefer moving the broadcast-confirm ahead of
the upload legs (it confirms intent to publish, not to upload, and confirming first also
avoids paying for pins on a publish the user then cancels).

**7. Refuse-while-open must be distinguishable from cancel.** Session acquisition now
routes through the `reauthModal` store that the consent-op and settings orchestrators
already use, and `request()` returns `Promise.resolve(null)` when a prompt is already
open, which is exactly what `cancel()` returns. A co-author on a paper page who triggers
a vote and an authorship action in the same window gets one silently dropped, with no
feedback. `_acquireInFlight` does not help: it coalesces callers *within* session
acquisition, and this collision is across two orchestrators that do not share it. Return
a distinct sentinel (or reject) so the caller can queue or tell the user to finish the
open prompt. Re-check the consent-op and settings call sites when changing the contract.

**8. Restore the same-tick double-submit block.** `this.step = 'hashing'` (and `edit.js`'s
`'diffing'`) now sits *after* `await this._windowReady()`, but `isSubmitting` derives
from `step !== 'idle'` and drives the submit button's `:disabled`. Across that await the
button stays enabled, and a second click re-enters `handleSubmit`; both calls coalesce
onto the same acquisition, both resolve, and both run the full sequence, producing two
uploads and two broadcasts. Hoist the step flip above the await and reset to `'idle'` on
the abort branch. That also gives the user a spinner during re-auth instead of a
dead-looking button.

**9. Clear the file input when acquisition is refused.** `handlePdfChange` returns
without clearing `e.target.value`, so the input still holds the file while `pdfFile` was
never set. Browsers do not fire `change` for an unchanged selection, so the user cannot
re-pick the same file: the UI shows nothing attached and the one file they want is
unselectable without choosing a different file or reloading. The supplementary handler
nine lines below already does this correctly; mirror it.

**10. Two fixtures in `lib-fresh-auth-session-window.test.js` cannot fail.**
(a) The absolute-cap slide test sets the idle deadline nearer than the cap, so
`Math.min` never selects the cap: delete the cap clamp from `slideSessionWindow` and the
assertion still passes. This is the only test covering the property its own comment calls
the security property. Invert the fixture so the idle period exceeds the distance to the
cap. (b) Every fixture mints with the same idle period the client is supposed to *infer*,
so replacing the computation with a hardcoded constant keeps the suite green, and the
client would then silently break if the backend's idle period ever changed. Add a case
minting with a deliberately different period. (Note the sibling test covering a *reached*
cap in `readSessionWindow` is fine; the gap is specific to the slide's clamp.)

**11. (Low, fix while you are in the file.)** `broadcastWithFreshAuth` repeats
`broadcastOps(...)` then `slideSessionWindow()` then return in both the first attempt and
the 401 retry. Item 2(b) is exactly this bug class (a consume site missing its slide),
and fixing it adds more consume sites. Extract a local `attemptOnce(proof)` closure so
"consume without sliding" stops being something a reviewer has to notice.

**12. (Low, fix while you are in the file.)** `edit.js` runs the full re-auth gate before
the no-change detection roughly 190 lines further down, so submitting an unchanged form
costs a password prompt, or for state C a full-page ORCID round-trip, only to be told
nothing changed. Hoist the cheap no-op detection above the gate.

Not held, routed elsewhere: the four-way duplication of `hasPassword` resolution (and the
fact that `settings.js` / `admin.js` fall to ORCID on a failed status where this task
correctly falls to the password prompt) is filed as its own task, because the divergence
is pre-existing and the surfaces are outside this task's scope. Dismissed: splitting
`fresh-auth.js` along a state-versus-orchestration seam, since the reviewer's own verdict
was that no split is needed yet and PEvO has no file-length rule; the seam is recorded
here for whenever the next responsibility lands. Separately, the architect is documenting
`absolute_expires_at` and the window model in `api-contracts/custody.md` and `orcid.md`,
which closes the wire-shape caveat this task opened with.
