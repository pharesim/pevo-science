# Pin the custody-upgrade re-login to the subject the upgrade started for

**Owner:** ui
**Created:** 2026-09-01

Routed out of the architect review of the cross-user teardown work. Pre-existing
race made newly relevant (and newly overclaimed-against) by that diff.

## Why

`loginFromResponse` in `auth.js` derives the adopted subject as
`data.username !== undefined ? data.username : this.username`. The custody-upgrade
call sites in `pages/settings.js` (the upgrade executor and its backend retry) omit
`username` from the response on purpose and rely on the `this.username` fallback,
which the teardown diff's comment describes as "same-subject by construction."

That premise holds only if `this.username` still names the account the upgrade was
started for when the response lands. The backend cleanup can take up to 20 seconds
(the settings code's own comment), and nothing pins `this.username` for that
duration. If a different user logs in from another tab during the window, that
login's own `_adoptSubject` has already advanced `this.username` and the
`pevo_tab_subject` marker to the new user; when the stale upgrade response then
arrives, adoption sees "no change" and skips the scrub while the upgraded token
lands under the new subject's username.

## Scope

1. Have the custody-upgrade call sites capture the username the upgrade started for
   (before the first await) and pass it explicitly as `username` in the
   `loginFromResponse` payload, so subject adoption compares against the intended
   subject rather than whatever `this.username` happens to be when the response
   lands.

## Acceptance criteria

1. A custody-upgrade response that lands after a concurrent cross-tab login as a
   different user is recognized as a subject change (the upgraded token does not
   land under the wrong username), driven by a test that simulates the intervening
   login during the upgrade window.
2. An ordinary custody upgrade with no intervening login still succeeds and stays
   same-subject (no spurious scrub).

## Notes

Impact of the current bug is a stale-but-same-account token confusion rather than a
cross-account credential leak (the backend still binds by JWT subject), which is why
this is filed on its own rather than held on the teardown task. Fixing it also
retires the teardown diff's "same-subject by construction" comment, which overclaims
for this call site.
