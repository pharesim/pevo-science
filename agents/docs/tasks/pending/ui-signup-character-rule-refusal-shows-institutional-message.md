# Signup shows "institutional email required" when a field holds a refused character

**Owner:** ui
**Created:** 2026-10-08
**Priority:** normal

Filed from the review of `backend-accreditation-character-rule-on-other-chain-writes` (finding 1,
validator confirmed; triage: user, "approved"). Incidence was not measured.

## Why

`SignupBodySchema` (`backend/src/routes/auth.ts`) refuses a `full_name`, `institution` or `field`
holding a line break, another control character, a bidi embedding, override or isolate character,
or an unpaired surrogate, with 400 `VALIDATION_ERROR` and the message `Invalid request body`.

The submit handler in `frontend/src/pages/signup.js` shows `signup.orcidOrInstitutional` for every
`VALIDATION_ERROR` when no ORCID token is set, so the user reads that an institutional email or
ORCID is required. With an ORCID token it shows `signup.submitFailed`. Neither names the field.
The refusal that `signup.orcidOrInstitutional` describes is the 422 `VALIDATION_ERROR` with the
message `Either an institutional email or ORCID verification is required`.

## Scope

1. Show `signup.orcidOrInstitutional` only for the 422 non-institutional refusal.
   `ApiRequestError` (`frontend/src/api.js`) records no HTTP status today; how the page tells the
   422 apart is your choice.
2. On both paths, the 400 `Invalid request body` shows a new message that names full name,
   institution and field and says one of them holds a character that is not allowed. `/signup`
   does not say which field. New strings go through the i18n locale files the way the
   neighbouring error keys do.

## Acceptance criteria

1. Specs pin that a 400 `Invalid request body` shows the new message on both paths and not
   `signup.orcidOrInstitutional`, and that the 422 still shows `signup.orcidOrInstitutional`.
2. No emdash in new UI copy. Comments follow root `CLAUDE.md` "Comment anchors".
