## Other accredit-op writers accept line breaks and control characters (archived 2026-10-08): clean backend review; one ui follow-up filed, contract docs updated in place, three residuals dismissed

### Architect archive note (2026-10-08)

- **Review:** `/ce-code-review` full path on `706cb11c`, `36d54084` and `fd7f0fab` (branch-remote, a synthetic head of the task's 8 files on base `9084f619`): correctness, security, adversarial (in-process, no cross-model peer), testing, project-standards, api-contract, learnings. Verdict "Ready with fixes" on one UI-side finding; the backend change meets every scope item and AC. Testing re-ran the four spec files alone at `fd7f0fab` (124/124, 51/51, 113/113, auth 35/36 with the known JWT timeout) and killed 11 of 11 mutants. Security, on PostgreSQL 16.13: of the 2,124 code points the rules reject, the jsonb input refuses exactly U+0000 and the 2,048 surrogates, and every accepted code point survives `JSON.stringify` plus `::jsonb`. No body-parser bypass, and no transform between validation and broadcast recreates a refused value.
- **Filed:** `ui-signup-character-rule-refusal-shows-institutional-message` (normal): the signup page shows `signup.orcidOrInstitutional` for the new 400 (validator confirmed).
- **In place:** `acb140b3` updates the contract and architecture docs (the signal's four TODOs, a new `POST /api/admin/accreditation/grant` section, a `hive-schemas.md` field note, and the `/signup` non-institutional refusal corrected to 422 `VALIDATION_ERROR`). `f31ebaec` adds `field:` 400s to `ui-accreditation-metadata-edit-sends-only-changed-fields` and replaces the read-side task's claim that this task closes PEvO's own write paths with a pointer to `backend-platform-signed-ops-carry-unchecked-client-text`.
- **Dismissed:** the author retract reason in an admin-signed op (owned by `backend-platform-signed-ops-carry-unchecked-client-text`, filed during the review); a truthy non-string ORCID name throwing before the mode switch (theoretical: ORCID returns a string or null); the new solutions entry's process narrative (none of the classes root CLAUDE.md bans).
- **Learnings checkpoint:** the learnings reviewer found no entry the change contradicts or that now overclaims. The new entry `conventions/tightened-validator-misses-values-stored-before-the-deploy.md` was checked against `fd7f0fab` by two reviewers and holds. No refresh or new entry ran.

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

## Port the after-close brace rule into the frontend enclosingSymbol walk, and correct its docblock (archived 2026-10-08): clean review; three residuals dismissed, the backend twin list folded into the open backend docblock task, one low ui follow-up filed

### Architect archive note (2026-10-08)

- **Review:** `/ce-code-review` full path on `78abead8` and `a2085733` (branch-remote, base `a5b139f5`): correctness, adversarial (in-process, no cross-model peer), testing, project-standards, learnings. Verdict "Ready to merge", 0 findings; AC1 to AC5 met. The orchestrator ran the full frontend unit suite at `a2085733` in an isolated copy (91 files / 2135 tests, exit 0) and checked the testing mutants against the brief (5 of 6 killed; the survivor is the `!inTemplate` guard, a hardening candidate). Correctness: the four table rows resolve to module scope in both copies, and a 150k-file differential found 0 divergences outside template-literal declarations. Adversarial: a base-vs-head A/B over `frontend/src`, `backend/src` and both test trees gives 0 symbol, region and comment diffs.
- **Dismissed:** R1, the line-leading close arm has no template guard (it matches the backend rule, fails closed against the current allowed maps, and neither tree has the shape); R2, the `isCommentLine` clause "a member the consuming set-equality can see" (it says a key is minted and weighed, not that the check fails closed, which is true); the missing probe for re-entry after an untracked close (covered by the 2026-10-05 dismissal of that mutant).
- **Folded:** the signal's seven backend twin sentences into `backend-enclosing-symbol-brace-gloss-and-suite-citation` as items 3 to 9, each checked against the backend code at `5404b32c`.
- **Filed:** `ui-enclosing-symbol-planted-probe-sentence-names-own-suite` (low), the frontend twin of that backend task's item 2.
- **Learnings checkpoint:** no solutions entry is contradicted. The composite-probe entry enumerates the tracked-region decision points, which the port left unchanged, and the fail-closed entry already sends the reader to each copy's own SET-EQUALITY bullet. Nothing for `/ce-compound` or `/ce-compound-refresh`.

**Owner:** ui
**Created:** 2026-10-05
**Priority:** low

Routed out of the architect re-review of `backend-enclosing-symbol-port-backreference`
(archived 2026-10-05). The two enclosing-symbol copies stay separate by ratified decision
(dialect divergence, no shared module). This task brings the shared brace walk back in
line where the backend copy moved, and fixes three frontend docblock statements.
User decision 2026-10-05: port the rule rather than decline it.

## Why

1. **The brace walks split at a comment close.** Since `146ce7de` (2026-10-01) the
   backend `enclosingSymbol` in `backend/tests/support/enclosing-symbol.ts` reads a
   comment close that begins its trimmed line even when no tracked region is open, and
   takes a `}` leading the code after any close it reads, at any indentation
   (`afterClose || indentOf(line) <= declIndent`). The frontend walk in
   `frontend/tests/unit/eslint/enclosing-symbol.js` only takes a `}` at or left of the
   declaration's indentation. Measured on both files at HEAD `9e731556`:

   | Shape (target line after the block) | Correct | Backend | Frontend |
   |---|---|---|---|
   | `ok(); /* note` then `  */ }` ending the function | module | module | inner (INWARD) |
   | `/* note` then `   */ }`, indented right of the declaration | module | module | inner (INWARD) |
   | `   */ }` closing an inner `if`, target still inside `f` | `f` | module (OUTWARD) | `f` |
   | control: `*/ }` at the declaration's indentation | module | module | module |

   INWARD is the direction a set-equality canary absorbs silently when the inner
   declaration is a licensed key. OUTWARD fails closed unless the allowlist holds the
   enclosing scope. The backend took the third row's OUTWARD cost on purpose, and its
   docblock's OUTWARD bullet names it ("a `}` after a read close ends the declaration even
   where it really closes an inner block"). No line in `frontend/src` or `backend/src`
   has a line-leading comment close followed by code today, so the exposure is latent.
