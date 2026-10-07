# Pin the recover page's ORCID start against a subject teardown

**Owner:** ui
**Created:** 2026-10-05
**Priority:** low

Routed out of the architect review of `ui-page-level-orcid-start-subject-pin`
(archived 2026-10-05), where the implementer flagged it as out of scope.

## Why

`recover.js#handleOrcidVerify` writes `pevo_orcid_return_to` ('recover') and
`pevo_orcid_mode` ('signup'), awaits `startOrcid('signup')`, then assigns
`window.location.href` with no re-check. Its catch removes both keys
unconditionally.

The start request itself is unauthenticated (`signup` is not in
`ORCID_AUTHED_MODES` in `api.js`, so `startOrcid` uses `request`), so unlike the
settings link and accreditation flows the OAuth state is not minted under a
session JWT. The tab can still hold a live session while on `/recover`:
`recover.js` reads no `isConnected`, and the ORCID button renders whatever
the tab's session state. Both keys are in `SUBJECT_BOUND_STORAGE_KEYS`, so a subject teardown
inside the start await removes them. `_scrubSubjectBoundState` runs on
`disconnect()` (header sign-out, a cross-tab sign-out through the storage
event) and from `_adoptSubject` when the tab's previous subject is non-null and
differs from the new one (a login as another user). A login from a tab with no
subject does not scrub.

Two consequences follow when the teardown lands inside the await:

1. **Resolve.** The flow navigates to ORCID with both keys gone. On return the
   callback reads an empty mode, and `_handleSignup` routes to `/signup`
   whenever `pevo_orcid_return_to` is absent, so a recover round-trip that
   completes lands on the signup page instead of `/recover`. (Confirm what the
   backend does with an empty mode for a signup-minted state. The routing
   above holds either way, because the pointer is gone.)
2. **Reject.** The catch removes `pevo_orcid_return_to` and `pevo_orcid_mode`,
   which by then belong to whatever later flow wrote them in this tab. This is
   the same flow-key ownership defect the page-level pin closed for the
   settings link and accreditation catches.

## Scope

1. Close the mid-await teardown for the recover ORCID start. Two acceptable
   shapes; pick one and say which:
   - (a) **Inline pin**, the same shape as `settings.js#handleOrcidLink` and
     `accreditation.js#handleOrcidVerify`: open `subjectTeardownGuard()` before
     the await, read only `tornDown()` after it on both the resolve and reject
     paths, reset `orcidLoading`, and return without navigating, reporting, or
     removing any key. If you take (a), say in the signal block whether a
     silent no-op is right here. On settings and accreditation the page
     re-renders for the new subject. On `/recover` the page looks the same, so
     the user sees a click that did nothing.
   - (b) **Signed-out only**, matching login and signup, which render their
     ORCID starters only under `!isConnected`: the ORCID start is unavailable
     while the tab holds a session. A login from a subject-less tab does not
     scrub, so this removes the teardown case entirely. A signed-in visitor
     must see why the ORCID path is unavailable and how to proceed (sign out
     from the header) rather than a hidden or dead button. If (b) changes
     anything beyond the ORCID start (for example the seed-phrase path),
     move this task to `blocked/` with a `[BLOCKED by Architect]` note before
     doing it.
2. Either way, the reject path must not remove `pevo_orcid_return_to` or
   `pevo_orcid_mode` once this flow's keys may have been scrubbed.
3. Tests, red at base, driving the real store path as
   `frontend/tests/unit/pages-orcid-start-subject-pin.test.js` does
   (`initAuth`, then `disconnect()`, `loginFromResponse` for a different
   username, or the storage-event handler). For (a): start pending, teardown,
   resolve and reject, assert no navigation, `orcidLoading` reset, no message,
   and a successor flow's keys intact; plus an unchanged-subject case that
   still navigates. For (b): assert the start is not reachable while connected
   and still works signed out, plus whatever the signed-in explanation renders.

## Acceptance criteria

1. A subject teardown inside the recover start await never leads to a
   navigation that returns to `/signup` instead of `/recover`.
2. The recover start's reject path removes no flow key a later flow could own.
3. The signed-out recover ORCID flow is unchanged.
4. Tests drive the real subject-change path and were observed red at base.

## Added at the archive of `ui-recover-and-reset-leave-a-revoked-session-signed-in` (2026-10-07)

Folded in by user decision, same function:

4. `handleOrcidVerify` does not check `isSubmitting`. The method tabs and the
   Verify with ORCID button stay clickable while a seed-phrase submit is in
   flight, so the user can pick the ORCID tab, press Verify with ORCID and
   leave for ORCID before the seed request settles. If that request
   succeeds, the user never sees the screen that tells them to confirm
   through the mailed link. Start nothing from Verify with ORCID while
   `isSubmitting` is true; the button works again once the submit settles.
   This applies under either shape in scope item 1, for the signed-out page.

Acceptance criterion 5: while a recover submit is in flight, Verify with
ORCID starts no ORCID request and does not navigate, and a unit test pins it.
