# The accreditation mail does not say which account the link accredits

**Owner:** backend
**Created:** 2026-10-05
**Priority:** high

Filed from the accreditation and Web of Trust audit (finding 4, the part that needs no other
change first). The session requirement on `/verify` is a separate, sequenced task:
`backend-accreditation-verify-requires-the-account-session`.

## Why

The verification mail sent by `POST /api/accreditation/request` (the `sendMail` call in
`backend/src/routes/accreditation.ts`) greets the reader with the requester-supplied `full_name`
and carries the link. It does not name the Hive account the link accredits, and it does not say
that opening the link accredits an account at all. `full_name` is any 1 to 200 characters
(`accreditationRequestSchema` in `backend/src/validation.ts`), line breaks included, so the
requester writes up to 200 characters of the mail's opening.

A requester can enter someone else's institutional address and name. The recipient then gets a
mail that reads as their own pending accreditation, and opening the link accredits the
requester's account under the recipient's name.

## Scope

1. The mail body states:
   - the Hive account the request came from, written `@<hive_username>`;
   - that opening the link accredits that account on PEvO under the name and institution given
     in the request, and it shows both;
   - that a recipient who did not request this should ignore the mail and not open the link.

   This is user-facing text: no emdash.
2. `full_name` and `institution` then both appear in the mail, and both are broadcast on chain.
   Reject line breaks and other control characters in them in `accreditationRequestSchema`.
   `accreditationMetadataEditSchema` picks its field bounds from the same schema, so confirm the
   metadata edit inherits the rule and still accepts ordinary values.

## Out of scope

- Requiring a session on `/verify`, and the mail sentence that tells the reader to open the link
  while signed in. Both belong to the sequenced task named above.
- The request limiter (`backend-accreditation-limiters-refund-work-already-done`).

## Acceptance criteria

1. A spec pins that the mail body carries the requesting account, the name and the institution,
   and the ignore-if-not-yours sentence.
2. `/request` with a `full_name` or an `institution` that contains a line break answers 400
   `BAD_REQUEST` and sends no mail.
3. No emdash in the mail text. Comments follow root `CLAUDE.md` "Comment anchors".

## Backend implementation signal (2026-10-06, commits 85429ce5, e553b3a6)

Both SHAs verified on `main` with `git merge-base --is-ancestor`.

- `85429ce5` backend(accreditation): the verification mail names the account it accredits.
  `backend/src/routes/accreditation.ts` (mail subject and body), `backend/src/validation.ts`
  (`NO_CONTROL_CHARACTERS` on `full_name` and `institution`),
  `backend/tests/routes/accreditation.test.ts` (new describe "verification mail and character
  gate"), `backend/tests/validation-accreditation-text-fields.test.ts` (new).
- `e553b3a6` backend(solutions) [skip-zone-audit]: learnings checkpoint, see the last line below.

What landed:
- Subject `PEvO - Accreditation request for @<account>`. The body opens "The Hive account
  @<account> asked PEvO to accredit it and gave this email address for verification.", then
  "Opening the link below accredits @<account> on PEvO under this name and institution:" with
  `Name:` and `Institution:` lines, the link, the 24-hour expiry, and "If you did not request
  this, ignore this email and do not open the link." `<account>` is `req.hiveUsername`, never a
  body field. The requester-typed name appears only on its labeled line. No emdash in the
  subject, the body or the new 400 message.
- `full_name` and `institution` reject Unicode Cc (C0, DEL, C1), U+2028, U+2029, U+202A to
  U+202E and U+2066 to U+2069, with 400 `BAD_REQUEST` `<field>: must not contain line breaks or
  control characters`. LRM and RLM stay allowed. `accreditationMetadataEditSchema` inherits the
  rule through `.pick()` and still accepts ordinary values.

User decisions (2026-10-06), beyond the task text:
1. Also reject the bidi embedding, override and isolate characters (U+202A to U+202E, U+2066 to
   U+2069); keep the left-to-right and right-to-left marks allowed.
2. The subject names the account (the task scoped the body only), because "Verify your
   accreditation" reads as the recipient's own pending accreditation.

Acceptance criteria:
1. "names the requesting account, the name and the institution, and tells a non-requester to
   ignore it".
2. "a line break in full_name|institution answers 400 BAD_REQUEST and sends no mail" (it.each).
3. The mail spec asserts no U+2014 in subject and body; the pre-commit anchor gate passed.

Verification:
- Red first: 39 new specs failed on the parent code (14 accept-case specs passed).
- Each file alone, `--retry=0`: `validation-accreditation-text-fields.test.ts` 50/50,
  `accreditation-metadata-edit.test.ts` 11/11, `accreditation.test.ts` 2 failed / 38 passed.
  The 2 are the per-token broadcast-attempts-cap specs; the parent commit run alone in a
  scratchpad copy fails the same 2 (2 failed / 35 passed). They are the HAF blocks-index walk
  that `backend-latest-op-haf-lookups-walk-the-blocks-index` fixes. `npm run typecheck` and lint
  on the changed files are clean.
- A verification workflow (six lenses, one refuter per finding) over `85429ce5`: enumerating
  U+0000 to U+10FFFF through both schemas rejects exactly the intended 76 code points; 17 named
  mutants were killed, including both user decisions; the regex is linear on 1 MB bodies.

Triage (user, 2026-10-06, approved as recommended). Dismissed:
- Widening a bidi range by one code point is not caught by the accept table (not a realistic
  refactor).
- `MOCK_VERIFY_SIGNATURE` equates `X-Hive-Username` with the session account, so the mail spec
  cannot tell a header-sourced mention from `req.hiveUsername`.
- Moving `validate()` after the `/request` limiter goes unnoticed by every spec.

Out-of-scope findings for follow-up filing:
- (backend, medium) Other paths put typed `full_name` / `institution` on chain without this
  rule: `SignupBodySchema` in `backend/src/routes/auth.ts` (bare `z.string().optional()`,
  broadcast at signup finalize, printed by the registration watch) and
  `adminAccreditationGrantSchema` in `backend/src/validation.ts`. `field` in
  `accreditationRequestSchema` is broadcast too and has no rule. Suggest exporting
  `NO_CONTROL_CHARACTERS` and applying it there.
- (ui, low) `handleMetadataSubmit` in `frontend/src/pages/settings.js` re-sends all three
  prefilled fields, so an account whose on-chain name or institution already holds a now-rejected
  character gets 400 on every SPA metadata edit with the generic "Please try again" (retyping the
  field clears it). `frontend/src/pages/accreditation.js` shows only "Accreditation request
  failed" for the new 400. Suggest sending only changed fields, or mapping a `full_name:` /
  `institution:` 400 to a specific message.
- (backend, low) The `backend/tests/setup.ts` docblock says "Global test setup, runs
  before/after all test files"; it is a `setupFiles` entry that runs in every test file. Narrow
  it.

## [TODO Architect] at archive

- `api-contracts/accreditation.md`, PATCH /metadata: the "Bounds mirror
  `accreditationRequestSchema`" sentence and the BAD_REQUEST bullet ("all three fields absent, or
  a field over its length bound") gain the character rule: `full_name` and `institution` reject
  line breaks, control characters and bidi embedding/override/isolate characters, message
  `<field>: must not contain line breaks or control characters`.
- `ARCHITECTURE.md` § 6.4 metadata-edit row: the same bounds addition.
- Optional: `api-contracts/accreditation.md` POST /request Errors, `BAD_REQUEST` bullet ("missing
  required fields"). It already omitted the length and email-format 400s.

Learnings checkpoint: `/ce-compound` wrote
`agents/docs/solutions/conventions/per-file-setup-redis-flush-wipes-concurrent-test-files.md`
and `/ce-compound-refresh` narrowed the determinism claim in
`cross-file-singleton-redis-key-test-isolation-2026-06-15.md` (both `e553b3a6`). The mail
content, the character set, the `.pick()` inheritance and the `validate()` envelope are carried
by the code and tests; the two broadcast-cap failures are covered by
`haf-custom-json-latest-op-materialized-fence-2026-06-14.md`. Also recommended, not run:
`/ce-compound-refresh` for `test-teardown-wildcard-delete-shared-id-band-parallel-workers-2026-06-14.md`
(scope names only per-file cleanup hooks over DB tables) and
`vitest-retry-fire-and-forget-side-effect-poisoning-2026-05-04.md` (states `retry: 1`; config
now has `retry: 3`).
