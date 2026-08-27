# Reconcile the hasPassword re-auth factor resolution across surfaces

**Owner:** ui
**Created:** 2026-08-27

Routed out of the architect review of `e9512840` (light-account re-auth window).
Not held on that task: the code it landed is on the *correct* side of this
divergence, and the surfaces that need changing are outside its scope.

## Why

Four places independently resolve whether an account has a password, and they
disagree about what to do when the answer is unavailable. The re-auth factor a
user is offered therefore depends on which surface they happen to be on.

- `lib/fresh-auth.js` (`accountHasPassword`): only an explicit `hasPassword === false`
  routes to ORCID. An unknown or failed status falls through to the password
  prompt and lets the backend reject a genuinely passwordless account.
- `lib/settings-fresh-auth.js` (`usesPasswordFactor`): returns
  `action !== 'set_password' && hasPassword`, so a falsy value routes to ORCID.
- `pages/settings.js`: reads `hasPassword === true` strictly, and on a failed
  status fetch substitutes `{ hasEmail: false, custody: 'self', hasPassword: false }`.
- `pages/admin.js`: initialises `hasPassword: false` and sets
  `hasPassword: emailRes?.data?.hasPassword === true`.

So one transient `fetchEmailStatus` failure sends a state-B user to a password
modal on publish and to a full-page ORCID redirect on change-email. The redirect
is the destructive branch: it discards page state, which is precisely what the
window work set out to stop doing to people.

`fresh-auth.js` has the posture the project wants. The others predate it.

## Scope

1. Make one resolver canonical. `accountHasPassword` in `lib/fresh-auth.js` is
   the natural home; it already memoises per username for the tab. Have the
   settings, admin, and settings-fresh-auth paths consume it rather than each
   fetching and caching their own answer.
2. Reconcile the failure direction to the password-prompt posture: only an
   explicit `false` may route to ORCID. Unknown, failed, or absent falls through
   to the password prompt and lets the backend reject.
3. Preserve the one legitimate exception: `set_password` targets a null-hash
   account by definition, so ORCID is its only registered factor regardless of
   what the status says. Keep that branch, and make it read as the deliberate
   exception it is rather than as a case of the general rule.

## Acceptance criteria

1. Exactly one function in the frontend resolves `hasPassword` for factor
   selection; the settings, admin, and settings-fresh-auth surfaces call it.
2. With `fetchEmailStatus` failing, a state-B user attempting change-email gets
   the password prompt, not an ORCID redirect.
3. `set_password` still routes to ORCID for a passwordless account.
4. The memo cannot be inherited across a logout and re-login as a different
   account (it is username-keyed today; keep that property under the unification).

## Notes

Consider clearing the memo in `auth.disconnect()` alongside the window cache
while in the area. It is username-keyed so cross-account inheritance is not
reachable, but a stale positive can outlive the only transition that drops a
password (`recover(orcid, no new_password)`, which moves B to C per
`ARCHITECTURE.md` § 6.3). That transition runs through a real navigation today,
which resets module state, so this is tidiness rather than a live bug.
