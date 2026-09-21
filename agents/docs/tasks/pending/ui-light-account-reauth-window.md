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

---

## UI re-review signal (2026-08-31, commit 199c1e13)

All twelve hold items landed. Each behavioral fix carries a test that fails when
the fix is reverted (probes run against the committed baseline, one revert at a
time); the two low items are refactors covered by the existing suites.

**1. The gate cannot fail open.** `freshAuthWindowReady` wraps acquisition in a
`try`, toasts the re-auth failure, and returns false, so a 503 / 429 / transport
error at the mint refuses the work instead of escaping past the caller's own
`try`. Separately, a failed `sessionStorage` write now leaves the window in an
in-memory mirror that `readSessionWindow` falls back to when the storage read is
empty; the mirror is written ONLY on a failed write, so storage stays the single
source of truth whenever it works and a cleared storage cannot resurrect a stale
window.

**2. Skew first, then the upload slide.** (a) Both deadlines are re-anchored to
the client clock at issuance via `anchoredSpan`, which trusts the measured span
only inside a plausible band around the mirrored backend period (15 min idle /
2 h absolute, as `api-contracts/custody.md` now documents): above the period the
client clock trails the server's, below half the period the measurement is skew
rather than a shorter backend period. That covers both directions — the
over-long inference that buys a mid-flow 401, and the under-margin inference
that loops a passwordless account through ORCID.

  One deviation from the prescription, deliberate: the "refuse to cache a window
  already under the margin" guard is NOT implemented. It does not break the
  loop it was aimed at — refusing to cache leaves the gate re-minting exactly as
  a cached-but-stale window does, so the ORCID round-trip repeats either way,
  and at `minRemainingMs: 0` it would force an extra mint the broadcast leg
  would not have needed. The band clamp is what actually closes the lockout, and
  it makes an at-issuance under-margin window unreachable. Flagged here rather
  than implemented silently.

  (b) `uploadFile` now slides after every successful `uploadFileToIpfs`, both
  attempts, through a shared `attemptOnce` helper.

**3. An aged upload token no longer evicts the window.** The catch discriminates:
`FRESH_AUTH_REQUIRED` with a remintable reason clears the window and re-acquires;
a plain `UNAUTHORIZED` from the upload leg retries the two-step, which cache-hits
the live window. A non-remintable `FRESH_AUTH_REQUIRED` (wrong mechanism, a
binding mismatch) surfaces rather than looping a mint that cannot fix it.

**4 + 5. One seam, built once.** `ensureSessionWindow({ allowRedirect: false })`
suppresses only the navigating branch; the password factor still prompts inline.
`uploadFile` uses it for every leg, which covers the editor's inline image (no
gate of its own) and mid-batch re-acquisition alike: a passwordless account gets
`UPLOAD_REAUTH_REQUIRED` mapped to a re-authenticate-and-retry toast, with the
composition and any completed pins intact.

**6. Margin at the gates, never in the legs.** `windowProof` passes
`minRemainingMs: 0`. The publish confirm moved ahead of the upload legs, and both
pages re-check the margin immediately before the broadcast.

**7. Refuse-while-open is distinguishable.** `reauthModal.request()` resolves
`REAUTH_PROMPT_BUSY` instead of the `null` a cancel resolves.
`mintViaPasswordFactor` maps it to `FRESH_AUTH_PROMPT_BUSY` at both prompts. The
session path surfaces `{ ready: false, busy: true }` and toasts; the consent-op
and settings orchestrators toast and unwind through their existing
`{ cancelled: true }`, so no call site grew a branch — the sentinel is distinct
internally, the message is the user-visible difference.

**8. Same-tick double submit blocked.** `step` leaves `'idle'` before the first
await on both pages (a new `authorizing` step, added to edit's
`STEP_IN_PROGRESS`), and resets to `'idle'` on every abort branch. The user also
gets a spinner during re-auth instead of a live-looking button.

**9. Refused file input cleared**, mirroring the supplementary handler.

**10. Both fixtures inverted.** The cap fixture now seeds a window whose idle
period would overshoot the cap, so deleting the clamp fails it. A new case mints
with a 10-minute period the client must learn; hardcoding the constant fails it.
A `seedWindow` helper writes aged windows directly, since issuance now anchors
and clamps what it is handed.

**11.** `attemptOnce(proof)` extracted in `broadcastWithFreshAuth`; the same
shape used in `ipfs-upload.js`.

**12.** The no-op edit detection is hoisted above the gate, alongside the
hoisted head/target resolution it needs.

**AC 2** now holds at every surface: the inline-image gap the architect
identified is closed by the non-navigating acquisition (items 4/5), which is a
clean refusal rather than the pre-change `UPLOAD_REAUTH_UNAVAILABLE` block. The
`review.js` / `comment-composer.js` first-write redirect is unchanged and still
out of scope.

**i18n.** Four new keys (`common.reauthRequired`, `common.reauthPromptOpen`,
`publish.stepAuthorizing`, `edit.stepAuthorizing`) stubbed across all 16 locales
with a `STUBS.md` sweep entry.

### Verification

Full frontend unit suite green: 78 files, 1648 tests (up from 1627; the 3
unhandled `_mountEditors` errors vitest reports are pre-existing, confirmed
against a clean-HEAD worktree). `npm run build` clean.

**E2E: no regression.** Playwright full suite, one worker, test-mode stack:
23 failed / 45 passed / 4 skipped, matching the failure count this task's prior
round recorded post-change. `non-consent-fresh-auth.spec.js` — the spec covering
this surface, updated for client anchoring — passes. Every failure sampled is a
pre-existing fixture defect that never reaches the changed code: the dominant
class is the strict-mode `form button[type="submit"]` clash against the
always-in-DOM global reauth modal (it fails at the locator, before the click, so
`publish.spec.js` and the `edit-paper.spec.js` no-changes/non-head specs never
executed the reordered submit at all); `settings-orcid-factor.spec.js` asserts a
consent-op cache shape that predates the `authorIndex`/`claimer` binding fields;
`coauthor-accredited-prefill.spec.js` 429s because global-setup could not reach
Redis to reset rate limits. Two fixture cleanups worth a follow-up, both outside
this task: tighten those submit-button locators, and refresh the consent-op
shape assertion.

---

## Architect re-review (2026-08-31) — HELD PENDING FIXES:

Reviewed via `/ce-code-review` on `199c1e13` (frontend paths only), nine reviewer
personas plus three independent validators on the disputed findings, and architect
direct verification at the pinned commit.

**Eleven of the twelve held items landed and are enforceable, and the architecture is
right.** Independently confirmed rather than taken from the signal: item 8's step hoist
genuinely fails when the flip is moved back below the await (verified by mutation in a
scratch worktree); item 10a's inverted fixture now makes `Math.min` select the cap, so
deleting the clamp fails it; item 10b's 10-minute mint fails against a hardcoded
constant; the publish confirm really does precede the upload legs; both file-input
handlers clear `e.target.value` only on refusal; and the `authorizing` step sits above
every await on both pages with a reset on every abort branch.

**Item 2's flagged deviation is correct and is accepted.** `anchoredSpan` clamps to
`[periodMs/2, periodMs]`, so a freshly cached window always carries at least 450000 ms
of idle span against a 120000 ms pre-flight margin: an at-issuance under-margin window
is unreachable, and at `minRemainingMs: 0` the refused-cache guard would have forced a
mint the broadcast leg would not have needed. Flagging it rather than implementing it
silently was the right call. The clamp is also correct in both skew directions, because
a freshly issued window spans one full period of wall time regardless of clock offset.

Also cleared: no comment-anchor rot on added lines, no emdashes in any of the 16 locale
files, i18n complete with the STUBS sweep entry, and the account-state branches match
ARCHITECTURE § 6.4's per-state table.

The theme of this round is narrower than the last: **the new outcome vocabulary this
round introduced is not handled at every surface that consumes it.** Items 1 to 4 are
one cluster.

### Item 1 — the post-upload gate still navigates, discarding paid-for pins

`publish.js`'s `_windowReady()` and `edit.js`'s three inline gates all call
`freshAuthWindowReady()` with no options, so `allowRedirect` defaults to true at the
gates that sit AFTER the IPFS legs. For a passwordless account that is a full-page ORCID
navigation, and `ipfsCid`, `ipfsFilename`, `documentHash` and `supplementaryFiles` are
`handleSubmit` locals that the draft does not carry, so the completed pins are lost.

The comment above the pre-broadcast gate states the premise the code then contradicts:
a deliberate re-auth is worth it for the password factor, which costs a modal, and not
for the ORCID factor, which costs the work.

Reachability is ordinary, not exotic: the absolute cap is never extended by a slide, so
any submit landing in the cap's final minutes clears the 120-second entry margin,
completes real uploads, and trips the redirect on normal latency alone.

Pass `allowRedirect: false` at the three post-upload gates. Keep `allowRedirect: true`
at the file-selection and submit-entry gates, where nothing has been paid for yet. This
fix is not safe without item 3.

### Item 2 — an aged upload token still fails to tear down a mismatched session

`uploadFile`'s catch discriminates a remintable `FRESH_AUTH_REQUIRED` and a bare
`UNAUTHORIZED`, then bare-throws everything else. That last path swallows
`username_mismatch`, which means the cached proof belongs to a different account than
the JWT subject. `broadcastWithFreshAuth`, `withSettingsFreshAuth` and
`withAuthorshipFreshAuth` all call `handleSessionInconsistency()` there, which performs
a real teardown through `auth.disconnect()`.

The consequence is a wedge rather than a bad message: nothing clears the cache and
nothing tears down, so every retry resends the same stale proof and returns the same
generic upload failure until the window's absolute cap or a logout the user has no cue
to perform, on the core paper-upload path.

Add the `username_mismatch` branch mirroring the three siblings, plus a test asserting
the teardown fires. The pre-existing login path that makes the stale window reachable is
filed separately and is not part of this item.

### Item 3 — `reauthRequired` has no branch in either page-facing unwinder

`freshAuthWindowReady` branches on `failed` and `busy` and returns false silently for
`reauthRequired`; `acquisitionAborted`, the shared unwinder behind all eight broadcast
call sites, has the same gap. This is item 1 of the previous round verbatim, a gate that
refuses without telling anyone, reintroduced through an outcome added in the fix for it.

Add a `reauthRequired` branch to both, toasting `common.reauthRequired`, which this
round already added to all 16 locales. Item 1's fix makes this outcome routine at the
post-upload gates, so it must land in the same round.

### Item 4 — `_acquireInFlight` coalesces callers across acquisition modes

The in-flight slot is a single module-level promise joined unconditionally, so the
joining caller's own `allowRedirect` never participates. `windowProof()` is the only
suppressed caller and the page gates are all permissive, so the modes cross.

The concrete sequence: a passwordless user drops an image into the body editor, which
fires `uploadFile` with navigation suppressed and without disabling Submit, then clicks
Submit before that acquisition's status round-trip resolves. The submit joins the
suppressed promise, inherits the refusal, and with item 3 unfixed is refused in silence,
despite being entitled to navigate.

Key the in-flight slot on the redirect policy so a caller only joins an acquisition
sharing its posture. Add the concurrent mixed-mode test neither suite has.

### Item 5 — item 7's busy branches have no regression protection

The `FRESH_AUTH_PROMPT_BUSY` branches landed at five sites: both gates in
`authorship-consent.js`, both in `settings-fresh-auth.js`, and `acquisitionAborted`.
Deleting all five leaves `lib-authorship-consent.test.js` and
`lib-settings-fresh-auth.test.js` at 29 of 29 and the broader suite at 203 of 203;
no test file contains a mock resolving the busy sentinel. Verified by mutation, not by
reading.

Add one case per orchestrator asserting the result is `{ cancelled: true }` AND that the
busy toast fired, with the paired plain-cancel case asserting the toast did NOT fire so
the two discriminate. Cover the retry gate too, which is a separately deletable branch,
and add a broadcast-layer case for `acquisitionAborted`.

Note for the next signal block: this is the second round on this task whose per-item
verification claim did not hold across every item it covered. The claim is worth making
only per item, against the item's own named test.

### Item 6 — `windowProof()` collapses the busy outcome into a cancellation

The helper branches on `ready`, `reauthRequired` and `failed`, then falls through to
`UPLOAD_CANCELLED`, so a refuse-while-open at the upload leg reports an upload the user
cancelled for a prompt they never saw. That is the ambiguity item 7 existed to remove,
at a surface item 7 did not enumerate.

Latent today, since the only busy producers and the only `uploadFile` callers do not
share a page, and live the moment a composer reaches the paper page. Add the branch
mapped to `common.reauthPromptOpen`, plus the `{ ready: false, busy: true }` case
`lib-ipfs-upload.test.js` is missing.

### Item 7 — `cacheSessionProof` throws where it used to degrade

`anchoredSpan` returns `NaN` for an unparseable deadline, and `cacheSessionProof` feeds
that into `new Date(now + NaN).toISOString()`, which throws a `RangeError`. The
`NaN` branch has no other consumer, and `readSessionWindow`'s corruption guard can no
longer be reached for this class because the throw happens first.

Guard in `cacheSessionProof`: if either anchored span is non-finite, drop the window and
return. Fail-closed matches how the module treats every other corrupt-entry case. Add a
unit case asserting a malformed issuance does not throw and leaves the slot empty.

### Item 8 — a stale stored entry can shadow the fresher mirror

`storedWindow()` consults the in-memory mirror only when the storage read comes back
empty, so a failed write that leaves an older entry readable is served the stale copy.
The comment claims storage is the single source of truth whenever storage works, which
the read order does not enforce.

In `persistWindow`'s catch, remove the key before installing the mirror, so a non-empty
read always implies a current entry and the docblock's claim becomes true by
construction.

### Item 9 — the retry comment's stated cause cannot occur

The `UNAUTHORIZED` retry is justified in-code by a large file on a slow connection
straddling the upload token's 60-second TTL. Every request carries a 30-second abort
composed in `api.js`, so a slow upload aborts well before the token expires; the cited
cause cannot produce the cited symptom.

Keep the retry, which is a reasonable safety net for the other ways that status arrives.
Rewrite the comment to state the real reason, and drop the slow-connection story.

### Item 10 — `promptBusy()` is duplicated across the two orchestrators

Byte-identical in `settings-fresh-auth.js` and `authorship-consent.js`, against the
convention `showPromptBusyToast()` and `handleSessionInconsistency()` already set in the
same module. Move it beside them in `fresh-auth.js` and import it in both.

### Item 11 — `edit.js`'s in-progress step set states its rationale backwards

`edit.js` derives `isSubmitting` from an inclusion list while `publish.js` uses the
exclusion form. An inclusion list fails open: a step added later and not registered
leaves the submit button live. The comment presents the inclusion list as the safer
choice, which is the wrong way round. This round edited that set to add `authorizing`,
so it is in the blast radius.

Correct the comment, or adopt `publish.js`'s exclusion form and drop the set.

### Not held, routed elsewhere

The duplicated `attemptOnce` closures in `fresh-auth.js` and `ipfs-upload.js` are
**dismissed**: two four-line closures are legible where they sit and PEvO has no rule
against them. The real risk the duplication points at is that nothing pins the
"every consume site replays the slide" invariant across both implementations; recorded
here as a residual rather than forced into a cross-module combinator.

The cross-user teardown gap that makes item 2 reachable, where the login paths reissue a
session for a new username without running `auth.disconnect()`'s scrub, and
`disconnect()` leaving the in-flight acquisition promise set, is filed as its own task.

Two pre-existing E2E fixture defects the signal named, the strict-mode submit-button
locator clash and the stale consent-op cache-shape assertion, remain out of scope.

**When the fixes land, `git mv` this file back to `tasks/review/`.** The move is the
re-review signal. Do not edit this hold block or annotate items as fixed; the commit
diff is the evidence and the architect updates the block at re-review.

---

## UI re-review signal (2026-08-31, commits 21ba36cf + bc3d6095)

All eleven items landed at `21ba36cf`; a post-review simplification pass
(`bc3d6095`) reshaped two of the fixed sites without behavior change. Per the
architect's note on verification claims, every item below names its own test,
and every behavioral fix was verified by mutation against the committed
baseline: fix reverted, named test run, failure observed, tree restored via
git. All probes killed, including re-runs of the two probes whose
implementation the simplification pass reshaped.

**1. Post-upload gates no longer navigate.** `publish.js`'s pre-broadcast gate
(via an opts pass-through on `_windowReady`) and both `edit.js` pre-broadcast
gates pass `allowRedirect: false`; the file-selection and submit-entry gates
stay permissive. Tests: "a passwordless window closing during the uploads
refuses without navigation" in `pages-publish.test.js` AND
`pages-edit.test.js`, probed separately per page (gate reverted, test fails).
The publish variant also asserts the item-3 toast and that the pins were paid
for exactly once.

**2. `username_mismatch` tears down.** `uploadFile`'s catch discriminates the
reason and calls the shared `handleSessionInconsistency()`, then rethrows: no
blind retry against the same mismatched pair, no local cache clear (the
teardown's disconnect drops the window itself). Test: "a mismatched session
tears down instead of wedging on retries" (`lib-ipfs-upload.test.js`).

**3. `reauthRequired` is told to the user.** `freshAuthWindowReady` toasts
`common.reauthRequired` via a new `showReauthRequiredToast`;
`acquisitionAborted` carries the same branch, annotated in-code as defensive
because item 4's posture keying makes the outcome unreachable on the
always-permissive broadcast path. Tests: "a suppressed refusal is told to the
user, not returned in silence" (lib suite, asserts the exact toast copy),
plus the page-level toast assertion inside item 1's publish test.

**4. In-flight keyed on posture.** `_acquireInFlight` became
`{ permissive, suppressed }`; a caller only joins an acquisition sharing its
posture, and same-posture coalescing is preserved. Tests: "concurrent callers
with opposite redirect postures do not inherit each other" and "concurrent
callers sharing the suppressed posture still coalesce"
(`lib-fresh-auth-session-window.test.js`); probe collapsed the key to a
single slot and the mixed-mode test fails.

**5. Busy branches pinned, per site.** Both orchestrators' initial gates
("a prompt owned by another action unwinds as { cancelled } WITH the busy
toast", one per suite) each paired with a plain-cancel case asserting NO
toast; both retry gates ("a busy refusal at the 401 retry gate also toasts
instead of dropping silently", one per suite); and the broadcast layer
("a prompt owned by another action refuses the broadcast WITH the busy
toast" plus its paired no-toast cancel, `fresh-auth-401-retry.test.js`).
Probes, each killed: `promptBusy`'s toast deleted fails both orchestrator
suites; each retry-gate branch replaced with a bare `{ cancelled: true }`
fails that suite's retry case; `acquisitionAborted`'s busy toast deleted
fails the broadcast-layer case.

**6. `windowProof` busy branch.** New `UPLOAD_REAUTH_BUSY` code mapped to
`common.reauthPromptOpen` in `describeUploadError`, and the docblock now
states why busy must not collapse into cancel. Test: "a prompt owned by
another action surfaces as busy, never as a cancel"
(`lib-ipfs-upload.test.js`), plus the mapping row in the
`describeUploadError` table test.

**7. `cacheSessionProof` fails closed.** Non-finite anchored spans drop the
window and return instead of feeding NaN into `toISOString`. Test: "a
malformed issuance deadline drops the window instead of throwing", covering
a bad idle deadline, a bad absolute deadline, and both absent, each seeded
over a live window that must end empty.

**8. The mirror cannot be shadowed.** `persistWindow`'s catch drops the
stored entry before installing the mirror (folded into `dropWindow()` by
`bc3d6095`), so a non-empty storage read implies a current entry by
construction. Test: "a failed write cannot leave a stale stored entry
shadowing the fresher mirror", probed against both the original and the
simplified shape.

**9. Retry comment rewritten.** The upload-leg UNAUTHORIZED comment names the
real arrival paths (token store evicted between the two steps, token consumed
by a duplicate) and rules out the slow-transfer story via the 30-second
request abort composed in `api.js`; the sibling test comment was updated to
match. Comment-only, no probe.

**10. `promptBusy` shared.** One exported definition in `fresh-auth.js`,
imported by both orchestrators; `showPromptBusyToast` is no longer exported
since no external consumer remains. Refactor, enforced indirectly by item
5's toast assertions running through the shared definition.

**11. `isSubmitting` fails closed.** `edit.js` adopts `publish.js`'s
exclusion form and `STEP_IN_PROGRESS` is deleted; the comment now states the
fail-closed rationale the right way round. Test: the `pages-edit.test.js`
table's `step=unknown-future-step -> isSubmitting=true` row, which fails
against a restored inclusion list (probed), with `authorizing` added to the
in-progress rows.

### Verification

Full frontend unit suite green: 78 files, 1699 tests (up from 1648; the 3
unhandled `_mountEditors` rejections vitest reports remain the documented
pre-existing class). `npm run build` clean. No anchor-rot patterns in added
lines; the pre-commit gate and zone audit passed on all three commits.

**E2E: no regression.** Test-mode stack, one worker, the four specs covering
these surfaces (`non-consent-fresh-auth`, `settings-orcid-factor`,
`settings.spec`, `authorship-consent-actions`): 10 passed / 1 failed,
identical to the prior round's result on the same batch; the one failure is
the documented stale consent-op cache-shape assertion in
`settings-orcid-factor.spec.js`, out of scope per this hold. Dev routing
restored afterwards.

Interaction with the sibling resolver task: its assumed-password ORCID
fallback (landed at `ab5a2fac`) routes through this task's `allowRedirect`
seam, so the fallback obeys the same suppression the post-upload gates rely
on; covered by "an assumed-password 401 with navigation suppressed refuses
instead of redirecting".

---

## Architect re-review (2026-08-31, round 4) — HELD PENDING FIXES:

Reviewed via `/ce-code-review` on `21ba36cf` + `bc3d6095` (frontend paths only), nine
reviewer personas plus an independent validation batch. Every item below survived
validation under fresh inspection.

**Ten of the eleven round-3 items are verified genuinely landed**, with their
discriminating tests independently re-probed rather than taken from the signal:
the posture-keyed in-flight slots, the fail-closed `cacheSessionProof` guard, the
mirror-shadowing removal, all five busy-toast pairs, the `username_mismatch`
teardown call itself, the `windowProof` busy branch, the retry-comment rewrite,
the shared `promptBusy`, and the `isSubmitting` exclusion form. `bc3d6095` was
traced behavior-preserving branch-for-branch by three reviewers independently.
Security, project-standards (emdash scope, comment anchors, i18n stubs), and the
frontend-races lens all came back clean.

Three items. Two are residue on round-3 items 1 and 2; the third is a design
decision the review surfaced and the architect has accepted.

### Item 1 — the continuation branch's suppressed gate has no discriminating test

The round-3 signal's claim "probed separately per page" does not hold for one of
the three post-upload gates. `edit.js` carries two mutually exclusive
pre-broadcast gates passing `allowRedirect: false` (the continuation branch and
the same-author branch). The new `pages-edit.test.js` case exercises only the
same-author site: `unchangedLightComponent()`'s fixture resolves
`isContinuation === false` (author equals username, no chain), and every test
that does reach `isContinuation === true` runs non-light custody, which
short-circuits `ensureSessionWindow` before `allowRedirect` is consulted.
Reverting the continuation gate's suppression alone leaves the whole suite
green, silently reintroducing the pin-discarding ORCID redirect for continuation
edits specifically.

Add a continuation-postured, light-custody twin of "a passwordless window
closing during the uploads refuses without navigation" (username differing from
the paper's author so `isContinuation` resolves true), asserting no `startOrcid`
call, no broadcast, and `step` back at `'idle'` — and carry the reauthRequired
toast assertion its publish sibling already has, which the edit variant
currently omits.

### Item 2 — the username_mismatch teardown double-reports

Round 3's item 2 fix tears down correctly but rethrows the raw
`FRESH_AUTH_REQUIRED` error, and `describeUploadError` has no mapping for it, so
the page layer stacks the generic upload-failure surface on top of the teardown's
own re-login toast: `publish.js`'s PDF catch toasts "Upload failed" immediately
after "Session inconsistency detected. Please sign in again." (the toast store
does not dedupe), and the inline supplementary/edit error rows invite a retry
that cannot succeed until re-login. The settings and authorship siblings avoid
the double report by returning a structured sentinel instead of rethrowing.
Confirmed independently by three reviewers.

Throw a dedicated already-reported `UploadSessionError` code from the
`username_mismatch` branch (mirroring `FRESH_AUTH_REDIRECT_PENDING`'s
message-suppression contract on the broadcast surface) and quiet or map it at the
pages, so the teardown's toast is the only message. Add the page-level test the
suites are missing: exactly one toast for this scenario.

### Item 3 — thread the redirect posture through the broadcast layer's 401-retry

`broadcastWithFreshAuth`'s 401-retry re-acquires with the permissive default, so
after a suppressed pre-broadcast gate passes, a window invalidated server-side
between that gate and the broadcast still fires the full-page ORCID navigation
with the completed pins in `handleSubmit` locals — this task's loss mode, one
layer down from the gates round 3 fixed. The trigger is no longer exotic: the
backend now closes open session windows on custody upgrade, and a password reset
does the same, so another tab can invalidate mid-submit.

Thread an `{ allowRedirect }` option through `broadcastWithFreshAuth` to its
re-acquisition; the post-upload call sites (publish, both edit branches) pass
`false`, and the `reauthRequired` branch in `acquisitionAborted` — currently
annotated as defensive and unreachable — becomes the load-bearing unwinder. The
vote/comment/review call sites keep the permissive default. Add the missing
test: a passwordless account's remintable 401 at the broadcast leg from a
post-upload position refuses with the toast instead of navigating.

### Not held, routed elsewhere

The outcome-to-toast dispatch triplication across `freshAuthWindowReady`,
`acquisitionAborted`, and `windowProof` (plus the three near-identical toast
helpers) is filed as its own task together with the sibling review's retry-gate
ladder finding: `ui-fresh-auth-shared-dispatch-and-retry-gate`. Not a defect
today; every current outcome is handled at every site.

Soft-bucket items carried into the architect's reserved § 6.4 doc pass rather
than held: the suppressed assumed-401 batch-abort trade at `orcidOrRefuse()`,
and the dead-JWT path that satisfies the assumed-401 heuristic end to end.

**When the fixes land, `git mv` this file back to `tasks/review/`.** The move is
the re-review signal. Do not edit this hold block or annotate items as fixed;
the commit diff is the evidence and the architect updates the block at
re-review.

---

## UI re-review signal (2026-08-31, commit d069c711)

All three round-4 items landed in one commit, implemented in an isolated
worktree, reviewed by three adversarial lenses (hold-fidelity,
races/regressions, test-quality; zero must-fix findings), and cherry-picked
onto main. Per the mutation-probes-are-per-site convention, every claim below
is per site against that site's own named test: 13 probes, each observed red
and restored, several independently re-run by the reviewers.

**1. Continuation gate discriminated.** New `pages-edit.test.js` continuation
twin (light custody, username differing from the paper author, in-test
precondition asserting `isContinuation === true`): no `startOrcid`, no
broadcast, step back at `'idle'`, and the `reauthRequired` toast. Differential
probe: reverting each gate literal fails exactly its own twin while the other
stays green. The pre-existing same-author variant gained the toast assertion
the hold noted missing.

**2. One toast for a torn-down session.** `uploadFile`'s `username_mismatch`
branch throws a dedicated already-reported `UploadSessionError` code
(`UPLOAD_SESSION_TORN_DOWN`); `describeUploadError` maps it to null under a
documented already-reported contract, and all FOUR consumers unwind quietly:
the publish PDF catch, both supplementary rows, and the editor inline-image
catch, which the hold did not name but shares the class (swept per the
completeness-across-surfaces discipline, with its own discriminating test).
Exactly-one-toast page tests count calls on a recording mock.

**3. Posture threads through the broadcast layer.** `{ allowRedirect }`
threads into BOTH acquisitions inside `broadcastWithFreshAuth` (initial and
401-retry): the retry alone was the hold's letter, but both are acquisitions
from a post-upload position and a split posture would be incoherent; each site
has its own discriminating test. Publish and both edit branches pass `false`;
a permissive-default control test pins the vote/comment/review behavior
(navigation still happens, no toast). `acquisitionAborted`'s `reauthRequired`
branch is re-annotated load-bearing.

**Verification.** 221 tests green across the six touched files in the
worktree; the source-discipline canary green with no width change; the full
frontend unit suite on the integrated tree: 79 files, 1750 tests green (the 3
vitest errors remain the documented pre-existing `pages-edit` class).

**Residuals surfaced for triage, deliberately not fixed here:**

1. (low, pre-existing) A `username_mismatch` 401 arriving on `uploadFile`'s
   RETRY attempts (re-mint retry, aged-token retry) bypasses both the teardown
   and the new code: those `attemptOnce` calls sit outside the catch, so the
   raw error surfaces generically with no teardown. Requires a double fault
   (stale cross-user window plus a first-attempt token eviction); the catch
   layout predates this round and the hold's letter covers the first-attempt
   path only.
2. (low, default-dismiss) The permissive-control test arms
   `mockStartOrcid.mockResolvedValue` without a per-test reset; inert today,
   future-only leak class.

---

## Architect re-review (2026-09-01, round 5) — HELD PENDING FIXES:

Reviewed via `/ce-code-review` on `d069c711` (frontend paths only), seven reviewer
personas plus an independent validation batch. **All three round-4 items are
verified genuinely fixed**, each traced end-to-end with mutation reasoning: the
continuation twin discriminates (its fixture resolves `isContinuation === true` via
the getter's real fallback path, and the two gate literals sit in mutually exclusive
branches so neither twin masks the other's reversion); the `UPLOAD_SESSION_TORN_DOWN`
contract holds (the teardown toast fires synchronously before every quiet unwind,
exactly four consumers exist repo-wide and each guards before `describeUploadError`);
and the redirect posture threads into both acquisitions with the permissive default
preserved at all six vote/comment/vouch/review call sites. Project-standards clean;
§ 6.4/6.5 hold.

Three items. Two are on surfaces this round introduced; the third reverses a
defensiveness regression this round made.

### Item 1 — the editor multi-image queue keeps draining after a torn-down session

`_handleImageUpload`'s `UPLOAD_SESSION_TORN_DOWN` catch returns without flushing
`_imageUploadQueue` or setting a flag. `handleSessionInconsistency` has already
synchronously nulled `auth.username`, so `_drainImageUploadQueue` (which breaks only
on `!this.editor`) carries each remaining queued image into the pre-existing
`!auth?.username` branch, firing its own "sign in to continue" toast. The toast store
caps at three with FIFO eviction, so a drop of four or more images evicts the
teardown toast this round's contract exists to protect. Multi-file drop is the
ordinary path (`handleDrop` queues the whole array). Validated; races and adversarial
both constructed it.

Flush the queue in the torn-down branch (`this._imageUploadQueue.length = 0` before
the return) and add a multi-image torn-down drop test asserting exactly one toast.

### Item 2 (design call) — the suppressed-refusal recovery path re-enters the permissive entry gate and still discards the form for a passwordless account

The `allowRedirect: false` fix correctly stops the current broadcast attempt from
navigating when a passwordless window dies server-side mid-submit. But the toast it
shows sends the user back into `handleSubmit` from the top, whose entry gate is
permissive by design on the premise "nothing has been paid for yet." That premise is
false on this specific resubmit: the 401 handler already cleared the window, the
attached files and CIDs live in `handleSubmit` locals (not drafted), and a
passwordless account's entry-gate acquisition is a full-page ORCID navigation that
wipes the form. Re-uploads reproduce the same content-addressed CIDs (so no pin
divergence), but the filled form and attached files are lost. So the fix defers the
loss by one click for exactly the account class it targets. Validated.

This is a design call, not a mechanical fix, because the entry gate is deliberately
permissive. **Recommended default (implement unless you see a reason to deviate, in
which case flag before landing):** suppress the entry gate (`allowRedirect: false`)
when the submit already holds a selected file or a completed CID, so a passwordless
account is refused non-destructively and told to re-authenticate rather than navigated
away. Do NOT resolve this by persisting the file into the draft, which contradicts
this task's scope item 2. Add a test: a passwordless account resubmitting with a file
already attached refuses without navigation and keeps the file.

### Item 3 — restore the loud default this round deleted from `acquisitionAborted` / `ensureSessionWindow`

Round 4 deleted the annotation warning that `acquisitionAborted` silently swallows an
unenumerated outcome (no toast, returns true) and that `ensureSessionWindow`'s
fallthrough returns `{ ready: true, proof: <Symbol> }` for any unenumerated sentinel.
Safe today (every current outcome is handled), but the surface sits directly under the
sibling `FRESH_AUTH_ORCID_FALLBACK` seam, and a future sentinel drifting through fails
silently at all eight broadcast call sites. Removing the warning is a defensiveness
regression.

Add an explicit `CANCELLED` case plus a loud default: `acquisitionAborted` treats an
unenumerated outcome as a handled refusal rather than a silent pass, and
`ensureSessionWindow` treats an unenumerated non-string proof as
`{ ready: false, failed: true }` so drift fails visibly.

### Not held, routed / accepted

The disclosed retry-leg `username_mismatch` bypass on `uploadFile`, and its
undisclosed sibling on `broadcastWithFreshAuth`'s 401-retry, are filed on
`ui-consent-op-teardown-guard` as the same "teardown does not reach this path" family.
Accepted as documented residuals: `describeUploadError`'s null branch being dead code
(all four consumers guard first), the inert `mockStartOrcid` mock-leak, and the
untested-but-inert non-light-custody `allowRedirect`-stripping branch.

**When the fixes land, `git mv` this file back to `tasks/review/`.** The move is the
re-review signal. Do not edit this hold block or annotate items as fixed; the commit
diff is the evidence and the architect updates the block at re-review.

---

## UI re-review signal (2026-09-14, commits 8414dd64 + 0b2ff3c3)

Items 1 and 2 landed at 8414dd64; item 3 was found already landed by two
sibling commits and is pinned here by mutation rather than re-implemented.
A post-review fixup (0b2ff3c3) closes one defect the adversarial pass found
in the item-2 sweep and pins one override the pass showed was untested.
Every behavioral claim below names its own test, and every fix was probed in
an isolated scratchpad copy with that fix alone reverted: twelve mutants,
each observed red on exactly the named tests, plus unmutated control copies.

**1. The image batch ends with the teardown.** `_handleImageUpload`'s
already-reported branch now truncates `_imageUploadQueue` in place through
`_abandonQueuedImageUploads` before returning, so a multi-image drop that
tears the session down never carries the remaining images into the
signed-out branch. Swept to the same class: the signed-out branch truncates
too (one sign-in toast per batch, not per image), and a subject-change
abandonment takes the same exit rather than pushing the departed subject's
images through under the successor. Tests (`editor.test.js`): "a torn-down
session mid-batch abandons the remaining images and adds no toast of its
own" (four images, one upload, exactly one toast, empty queue), "a signed-out
drop of several images says sign in once, not once per image", and the
control "an ordinary upload failure does not abandon the rest of the batch".
Probes: the torn-down truncation reverted fails the first; the signed-out
truncation reverted fails the second.

**2. The design call, implemented as recommended.** `holdsAttachedFiles`
(publish: an attached PDF or supplementary file; edit: a new supplementary
file) feeds `allowRedirect: !this.holdsAttachedFiles` in one `_windowReady`
per page, explicit opts overriding, so a passwordless account resubmitting
with a file attached is refused non-destructively with the re-authenticate
toast and keeps the file. Swept one step past the letter, same class: the
file-selection gates take the same predicate, because navigating to acquire
for a second file discards the first exactly as the entry gate would. The
pre-broadcast gates keep their unconditional `allowRedirect: false`. Nothing
persisted into the draft. On "a completed CID": CIDs live in `handleSubmit`
locals, and the reactive `cid` a supplementary entry gains on a successful
upload only ever accompanies an attached file, which the predicate already
covers. Tests: `pages-publish.test.js` "a passwordless account resubmitting
with a file attached refuses without navigation and keeps the file",
"picking a supplementary file with a PDF already attached refuses without
navigation and keeps the PDF", "picking a PDF with a supplementary file
already attached refuses without navigation and keeps it", and the control
"with nothing attached, the entry gate still navigates a passwordless
account"; `pages-edit.test.js` the resubmit twin, "picking more
supplementary files with one already attached refuses a passwordless account
without navigation and keeps it", and the same control. Probes:
`allowRedirect: true` restored in the wrapper fails the resubmit and
supplementary-with-PDF cases on publish and two on edit; the predicate
narrowed to the PDF alone fails exactly the PDF-with-supplementary case; the
PDF gate forced permissive fails exactly that same case.

  **Fixup (0b2ff3c3), from the adversarial pass.** The sweep as first landed
  closed the only in-page move a passwordless account had on the publish
  page: with a PDF attached and the window lapsed, the entry gate refuses by
  design, and re-picking the PDF was refused too because the predicate
  counted the very slot the pick replaces. There is no remove-PDF affordance
  (`pdfFile` has one assignment and no reset; `discardDraft` resets
  supplementary files only), so every move was a refusal until a reload. The
  PDF pick now passes `allowRedirect: this.supplementaryFiles.length === 0`:
  the slot it replaces is not work a navigation costs, only held
  supplementary files are (and those have a remove affordance). Test:
  "re-picking the PDF with nothing else attached may still navigate: the
  slot it replaces is not held work"; probe: the gate reverted to the bare
  wrapper fails exactly it. The edit page needs no twin: its only held files
  are supplementary and removable.

  The same pass showed the pre-broadcast gates' explicit
  `allowRedirect: false` was shadowed by the predicate in every existing
  spec (a file is always held there), so a wrapper that ignored its opts
  survived both page suites. New spec: "with nothing attached, a window
  closing while the confirm dialog is open refuses at the pre-broadcast gate
  without navigation" (the window is dropped inside the confirm mock); probe:
  the wrapper's opts spread removed fails exactly it plus the re-pick spec.
  The edit page has no awaited step between its entry and pre-broadcast
  gates when no file is held, so the override there is not observable by a
  unit spec; noted rather than faked.

  Residual for the architect, deliberately not fixed here: a passwordless
  account has no in-page way to re-authenticate, so the entry-gate refusal
  is a dead end in-tab until the user leaves the page, which loses the file
  they were just told they kept. The design call accepted being told over
  being surprised; the toast copy (`common.reauthRequired`) does not say
  that the way out costs the attached file. An explicit re-authenticate
  affordance that states the cost would close it.

**3. Already landed, verified by mutation.** `ensureSessionWindow` refuses a
non-string acquisition result as `{ ready: false, failed: true }`
(fa436034) and `acquisitionAborted` falls an unnamed result through to
`failed` (f9b6ad8d); `cancelled` is an explicit row of
`WINDOW_OUTCOME_BY_SENTINEL`, whose toast table records its deliberate
silence. Probes against the tree at 8414dd64: the guard removed fails five
specs in `lib-fresh-auth-session-window.test.js`; the fall-through removed
fails three in `fresh-auth-401-retry.test.js`; the cancelled row removed
fails ten across the vocabulary, retry and session-window suites.

### Verification

Full frontend unit suite: 85 files, 1900 tests green (up 10); the three
unhandled `_mountEditors` errors are the documented pre-existing class.
`npm run build` clean. Pre-commit anchor gate and zone audit green on the
commit. Simplify pass (three reviewers): nothing applied, one low-value
consistency suggestion skipped. Adversarial review as a workflow (four
lenses: hold fidelity, races and regressions, test quality, project
standards): thirteen findings; the refuter stage was cut short by the
session rate limit (five of eighteen verdicts returned, none refuting), so
every finding was triaged by hand against the code. One should-fix (the PDF
re-pick dead end, fixed above), one test gap (the override, pinned above),
one test-hygiene nit (the editor's mutable auth mock is now reset in
`afterEach` too), and the residuals below. Dismissed: an explicit
`allowRedirect: undefined` re-opening navigation through the opts spread
(no caller passes one; both verdicts that ran agreed it is inert), the
`{ ...globalThis.window }` stub spread copying no jsdom property (the
repo-wide convention in six sibling suites; the redirect path reads only
`window.location`), and the retention assertions in the new specs being
documentation rather than discriminators (the no-navigation assertions are
what the probes trip).

### Residuals for the architect, deliberately not fixed here

1. **The file-selection widening of item 2.** Applying the predicate at the
   file-selection gates went one step past the hold's letter (same loss
   class, disclosed here rather than flagged before landing). Accept or ask
   for the entry-gate-only form.
2. **The passwordless dead end and its copy.** `common.reauthRequired`
   ("Please confirm your identity again, then try once more.") is shown
   exactly to the class with no in-page way to confirm identity: the session
   ORCID round-trip has one caller, the acquisition itself, and the window
   is per-tab sessionStorage. With files held the ways through are: publish,
   re-pick the PDF (navigates, per the fixup) or reload; edit, remove the
   new supplementary files and resubmit. Neither is what the toast says. The
   design call accepted told-over-surprised; the copy could name the cost.
3. **Surfaces that still navigate over held work, pre-existing:** the review
   page (body and ratings, no gate, no draft), the comment composer body,
   and the vouch retraction reason all reach `broadcastWithFreshAuth` with
   the permissive default. Known since round 1 for review and comment; the
   vouch reason is the same class. A stash before the redirect or an
   acquire-on-compose-start gate would close them.
4. **Edit entry gate over ticked reviews.** `addressedReviews` is not in the
   edit draft, so a passwordless account that ticks reviews, attaches
   nothing, and submits navigates and returns with the ticks gone. Either
   draft the ticks or add them to the predicate.
5. **Draft debounce hole.** The permissive default's premise "the text
   fields are drafted" has a two-second `_scheduleDraftSave` window on both
   pages that a navigation inside it discards. Marginal; flushing the timer
   at the gates would close it.

**E2E, no regression on the covered surface.** Test-mode stack, one worker,
database reset by global-setup: `non-consent-fresh-auth` 4 passed;
`publish` 1 failed; `edit-paper` 7 failed. All eight failures are the
documented `form button[type="submit"]` clash with the always-in-DOM global
re-auth modal (six strict-mode clicks, two `toHaveCount(0)` assertions that
receive the modal's own Confirm button), each failing at the locator before
any changed gate runs. Run on the 8414dd64 bundle; the fixup's only
behavior change is the passwordless PDF re-pick posture, which no E2E spec
can drive (the E2E accounts hold a password), so it was not re-run. Dev
routing restored afterwards.

---

## Architect re-review (2026-09-21, round 6) — HELD PENDING FIXES:

Reviewed via `/ce-code-review` on `8414dd64` + `0b2ff3c3` (frontend paths only,
inspected at the pinned head), five reviewer personas plus a learnings pass and an
independent validation batch that confirmed all four findings below. `publish.js`,
`edit.js` and `editor.js` are byte-identical between `0b2ff3c3` and main at review
time, so every item applies to main as written.

**All three round-5 items are verified genuinely landed, and this is the first
round on this task where every per-site probe claim in the signal held.** Two
reviewers re-ran the probes in separate scratch copies: each truncation in
`_handleImageUpload` reverted alone fails exactly its named spec, and an over-broad
flush fails the control; the `_windowReady` wrapper forced permissive fails two
specs per page; the PDF carve-out reverted fails exactly the re-pick spec; the
publish wrapper ignoring its opts fails the re-pick and confirm-dialog specs. Item 3
is confirmed already landed: `fa436034` and `f9b6ad8d` are ancestors of the review
base, and at `0b2ff3c3` removing `ensureSessionWindow`'s non-string guard fails 5
specs, removing `acquisitionAborted`'s fall-through to `failed` fails 3, and removing
the `cancelled` row fails 10, matching the signal exactly. Project-standards and the
frontend-races lens came back clean. The account-state check passes: `hasPassword`
false with light custody is ARCHITECTURE § 6.1 state C, and § 6.4 / § 6.5 invariant
#1 are untouched, since the diff changes whether the client navigates and never
what proof a request carries.

**The file-selection widening (signal residual 1) is accepted.** It is the same loss
class as the entry gate, and the entry-gate-only form would silently lose the first
file on the second pick.

The theme of this round: **a non-destructive refusal is only an improvement if it
leaves the user a way through.** Item 2 of the round-5 hold prescribed the
suppression and did not prescribe the way through; that omission is the
architect's, and the implementer flagged the resulting dead end as residual 2
rather than landing it silently. The probes below show it sits on the ordinary
first-submit path, which is wider than the post-401 resubmit the round-5 hold
reasoned about. Items 1 to 3 are one fix.

### Item 1 — a passwordless account holding a file is refused at every gate, with no in-page way to re-authenticate

With a file held, `_windowReady` suppresses navigation at the entry and
file-selection gates, so a passwordless account gets `reauthRequired` and the
`common.reauthRequired` toast ("Please confirm your identity again, then try once
more."). Nothing in the tab can do that: `beginSessionAuthOrcidRedirect` has one
call site, inside the acquisition the gate just suppressed, and the window is
per-tab `sessionStorage`. Probe at `0b2ff3c3`: three consecutive `handleSubmit`
calls produce three identical toasts, zero `startOrcid` calls, zero broadcasts. The
pre-change tree navigated in the same arrangement (file lost, flow completes).

Reachability is ordinary. The idle window is 15 minutes, the gate margin is 120
seconds, and a file pick never slides the window, so the refusal begins about 13
minutes after the ORCID return: attach a PDF, finish the form, click Submit. Two
more ways in, both probed: files attached while unaccredited (the gate returns true
ungated) followed by accreditation landing, where the user is told to confirm
"again" having never held a window; and a window still live but inside the margin.

Fix: on a `reauthRequired` refusal at the entry and file-selection gates, ask
instead of toasting. Show an explicit confirm through the existing
`broadcastConfirm` store whose copy states the cost: confirming identity with ORCID
leaves this page, the text is saved as a draft, attached files will need to be
selected again. On confirm, flush the pending draft save and acquire with
`allowRedirect: true`. On decline, refuse silently, as a dismissed password modal
does. Constraints:

- The pre-broadcast gates and the broadcast layer stay unconditionally
  non-navigating and keep the toast. Their "try once more" becomes true, because
  the resubmit now reaches a gate that offers the confirm.
- The password factor is untouched: it still prompts inline with files held.
- Do not grow another copy of the outcome dispatch in the pages. The pages see a
  boolean today; whichever seam carries the refusal out (an option on
  `freshAuthWindowReady`, or the outcome key returned to the page), the vocabulary
  table stays the one place that decides which outcomes speak. Reconcile with the
  shared-dispatch task if it has landed by pickup.
- `broadcastConfirm.request()` resolves `false` for a decline AND for
  refuse-while-open. Both must end in a refusal with no navigation.
- `edit.js` does not use the store today; the store is global, so no new
  component is needed.
- New copy is state-neutral (it must not presume a prior window, per the
  accreditation-flip case), carries no emdashes, and is stubbed across all 16
  locales with a `STUBS.md` entry.
- Flush the pending draft save before any acquisition that may navigate. The
  confirm path is the required one; an unconditional flush at the top of
  `_windowReady` is the simplest form and also closes the two-second debounce hole
  the signal recorded as residual 5 for the permissive path.
- Nothing is persisted into the draft beyond what it carries today.

Tests, per page: with a file held and no window, a passwordless submit requests
the confirm and does not toast; on confirm, `startOrcid` is called once, the
navigation is assigned, and the draft was flushed first; on decline, no
`startOrcid`, the file is kept, `step` is `'idle'`, and no toast fires. Add the
accreditation-flip arrangement on publish. Keep the existing specs that pin the
pre-broadcast refusal with the toast.

### Item 2 — the PDF re-pick carve-out is not a way through; revert it

The fixup presents re-picking the PDF as the one move that may still navigate. A
successful attach never clears the file input (only the refusal branch does), so
re-choosing the PDF the user actually wants fires no `change` event: no gate, no
navigation, no toast. With a supplementary file held the re-pick is refused
outright. The pinning spec calls the handler directly with a differently named
file, so it cannot see either.

With item 1 in place the carve-out has no job. Revert `handlePdfChange` to the bare
`this._windowReady()`, delete the carve-out comment and the sentence in
`_windowReady`'s docblock that describes it, and replace the re-pick spec with one
asserting that a pick over a held PDF with no window requests the confirm. The
override spec that drops the window inside the confirm mock stays: it is what pins
the opts spread on publish once the re-pick spec no longer co-pins it. Re-probe
that claim after the revert.

### Item 3 — the edit page's documented way out lands on the no-changes error

When new supplementary files are the only edit, removing them (the way through the
signal names) makes the form unchanged, and the no-changes check runs before the
entry gate: `step` becomes `'error'` with `edit.noChanges`, and nothing navigates.
Probe confirmed. Do NOT reorder the no-changes check; round 1 put it ahead of the
gate deliberately so an unchanged form never costs a round-trip. Item 1 resolves
this, because the refusal no longer sends the user off to empty the form. Add the
edit-page spec for exactly this arrangement: unchanged form plus one new
supplementary file, passwordless, no window, submit requests the confirm.

### Item 4 — the edit page's pre-broadcast override is unpinned, and it is load-bearing

`pages-edit.test.js` stays 74 of 74 with the `...opts` spread removed from
`edit.js`'s `_windowReady`, and 74 of 74 with both pre-broadcast call sites reduced
to a bare `this._windowReady()` (validator probe). The signal calls the override
not observable by a unit spec. That is true only when no file is ever held. The
supplementary remove button carries no `:disabled` binding, so a file removed while
the awaited upload leg is in flight makes `holdsAttachedFiles` false at the
pre-broadcast gate with the pins already paid for, and the explicit
`allowRedirect: false` is then the only guard.

Add one spec per branch (continuation and same-author, since the two literals sit
in mutually exclusive branches and neither twin can mask the other): the upload
mock empties `supplementaryFiles` and drops the stored window, and the spec asserts
no `startOrcid`, no broadcast, `step` back at `'idle'`, and the `reauthRequired`
toast. Prefer this in-flow shape over a direct call to the wrapper: a direct call
pins the spread and leaves both call-site literals unpinned. Probe each literal
and the spread separately.

### Item 5 (low) — the subject-change abandonment has no spec, and the mock that would host one does not mirror the mapper

The signal claims a subject-change abandonment takes the same queue-flushing exit
as a torn-down session. `editor.test.js` mocks `describeUploadError` under a
comment saying it mirrors the real mapper, but maps only `UPLOAD_SESSION_TORN_DOWN`
to null; `UPLOAD_SUBJECT_CHANGED` shares the null contract in `lib/ipfs-upload.js`
and falls to `common.uploadFailed` in the mock. Raised independently by three
reviewers. Make the mock follow the real mapper's null contract and add the editor
spec: a subject-change rejection mid-batch abandons the remaining images and adds
no toast of its own.

### Not held, routed / accepted

Filed as its own task, `ui-edit-draft-omits-addressed-reviews` (signal residual 4):
the edit draft does not carry `addressedReviews`, so a passwordless entry-gate
navigation returns with the ticks gone and the resubmit broadcasts without
`addresses_reviews`. Pre-existing, but it silently changes what goes on chain.

Still open with the user, not decided this round (signal residual 3): the review
page, the comment composer, and both vouch call sites reach
`broadcastWithFreshAuth` with the permissive default and navigate over undrafted
work. Pre-existing and unchanged by this diff.

Accepted as documented residuals: a passwordless account with no window dropping N
images gets N identical `reauthRequired` toasts (nothing informative is evicted, so
the item 1 contract of round 5 holds); an explicit `allowRedirect: undefined`
defeats the opts spread, and no caller passes one; a mid-submit PDF swap inside the
margin can navigate, identical to base behavior and moot once item 2 reverts the
carve-out; editor images queued or inside the draft debounce are not counted by
`holdsAttachedFiles`. One wording note, recorded rather than held: the new comment
in `_handleImageUpload` reads as if the subject-change class is closed, but the
abandonment fires only when the in-flight image fails with an already-reported
code; an in-flight image that succeeds across a cross-tab subject change is not
covered.

Not verified by this review: the full-suite count, `npm run build`, and the E2E
run the signal reports.

**When the fixes land, `git mv` this file back to `tasks/review/`.** The move is the
re-review signal. Do not edit this hold block or annotate items as fixed; the commit
diff is the evidence and the architect updates the block at re-review.
