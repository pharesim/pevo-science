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
