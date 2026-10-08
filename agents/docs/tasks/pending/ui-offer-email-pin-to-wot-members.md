# A WoT member can verify an email to pin their accreditation

**Owner:** ui
**Created:** 2026-10-08
**Priority:** normal

Filed from the architect intake review of `backend-verify-gate-treats-wot-enrollee-as-accredited`.

## Why

User decision (2026-10-05): an email verification makes any WoT enrollee authority-pinned,
whether or not the account currently meets the vouch threshold. Since `31994b09`,
`POST /api/accreditation/verify` broadcasts the `method: 'email'` accredit for an account whose
latest op is a `wot` accredit. `frontend/src/pages/accreditation.js` shows the request form only
under `!isAccredited`, so a WoT member who meets the threshold has no way to ask for it. Only a
member who has dropped below the threshold sees the form.

## Scope

1. On the accreditation page, an accredited member whose `accreditation.method` is `wot` is
   offered the email verification, through the existing `POST /api/accreditation/request` and
   `/verify` flow. The copy says that it makes the accreditation independent of vouches.
2. Members accredited by `email`, `orcid` or `manual` see no change.
3. New strings go through the i18n catalog like the existing accreditation copy. No emdash in UI
   copy.
4. Comments follow root `CLAUDE.md` "Comment anchors".

## Acceptance criteria

1. A `wot` member sees the email verification form, and submitting it runs the existing request
   and verify flow.
2. An `email`, `orcid` or `manual` member does not see it.
3. No emdash in UI copy.
