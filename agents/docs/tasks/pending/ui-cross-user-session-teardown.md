# Close the cross-user teardown gap on re-login

**Owner:** ui
**Created:** 2026-08-31

Routed out of the architect review of `199c1e13` (light-account re-auth window).
Not held on that task: the gap is pre-existing and spans the login surfaces,
which are outside that task's scope. It is the reason the mismatch item held
there is reachable at all.

## Why

`auth.disconnect()` scrubs the JWT, the stored session, both fresh-auth proof
caches, the password-factor memo and the ORCID return-path pointer. Its comment
states the intent plainly: so that cross-user re-login on a shared browser
cannot pick up a stale fresh-auth proof.

The ordinary re-login path never runs it. `login.js` and `sign-in-modal.js`
call `loginFromResponse` for a new username directly, so a second user signing
in on the same tab inherits the first user's cached session window. The server
catches it (the consume compares the entry's username to the JWT subject and
refuses), but only after the client has spent an action on a credential that was
never going to work, and the client-side recovery from that refusal is exactly
what the re-auth window task had to add a teardown branch for.

Separately, `disconnect()` does not clear the module-level in-flight acquisition
promise in `lib/fresh-auth.js`. An acquisition still pending when the user
disconnects resolves afterwards and can hand its result to whoever joins next.
Reachability is thin today, since a password mint is pending on a modal the user
must interact with, but it sits in the same teardown block and has the same
shape as the caches that are cleared.

## Scope

1. Make the cross-user scrub run on every path that changes the JWT subject, not
   only on explicit logout. Prefer routing the login paths through the existing
   teardown over duplicating the scrub list at each call site, so a future cache
   added to `disconnect()` is not silently missed by the login surfaces.
2. Clear the in-flight acquisition promise as part of the same teardown.
3. Decide and document what "same subject re-login" should do. Re-authenticating
   as the account already signed in need not discard a live window, and treating
   it as a subject change would cost a re-auth the user does not owe.

## Acceptance criteria

1. Signing in as a different username in the same tab leaves no cached session
   proof, consent-op proof, password-factor memo, or return-path pointer from
   the previous subject.
2. A test drives the real login path (not `disconnect()` directly) and asserts
   the caches are empty afterwards.
3. An acquisition in flight when the session is torn down cannot deliver its
   result to a caller that arrives after the teardown.
4. The same-subject case behaves as decided in scope item 3, with a test either
   way.

## Notes

The reachability chain was established during the review of `199c1e13`: an
independent validator traced it to confirm that a `username_mismatch` refusal at
the IPFS upload leg is a live path rather than a theoretical one. The held task
adds the client-side teardown branch that handles the refusal; this task removes
the cause.

**Architect addendum (2026-08-31, from the hasPassword-divergence round-3
review):** the factor-resolution rework added a SECOND module-level in-flight
slot with the same shape, `_factorResolutionInFlight` in `lib/fresh-auth.js`.
It is joined with no identity comparison, and `clearPasswordFactorMemo()`
(which `disconnect()` calls) bumps the memo generation without nulling the
slot, so a status fetch pending across a same-tab disconnect and re-login hands
the previous account's `{ usesPassword, assumed }` answer to the new account's
first resolution (one-shot; the memo write is generation-guarded, and the next
resolution self-corrects). Four reviewers converged on it independently. Scope
item 2 and acceptance criterion 3 apply to BOTH slots: identity-key the join
(a caller only shares a flight whose captured username matches the current auth
subject), null the slot in the teardown, and guard each flight's `finally` to
clear only a slot it still owns. Add the cross-identity coalescing test neither
suite has (a clear landing mid-flight plus a second caller must trigger a fresh
fetch, not join the stale flight).

---

## UI completion signal (2026-08-31, commits 1b9f2137 + 9ecff448 + 4c3e7c7a)

Implemented in an isolated worktree from `c410a279`, adversarially reviewed by
three lenses (correctness/races, security/account-state against ARCHITECTURE
§ 6.1/6.4/6.5, test-quality with mutation probes) plus a re-verification pass,
then cherry-picked onto main. The addendum landed after the base implementation
and its remaining item was closed in `4c3e7c7a`.

**Design.** One funnel method on the auth store, `_adoptSubject(username)`,
called from `loginFromResponse` (before any field lands; subject falls back to
`this.username` when the response omits it, so the settings custody-upgrade
sites are same-subject by construction) and from `_restoreSession` (covering
init, cold load, and the cross-tab storage event). Detection is backed by a
per-tab sessionStorage marker `pevo_tab_subject` recording which subject the
tab's sessionStorage state belongs to, with an in-memory fallback to
`this.username`. The scrub list is not duplicated: `disconnect()`'s block moved
into `_scrubSubjectBoundState()`, called by both `disconnect()` and
`_adoptSubject()`.

**Scope 2 / AC 3, both slots.** `lib/fresh-auth.js` exports one teardown,
`abandonInFlightAcquisitions()`: nulls both `_acquireInFlight` slots and
`_factorResolutionInFlight` and bumps `_acquireGeneration`. Flights capture the
generation before any await and re-check it after factor resolution, before
spending a mint, after the mint round-trip (before `cacheSessionProof`, so a
late issuance cannot repopulate the scrubbed cache), and after
`mintViaPasswordFactor` (so the assumed-password ORCID fallback cannot navigate
post-teardown); stale flights resolve as a clean cancel. Both finally blocks
are ownership-guarded. Per the addendum, the factor-resolution join is
identity-keyed on the captured subject, with the cross-identity coalescing test
(subject swap mid-flight without the scrub; the second caller spends its own
fetch).

**Scope 3 decision.** Same-subject re-login preserves the live window, caches,
memo and marker; it is not a subject change and costs no re-auth. Documented at
`_adoptSubject`, pinned by tests including the username-less custody-upgrade
shape.

**Verification.** All new tests observed red at base before implementation
(18 red across 4 files). Every teardown guard in the acquisition path has a
killing test (verified by per-guard mutation probes, each killed by exactly its
intended test). ACs 1, 2, 4 driven through the REAL store paths (`initAuth` +
`loginFromResponse` / `_restoreSession` / `_handleStorageEvent`) and the real
page surfaces (`pages-login`, `components-sign-in-modal`). Full frontend unit
suite on the integrated tree: 79 files, 1733 tests green (the 3 vitest errors
are the documented pre-existing `pages-edit` `_mountEditors` rejections).
Playwright not run: no visual surface changed and the login flows are covered
at the unit layer against the real store; flagging the omission explicitly.

**Residuals surfaced for triage, deliberately not fixed here:**

1. (low) `orcid-callback.js` `_handleSessionAuth`/`_handleFreshAuth` cache a
   proof echoed for the previous subject with no subject/generation guard, so a
   teardown landing during the one `completeOrcid` round-trip can be followed
   by a stale cache write. Sub-second cross-tab race; the wide while-at-ORCID
   window is fail-closed (the scrub removes `pevo_orcid_mode`, so callback init
   dead-ends first), and the server's `username_mismatch` refusal plus the
   existing teardown branch self-heal it. Reviewers judged it dismissible under
   the theoretical-only norm; recorded so the decision is conscious.
2. (low) `_adoptSubject`'s in-memory fallback (`marker ?? this.username`) is
   exercised only when `sessionStorage.getItem` itself throws, an environment
   the suite does not simulate; the fallback is unpinned by tests. Near-
   theoretical per repo norms.

---

## Architect re-review (2026-09-01) — HELD PENDING FIXES:

Reviewed via `/ce-code-review` on `1b9f2137` + `9ecff448` + `4c3e7c7a` (frontend
paths only), eight reviewer personas plus an independent validation batch. **The
core work is verified sound and complete.** Independently confirmed rather than
taken from the signal: every subject-change path (login page, sign-in modal,
Keychain connect, ORCID-login callback, custody upgrade, cold restore, cross-tab
storage event) funnels through `_adoptSubject`; all four generation checks and both
ownership-guarded finally blocks each have a distinct killing test; the
identity-keyed factor-resolution join holds under every constructed interleaving;
ARCHITECTURE § 6.5 invariant #9 holds (`cacheSessionProof` call sites unchanged);
project-standards clean. All four acceptance criteria are met by tests driving the
real store paths.

Two items, both on the task's own surfaces.

### Item 1 — the ORCID redirect after `startOrcid` is the one acquisition await with no generation re-check

`acquireSessionProof` re-checks the teardown generation at every step boundary and
resolves stale flights as a clean cancel, except the passwordless branch: it calls
`beginSessionAuthOrcidRedirect` -> `beginOrcidFreshAuthRedirect`, and that helper
awaits `startOrcid` (a network round-trip) and then assigns `window.location.href`
with no re-check. Both passwordless outcomes reach it after their last generation
check. A teardown landing during that round-trip (the cross-tab storage-event login
this task adds a first-class path for) still full-page navigates the new subject's
tab to ORCID on the previous subject's behalf; the scrub has already removed
`pevo_orcid_mode`, so the return dead-ends in the callback's generic error branch.
Confirmed independently by three reviewers (adversarial constructed it mechanically,
security and correctness traced it), and it is the literal completion of this task's
own "re-check at every step boundary" invariant, which the review found uncovered at
exactly one boundary.

Thread a staleness predicate into `beginOrcidFreshAuthRedirect` (an optional
callback), supplied by `acquireSessionProof` as
`() => generation !== _acquireGeneration`. After `startOrcid` resolves and before the
navigation, if stale: clear the `pevo_orcid_mode` and return-path keys it wrote
(mirroring the existing error-unwind blocks) and return `FRESH_AUTH_CANCELLED`.
Page-level callers pass no predicate and keep today's behavior. Add the mirror test:
`startOrcid` pending -> teardown -> resolve -> assert `window.location.href`
unchanged and no navigation fired.

### Item 2 — the test fixture mirror hardcodes the scrub key list with no parity pin

`fixtures/mock-auth.js`'s `mockLoginFromResponse` reimplements the subject-adoption
scrub as a literal six-key array. Three of those keys (the session-proof,
consent-op-proof, and return-path keys) are module-private consts in `fresh-auth.js`
that are never exported, so the fixture cannot import the source of truth and must
copy the strings by hand. `components-sign-in-modal.test.js` and
`pages-login.test.js` assert cross-user-scrub behavior against this mirror, not the
real store, and no test binds the mirror's output to the real store's for identical
input. A future subject-bound cache added to the real `_scrubSubjectBoundState`
(whose own docblock instructs adding future caches THERE) silently desyncs, and those
two suites keep passing while no longer proving what they claim. Five reviewers
converged on it.

Either export the subject-bound key set from `auth.js` / `fresh-auth.js` (retiring the
can't-import-the-truth problem for the three private consts) and have the fixture
import and loop it, or add one parity test that seeds identical state, runs the real
`loginFromResponse` and `mockLoginFromResponse`, and asserts the resulting
sessionStorage contents match.

### Not held, routed elsewhere

The consent-op orchestrators (`settings-fresh-auth.js`, `authorship-consent.js`) act
on the same shared `resolvePasswordFactor` / `mintViaPasswordFactor` primitives with
no teardown guard, and the scrub does not close an open reauth modal, so a password
typed into a prompt left open across a cross-tab subject swap mints under the new
subject's JWT and runs the previous subject's action against the new subject's
account (validated end-to-end including the backend proof-to-subject binding). Filed
as `ui-consent-op-teardown-guard` because the fix spans files outside this task's
scope; the session-path reauth-modal silent-cancel gap (the same missing modal close)
is folded into it, as are the `username_mismatch` escapes on the broadcast and upload
retry legs (the same "teardown does not reach this path" family).

The custody-upgrade re-login race (the omitted-username `loginFromResponse` fallback
landing under a subject changed by a concurrent cross-tab login during the up-to-20s
upgrade window) is filed as `ui-custody-upgrade-subject-pin`; the "same-subject by
construction" comment this task added overclaims for that call site.

The disclosed orcid-callback stale-proof-write residual and the `_adoptSubject`
in-memory-fallback coverage gap are accepted as documented residuals (fail-closed and
near-theoretical respectively).

**When the fixes land, `git mv` this file back to `tasks/review/`.** The move is the
re-review signal. Do not edit this hold block or annotate items as fixed; the commit
diff is the evidence and the architect updates the block at re-review.
