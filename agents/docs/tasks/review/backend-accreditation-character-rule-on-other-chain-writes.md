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

## Backend implementation signal (2026-10-08, commits 706cb11c, 36d54084; learnings fd7f0fab)

Each SHA self-verified with `git merge-base --is-ancestor <sha> main`.

**What landed, per scope item**

1. Scope 1. `validation.ts` exports `accreditOpText(schema)`, which adds both character rules to
   a string schema: `NO_CONTROL_CHARACTERS` (unchanged) and the new `NO_LONE_SURROGATES`
   (message `must be well-formed Unicode text`). It is applied to `full_name`, `institution` and
   `field` in `accreditationRequestSchema` (`field` is new; the metadata edit inherits all three
   through `.pick()`), `adminAccreditationGrantSchema` and `SignupBodySchema` (`routes/auth.ts`).
   **Deviation from the literal wording** ("Export `NO_CONTROL_CHARACTERS` and its message"): every
   covered field now takes two rules, so the shared export is the helper and the regexes and
   messages stay module-private. No caller outside `validation.ts` needs the constants.
   Wire behavior: `/request`, `/metadata` and the admin grant answer 400 `BAD_REQUEST`
   `<field>: must not contain line breaks or control characters` or `<field>: must be well-formed
   Unicode text` through `validate()`. `/signup` answers its existing 400 `VALIDATION_ERROR`
   `Invalid request body` (that route does not echo zod issues).
2. Scope 2, decision: **the ORCID profile name is rewritten, not refused.** `toAccreditOpText`
   (`validation.ts`) turns each run of Cc / U+2028 / U+2029 characters into one space, drops
   U+202A to U+202E, U+2066 to U+2069 and unpaired surrogates, and trims. The `/callback` applies it
   once before dispatch, so `handleSignup`'s response `name`, the `orcid_verified` stored name
   (the `/signup` fallback `full_name`) and `handleAccredit`'s op `name` all carry the rewritten
   value. A name with nothing left falls back to the username (`orcidName || username` in
   `handleAccredit`; `account.full_name || username` at signup-verify). Why: the name is not typed
   into a PEvO form, so a refusal leaves the user no fix inside PEvO, and dropping the whole name
   for one stray character loses a correct name. Fuzzed: 200,000 random strings built from the
   rules' edge code points; every output passes `accreditOpText(z.string())`, and an already-valid
   input changes only by trimming.
3. Scope addition (lone surrogate). `NO_LONE_SURROGATES = /^[^<U+D800>-<U+DFFF>]*$/u` (written with
   `\u` escapes in source): under the `u` flag a pair reads as one astral code point, so only an
   unpaired half is rejected. Checked read-only on the local PostgreSQL 16: the jsonb casts of
   `"\ud800"`, `"\udc00"` and `"\u0000"` error, and a surrogate pair parses.

**Acceptance evidence**

- AC1 and the AC addition. Signup, route level (`auth.test.ts`, "POST /api/auth/signup: character
  rules on full_name, institution and field"): a line break, U+0000 and a lone surrogate in each of
  the three fields answer 400 `Invalid request body`; Arabic, Japanese and Spanish values pass the
  body parse (they reach `Email is required`, so no DB write). Admin grant, route level
  (`admin-endpoints.test.ts`): the same 9 cases answer 400 with a `<field>:` message and no
  broadcast; non-Latin values are broadcast unchanged. Request schema, schema level
  (`validation-accreditation-text-fields.test.ts`): the full rejected set, now including both
  surrogate halves, on all three fields, plus the metadata edit's inheritance. ACCEPTED adds a
  surrogate pair, Hangul (below the surrogate block) and fullwidth punctuation (above it).
- AC2: `orcid.test.ts` "ORCID profile name rewritten to pass the accredit-op character rules".
  A name carrying RLI/PDI, CRLF and an unpaired surrogate comes back as `Jane Smith` in the signup
  response and in the stored `orcid_verified` value, and as the accredit op's `name`; a name with
  nothing left gives `alice` (the username).
- AC3: the one new response string, `must be well-formed Unicode text`, has no emdash. The
  pre-commit anchor gate passed on all three commits; `tests/eslint` 146/146.

**Verification**

- Red first: every new spec failed against the pre-change code for the expected reason (signup 9,
  admin 9, validation 56, orcid 3).
- Touched files: validation 116/116, admin-endpoints 51/51, orcid 113/113 at 706cb11c; auth 36/36
  alone. Its "accepts valid Bearer JWT" spec times out intermittently on
  `GET /api/notifications?since_block=1`: item 3 of
  `backend-route-test-isolation-and-a-notifications-timeout`, untouched here. At 36d54084:
  validation 124/124 plus `tests/eslint` 146/146. Typecheck (src and tests) and eslint on the
  touched files are clean.
- Full suite at 706cb11c, run while the verification workflow's probes loaded the same stack: exit 1,
  13 files / 22 specs red. Standing red bar: `idempotency-real-haf` 2, `accreditation-idempotency` 6,
  `papers-enrichment-parity-gate` 1, `profile-auth-bypass` 3, `reviews` 2,
  `cast-hardening-author-index-weight` 1. Green when re-run alone: `notifications`, `profile`,
  `signup-verify-orcid-binding-guard`, `signup-verify-concurrent-activation`, `auth`. Red alone and
  identically on a `706cb11c~1` copy, so not this change: `lib/bridge-queue` 1 (`leaseNextEntry`
  reads leftover queue rows in the shared database), `lib/cache` 1 (a different single-flight spec
  each run).
- Verification workflow (path completeness, comment truth, spec mutation kill; one refuter per
  finding; probes on `git archive` copies): 22 mutants, 21 killed. The survivor, a widened
  surrogate range, is killed by the 36d54084 ACCEPTED entries. All seven accredit-op builders were
  traced (`/verify`, `PATCH /metadata`, admin grant, `broadcastAccreditationAndSeed`,
  `handleAccredit`, `handleLink`, `broadcastWotAccreditation`); every request- and ORCID-sourced
  value now passes a rule. `handleLink` and the metadata edit's `prior.*` carry chain values forward
  (out of scope), and WoT uses the validated vouchee name and constants. One comment defect was
  fixed in 36d54084 (the `NO_LONE_SURROGATES` comment said the negated class "matches only an
  unpaired half"). A "dropped mail rationale" finding was refuted: `accreditation.test.ts` "POST
  /api/accreditation/request — verification mail and character gate" pins it.
- Simplify: skipped, under the 30-line threshold (about 25 substantive code lines in three src files).
- Code review: left to the architect's intake review, per the backend protocol.

**Decision (user, 2026-10-08): values stored before the deploy.** `/verify` broadcasts the pending
fields from a Redis token (24h) written under the old rule, and that token can hold a U+0000 or
lone-surrogate escape. Signup `/confirm` and `/link` broadcast from pending `accounts` rows (up to
30 days), and `orcid_verified` nonces last 30 minutes. Those Postgres-stored values cannot hold NUL
or a lone surrogate, so they carry no jsonb risk. A read-only check on this stack before deciding
found 0 `pending_accred` keys, 0 `orcid_verified` keys, 0 pending signup rows, and 0 `accounts`
rows with a rule-violating character. The user chose: **accept the window and redeploy soon**,
with no broadcast-time re-check.

**[TODO Architect] contract and architecture notes** (outside the backend zone):

- `api-contracts/accreditation.md`: the `/request` `BAD_REQUEST` bullet, the `/metadata` bounds
  paragraph and its `BAD_REQUEST` bullet name only `full_name`/`institution` and only the
  control-character message. `field` is covered too now, and all three also refuse an unpaired
  surrogate with `<field>: must be well-formed Unicode text`.
- `ARCHITECTURE.md` § 6.4, the `PATCH /api/accreditation/metadata` row: same correction.
- `api-contracts/auth.md`, `/signup` `VALIDATION_ERROR`: add the character rules on
  `full_name`/`institution`/`field` (message `Invalid request body`).
- `api-contracts/orcid.md`, `/callback`: the profile name is rewritten (rule in item 2) before it is
  returned, stored and broadcast; an empty result makes the accredit op use the username.

**Out-of-scope observations, for filing**

- Other admin-key-signed ops carry client text with no character rule.
  `POST /api/papers/:author/:permlink/retract` takes `reason` as `(req.body.reason as string) || ''`
  from the paper's author and broadcasts it through `broadcastAdminCustomJson`. The admin sanction,
  retract and authorship-revoke `reason` fields have only `max(500)`. The admin grant's `account`
  (`hiveAccount`) has no Hive-name format check. Each can put a U+0000 or lone-surrogate escape into
  an authority-signed custom_json; only the read-side task covers that today.
- Light-account custody `custom_json`: the server signs the client's json text as given (read-side
  task).
- `SignupBodySchema` `full_name`/`institution`/`field` have no length bounds (the request and grant
  schemas allow 200/200/100), and the ORCID name is unbounded. That is a length rule, outside this
  task.
- `toAccreditOpText(tokenData.name || '')` throws (a generic 500) if ORCID ever returns a truthy
  non-string name. ORCID's API returns a string.

**Learnings checkpoint:** existing entries naming the touched symbols
(`account-keyed-limiter-after-auth-validator-before-limiter.md`,
`postgres-e-string-backslash-v-not-recognized-2026-05-20.md`) still hold, so no refresh ran.
`/ce-compound` wrote `conventions/tightened-validator-misses-values-stored-before-the-deploy.md`
(fd7f0fab).
