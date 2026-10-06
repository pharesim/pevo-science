# Other accredit-op writers accept line breaks and control characters

**Owner:** backend
**Created:** 2026-10-06
**Priority:** high

Filed from the review of `backend-accreditation-mail-names-the-account` (the implementer's
out-of-scope follow-up, extended by the security reviewer; triage: user, "as recommended").

## Why

`accreditationRequestSchema` in `backend/src/validation.ts` now rejects, in `full_name` and
`institution`, the Unicode Cc characters, U+2028, U+2029, U+202A to U+202E and U+2066 to U+2069
(`NO_CONTROL_CHARACTERS`), because those values are printed in the verification mail and broadcast
in the `accredit` op. Other paths put a name, institution or field into an `accredit` op without
that rule:

- `SignupBodySchema` in `backend/src/routes/auth.ts`: `full_name`, `institution` and `field` are
  bare `z.string().optional()`. The pending row's values become the op's `name`, `institution`
  and `field` in `backend/src/routes/signup-verify.ts`.
- `adminAccreditationGrantSchema` in `backend/src/validation.ts`: `full_name`, `institution` and
  `field` carry length bounds only.
- `accreditationRequestSchema.field`: broadcast as `field: pending.field` by `/verify`.
- The ORCID profile name: `handleAccredit` in `backend/src/routes/orcid.ts` broadcasts
  `name: orcidName || username`, and the ORCID signup path takes the name from it too.

A value written through one of these paths is also refused later by the settings metadata edit
when the SPA re-sends it (`ui-accreditation-metadata-edit-sends-only-changed-fields`).

## Scope

1. Export `NO_CONTROL_CHARACTERS` and its message from `backend/src/validation.ts` and apply the
   rule to `full_name`, `institution` and `field` in `SignupBodySchema` and
   `adminAccreditationGrantSchema`, and to `field` in `accreditationRequestSchema` (the metadata
   edit inherits it through `.pick()`).
2. The ORCID name is not typed into a PEvO form, so refusing it leaves the user no fix inside
   PEvO. Decide how it is handled before broadcast and state the choice in the signal block.

Out of scope: values already on chain that a later op carries forward unchanged.

## Acceptance criteria

1. Specs pin a 400 for a line break in each newly covered field on each schema, and acceptance of
   an ordinary non-Latin value.
2. A spec pins the ORCID-name handling chosen in Scope 2.
3. No emdash in new response strings. Comments follow root `CLAUDE.md` "Comment anchors".

## Architect note (2026-10-07): raised to high

From the review of `backend-latest-op-haf-lookups-walk-the-blocks-index` (triage: user). The
character rule also protects the HAF reads:

- PostgreSQL's jsonb input rejects the escape `\u0000` and a lone surrogate escape such as
  `\ud800` (checked on PostgreSQL 16; the HAF node runs 17.9). `::json ->> 'action'` also throws
  when another key holds `\u0000`.
- `hafsql.operation_custom_json_view.json` is `text` (`body_value ->> 'json'`), so the
  `cj.json::jsonb` casts in PEvO's queries parse it.
- `JSON.stringify` writes U+0000 as `\u0000` and a lone surrogate as its `\uXXXX` escape. An
  authority-signed accredit op carrying one makes every query that casts that row throw, and the
  op cannot be removed from the chain. `/verify`, the metadata edit and the ORCID flows would fail
  for every user.

Scope addition: also reject a lone surrogate (a value that is not well-formed UTF-16) in every
field Scope 1 covers and in `full_name` and `institution` of `accreditationRequestSchema`.
`NO_CONTROL_CHARACTERS` rejects U+0000, which is Cc, but not a lone surrogate. Scope 2's handling
of the ORCID name covers both.

AC addition: specs pin a 400 for U+0000 in each newly covered field, and for a lone surrogate in
every field the scope addition names.

The read side, for ops any Hive account can broadcast, is
`backend-custom-json-unicode-escape-breaks-jsonb-casts`.
