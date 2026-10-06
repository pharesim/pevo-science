# The request and signup forms promise a verification link that a bound address never gets

**Owner:** ui
**Created:** 2026-10-06
**Priority:** normal

Filed by the ui agent from the verification of `ui-accreditation-binding-refusal-states`, with the
user's decision to keep it out of that task. Design: `ARCHITECTURE.md` § 2 "Credential Bindings",
enforcement points `POST /api/accreditation/request` and light-account signup.

## Why

Once `backend-mailbox-binding-registry` and `backend-signup-finalize-claims-mailbox-binding` land,
a request or a signup with an address that is already linked to another account gets the same
answer as any other (by design, so the page cannot reveal the link), and the mail carries a notice
instead of a verification link. Three strings around those forms still promise a link:

- `accreditation.emailHint`: "... A verification link will be sent to this address."
- `accreditation.checkEmail`: "Check your email for the verification link."
- `signup.checkEmailDescription`: "We've sent a verification link to your email. Click it to complete
  your registration."

In the bound case each of them is false and points the user at a link that never arrives.

## Scope

1. Reword the three strings so they hold whether the mail carries a link or the notice, for example
   "We will email this address with the next step." and "Check your email for the next step." They
   must stay the same in both cases: nothing on the page may reveal whether an address is bound.
2. These keys carry real translations, so this is an in-place English change on existing keys: re-stub
   the fifteen other locales with the new English and list them under a new
   `### Updated <YYYY-MM-DD> (ui-request-and-signup-copy-promises-a-link-a-bound-address-never-gets)`
   heading in `frontend/public/messages/STUBS.md`. No emdash.

## Out of scope

- The signup page's "resend verification" action; check what it sends for a bound address once the
  backend task is in, and file it separately if it misleads.

## Acceptance criteria

1. The three strings make no promise of a link, and read the same for a bound and an unbound address.
2. All sixteen locales updated and the `Updated` ledger section lists each (locale, key) pair once.
