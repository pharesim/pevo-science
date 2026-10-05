# The sign-in modal has no way to ORCID sign-in

**Owner:** ui
**Created:** 2026-09-30
**Priority:** high

## Why

The sign-in modal (`signInModal`, opened by the auth store's `connect()`)
offers two options: email with password, and the browser extension. ORCID
sign-in exists only on the `/login` page (`handleOrcidLogin`), and the modal
links to sign-up and to the password reset, not to `/login`.

A light account with no password can therefore not sign in from the modal.
That was a minor gap while the modal only opened on the user's own click. It
is now the surface a revoked session lands on: the auth store's
`handleRevokedSession` tears the session down and opens this modal in place.
One of the causes of that teardown produces exactly the account the modal
cannot serve. A recovery through ORCID with no new password leaves the account
passwordless and revokes every other session. On the other device the modal
opens, email sign-in fails with the generic failure message because no
password exists, the extension option does not apply to a light account, and
nothing on screen points to ORCID.

## Scope

1. Give the modal's chooser a path to ORCID sign-in. Either an ORCID option
   that starts the same flow `/login` starts, or a link to `/login`. Prefer
   the option that does not leave the page when that is cheap, since the
   revoked-session teardown stays in place to keep unsaved work. If the ORCID
   round-trip leaves the page anyway, a link to `/login` is honest about it.
2. Reuse the login page's start flow rather than writing a second one,
   including the redirect-host allowlist check.
3. Add the copy to all sixteen locales per the stub convention.

## Acceptance criteria

1. A passwordless light account can reach ORCID sign-in from the modal.
2. The modal's existing email and extension paths are unchanged.
3. A unit test pins the new path.
