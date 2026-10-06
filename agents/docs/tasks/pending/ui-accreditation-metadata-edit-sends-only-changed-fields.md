# The metadata edit re-sends stored values the backend now refuses

**Owner:** ui
**Created:** 2026-10-06
**Priority:** normal

Filed from the review of `backend-accreditation-mail-names-the-account` (finding 1, validator
confirmed; triage: user, "as recommended"). Incidence was not measured: nobody checked whether a
stored accreditation holds such a character.

## Why

`accreditationRequestSchema` now rejects line breaks, the other control characters (Unicode Cc)
and the bidi embedding, override and isolate characters in `full_name` and `institution`, with
400 `BAD_REQUEST` and the message `<field>: must not contain line breaks or control characters`.
`accreditationMetadataEditSchema` picks both fields from it, so `PATCH /api/accreditation/metadata`
applies the same rule to every value it receives.

`_prefillMetadata` in `frontend/src/pages/settings.js` fills the three inputs from the current
accreditation, and `handleMetadataSubmit` always sends all three. `trim()` removes only leading and
trailing whitespace. So an account whose current name or institution holds one of the rejected
characters inside the value gets 400 on every metadata edit, including an edit that changes only
`field`, and sees only `settings.metadataUpdateFailed`. Values like that could be written through
`/request` before the rule landed, and still can through signup, the admin grant and the ORCID
name (`backend-accreditation-character-rule-on-other-chain-writes`).

`POST /api/accreditation/request` answers the same 400 for a typed value, and
`frontend/src/pages/accreditation.js` shows only `common.accreditationFailed` for it.

## Scope

1. `handleMetadataSubmit` sends only the fields whose value differs from the prefill. The backend
   carries an omitted field forward from the prior op. An edit that changes nothing sends no
   request.
2. A 400 whose message starts with `full_name:` or `institution:` shows a message that names the
   field and says it contains a character that is not allowed, on the settings metadata form and
   on the accreditation request form. New strings go through the i18n locale files the way the
   neighbouring error keys do.
3. The comment above the `values` object in `handleMetadataSubmit` says the trim matches "the
   backend's trim-before-validate". Neither `accreditationRequestSchema` nor the metadata route
   trims. Narrow or delete the claim.

## Acceptance criteria

1. A spec pins that a `field`-only edit sends `field` alone.
2. A spec pins the field-specific message for a `full_name:` 400 on each of the two forms.
3. No emdash in new UI copy. Comments follow root `CLAUDE.md` "Comment anchors".
