# Pin the subject across the page-level ORCID start round-trips

**Owner:** ui
**Created:** 2026-09-02

Routed out of the architect re-review of `ui-cross-user-session-teardown`
(`659131b8`). Not held there: these two flows are outside that task's scope
and have neither an acquisition flight nor a consent-op guard, so the
generation predicate that closed the session path is not available to them.

## Why

`settings.js#handleOrcidLink` (mode `link`) and
`accreditation.js#handleOrcidVerify` (mode `accredit`) both require an
authenticated subject. Each writes `pevo_orcid_mode` inline, awaits
`startOrcid`, then assigns `window.location.href` with no re-check. A subject
teardown landing inside that await (a cross-tab login storage event, or a
same-tab disconnect from the header) sends the new subject's tab to ORCID on
the previous subject's behalf: the OAuth state was minted under the previous
subject's JWT. On return the scrub has removed the mode key, so
`/orcid/callback` reads mode '' and completes unauthenticated; the backend
refuses before consuming state, and the user lands on the generic
"verification failed" dead-end after a full OAuth round-trip. Fail-closed,
nothing minted, but the same shape the cross-user task's redirect-boundary
hold closed for the session path.

The login, signup, and recover starters run without an authenticated subject
and are out of scope. The consent-op starters are covered by
`ui-consent-op-teardown-guard`.

## Scope

1. Before the navigation in each of the two flows, re-check that the tab still
   represents the subject the start request was made for. Two acceptable
   shapes; pick the smaller and say which: (a) capture the auth store's
   `username` (or the tab-subject marker) before `startOrcid` and compare
   after it resolves; (b) route both flows through the shared
   `beginOrcidFreshAuthRedirect` with a predicate built the same way.
2. On a mismatch, reset the flow's busy flag (`orcidLinking` /
   `orcidLoading`) and return without navigating, as a silent clean cancel
   matching the session path. Do NOT remove the mode or return-path keys in
   that branch: the scrub that changed the subject already removed this
   flow's keys, so a removal there can only hit a later flow's keys (the
   defect the cross-user task's round-2 hold corrects).
3. Tests, red at base, one per flow: `startOrcid` pending, subject change
   driven through the real store path (`loginFromResponse` for a different
   username, or the storage event), resolve the start, assert no navigation,
   the busy flag reset, and a successor flow's keys intact.

## Acceptance criteria

1. Neither flow navigates after a subject change during its start await.
2. The busy flag resets on that path.
3. The stale path removes no storage keys.
4. Both tests drive the real subject-change path, not a hand-rolled helper,
   and were observed red at base.

UI implementation signal (2026-09-30, commits `977409f3` + `dbb9e8ab`, both verified ancestors of `main`):

- **Shape chosen: (a), inline, with the teardown generation as the predicate
  rather than a username compare.** Both handlers open
  `subjectTeardownGuard()` before `await startOrcid(...)` and read
  `guard.tornDown()` after it. The task's "Why" says the generation predicate
  is not available to these flows; it is, the guard is an exported value any
  caller can open. It is also the stricter pin: the generation is bumped by
  the same scrub that removes the mode marker, so it fires exactly when this
  flow's key is gone. A username compare misses a sign-out followed by a login
  as the same user (username matches again, marker scrubbed, navigation
  dead-ends at the callback). Only `tornDown` is read, never `cancel`, so the
  unwind is silent as scope item 2 asks.
- **Stale resolve:** busy flag reset, return, no navigation, nothing removed.
- **Stale reject (beyond the literal scope, same rationale):** the catch also
  returns early when the guard reads torn down. Busy flag reset, no inline
  error or toast, no `console.warn`, no key removal. A live rejection is
  unchanged.
- **`fresh-auth.js`:** one docblock sentence on `beginOrcidFreshAuthRedirect`,
  which said the page-level flows carry no predicate.
- **Tests:** new `frontend/tests/unit/pages-orcid-start-subject-pin.test.js`,
  18 cases (9 per flow), driving the REAL auth store (`initAuth`) over the REAL
  `lib/fresh-auth.js`: `loginFromResponse` as another user, the storage-event
  handler for a cross-tab login and a cross-tab sign-out, `disconnect()`, and
  sign-out then same-user login. Plus stale reject, live reject, unchanged
  subject, and same-subject re-login (the last two must still navigate).
  Observed red at base: 10 of the first version's 16 cases (8 navigation, 2
  stale-reject key removal); the 2 stale-reject cases again red on the silence
  assertions before `dbb9e8ab`.
- **Verification:** full frontend unit suite 87 files / 1975 tests, exit 0, no
  Errors line. Mutation probes in scratchpad copies at `977409f3` (delete
  either early return, un-gate either catch removal, remove a key in the stale
  branch, open the guard after the await, drop the busy reset) were all
  killed. Two mutants survived there and are what `dbb9e8ab` closes: a
  username-compare predicate, and a stale branch that sets an inline error.
  Those two were not re-probed after the fix; the cases that kill them are in
  the suite. No browser check and no `npm run build`: the change has no
  rendered surface and the pages load under vitest.
- **No e2e companion** for the start leg of either flow (the spec header's
  clause (c) says so). `orcid-link.spec.js` covers the link callback leg only.
- **Out of scope, for the architect to route:** the task says the recover
  starter runs without an authenticated subject. `recover.js` has no
  `isConnected` gate and `/recover` has no guest-only route guard, so its
  ORCID start is reachable with a live session and has the same unpinned
  shape: a teardown inside its await scrubs `pevo_orcid_return_to` and
  `pevo_orcid_mode`, it navigates anyway, and the return lands on signup
  instead of `/recover`; its catch removes both keys unconditionally. Login
  and signup render their starters only under `!isConnected`, so the claim
  holds for those. Not touched here.
