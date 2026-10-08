# The recover page offers ORCID recovery whenever the public record carries an ORCID

**Owner:** ui
**Created:** 2026-10-08
**Priority:** normal

Filed from `architect-email-change-owner-notice-and-dispute-race` (decided with the user
2026-10-08, "as recommended"). Independent of the backend tasks filed with it.

## Why

The recover page (`frontend/src/pages/recover.js`, `_doOrcidCheck`) offers the ORCID method only
when the public accreditation method is `'orcid'`, although the public record already carries
`accreditation.orcid` and `POST /api/auth/recover`'s ORCID path accepts any light row whose
`orcid` is set (ARCHITECTURE.md § 6.4, "Recover (lost email access, ORCID path)": B and C). An
email-signup state B owner, whose exit after a lost mailbox is ORCID recovery, cannot reach it in
the web client.

## Scope

1. `_doOrcidCheck` sets `orcidAvailable` when `accreditation.orcid` is a non-empty string,
   whatever the method.
2. Unit specs for an email-method record with an ORCID and for one without.

## Acceptance criteria

1. A username whose public accreditation carries an ORCID gets the ORCID method; one without
   does not.
2. No new disclosure: the field is public today.
