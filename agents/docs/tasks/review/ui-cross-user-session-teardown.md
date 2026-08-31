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
