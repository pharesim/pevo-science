## The accreditation mail does not say which account the link accredits (archived 2026-10-06) — one round; the metadata-edit regression it exposed filed as a ui task; one solutions overclaim refreshed; contract and § 6.4 updated

### Architect archive note (2026-10-06)

- **Review:** `/ce-code-review` full path on `85429ce5` + `e553b3a6` (synthetic head excluding the sibling limiter commit `1783194b`), seven reviewers plus the validator; triage: user, "as recommended". Re-measured at `85429ce5`, each file alone with `--retry=0`: text-fields spec 50/50, metadata-edit 11/11, `accreditation.test.ts` 38 passed plus the 2 known broadcast-cap failures; red first on base (36 failed, 14 passed); 7 of 8 mutants killed, the survivor (account read from a body field) equivalent because zod strips unknown keys; the regex rejects exactly the 76 intended code points. `tests/eslint` alone: one failure identical on base (the custody-limiter companion pin, fixed by `1783194b`).
- **#1 (P2, validator confirmed):** the settings metadata edit re-sends all three prefilled values, so a stored name or institution holding a newly rejected character gets 400 on every edit. Filed `ui-accreditation-metadata-edit-sends-only-changed-fields` (normal) in `cf5254e5`, with the accreditation page's generic error and the false "backend's trim-before-validate" comment.
- **#2 (P3, validator confirmed):** the sentence `e553b3a6` narrowed in `cross-file-singleton-redis-key-test-isolation-2026-06-15.md` still said the read-pin removes `calc:version` interference; `reputation-prefix.test.ts` runs the batch unpinned. Refreshed in `7b2f1f8a`.
- **Implementer follow-ups:** filed in `cf5254e5`: `backend-accreditation-character-rule-on-other-chain-writes` (normal; signup, admin grant, `field`, plus the ORCID name the security reviewer found) and `backend-tests-setup-docblock-runs-per-file` (low). `[TODO Architect]` contract and § 6.4 edits applied in `f0717089`.
- **Dismissed:** the requester picks the account named in the subject (user decision 2; the `/verify` account-session gate, `8c5ba436`, removes the gain); space runs wrapping onto lines that look unlabeled (client-dependent, cannot precede the account sentence); "the contract does not describe the mail content" (that section never did).
- **Learnings checkpoint:** `a738f115` refreshed `vitest-retry-fire-and-forget-side-effect-poisoning-2026-05-04.md` (`retry: 1` stated, config has `retry: 3`); `test-teardown-wildcard-delete-shared-id-band-parallel-workers-2026-06-14.md` is not contradicted (it covers wildcard DB-row cleanup only). No new entry: the character set, the `.pick()` inheritance and the mail text are carried by the code and specs. The learnings reviewer's line that the body gate runs after the `/request` limiter was wrong (`validate()` runs first).

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

## The verify, signup and request surfaces explain a mailbox that already backs another account (archived 2026-10-06) — one round; two in-place fixes; release link and refusal exits folded into the release-flow task; HAF outage rule set with the user

### Architect archive note (2026-10-06)

- **Review:** `/ce-code-review` full path on `64bca0fb`, `141840d7`, `8a169708` (synthetic base excluding the unrelated `faffe9f9`), seven reviewers plus the validator. Implementer claims re-measured at `8a169708`: full frontend suite 94 files / 2251 tests, exit 0; 11 of 12 mutants killed, the survivor (handler order) equivalent because the two finalize handlers match disjoint codes; 13 keys in all 16 locales, 195 STUBS.md lines, no emdash.
- **#1 (P1, validator confirmed), filed after the user's yes:** `hasUnliftedSanction` fails closed (no HAF pool or a query error answers true), so a HAF failure at finalize answers 403 `ACCREDITATION_SANCTIONED` after the finalize UPDATE; the new `unaccredited` phase shows "not eligible" with no retry, where the old generic path reached the 1-hour stuck-resume branch on re-submit. The ui routing stays (right for a real sanction). Proposed: new backend task `backend-failed-sanction-read-is-not-a-sanction` (high): HTTP routes answer a retriable 503 on a failed read (signup finalize, `/api/accreditation/verify`, ORCID callback, metadata edit), the wot job keeps failing closed, and the accepted-tradeoff comment in `accreditation-metadata.ts` goes. Filed. The user widened the principle: every HAF outage shows an error with a retry, since without HAF data the site cannot answer. `ARCHITECTURE.md` "Data Source Policy" item 1 now says so (it used to allow empty results), and `architect-haf-outage-sweep` (normal) inventories the reads that still substitute an answer.
- **#2 (P3):** the `_isNetworkError` docblock and its spec comment said DOMExceptions carry no `.code`; fixed in place in `d3b7e34d`.
- **Implementer follow-ups:** contract "AbortError-after-success" narrowed in `a3d138f7`. The deferred release link (Scope 1) and the missing "not yours" exits in `verify.mailboxBoundMessage(Unnamed)` and `seedPhrase.unaccreditedOrcidLinked` folded into `ui-accreditation-release-flow` (scope item 4, AC5). Finalize sanction fail-closed is #1.
- **Design, applied after the user's yes:** signup plus login reveals a bound address. Under § 2 a bound address's signup creates no row, so a login with it answers 401, against 409 `PENDING_UNVERIFIED` for an unbound address's pending row. Proposed: amend § 2 and `backend-signup-finalize-claims-mailbox-binding` before it starts so the signup creates the same pending row in both cases and only the mail differs. Applied: § 2 "Light-account signup" and the task's scope 1 and AC1 (a resend sends the notice again).
- **No change:** `common.mailboxPurpose` describes the keyed hash and the one-account rule before `backend-mailbox-binding-registry` implements them; that task makes it true.
- **Dismissed:** timeout copy "Network connection lost" (the retry route is the fix; before this diff a timeout fell to the generic failure); `/link` refusal for an already-accredited Hive account (theoretical); finalize `bound_to` shown to a former mailbox holder (matches the design's notice mail); template-substring tests (11 of 12 mutants killed, AC5 E2E is the planned cover); the verify page's `console.warn` before its semantic branches (predates the diff).
- **Learnings checkpoint:** solutions/ grepped for `hasUnliftedSanction`, `DOMException`, `.code` claims and the 30s timeout name; no entry is contradicted (`reviewer-discovery-error-class-stack` already names `TimeoutError`). No new entry: #1 is the consumer-side shape `new-fail-closed-outcome-must-not-reuse-an-existing-sentinel` already describes, and the DOMException code fact is in `d3b7e34d`'s message.

**Owner:** ui
**Created:** 2026-10-06
**Priority:** high

Filed from `architect-accreditation-mailbox-binding-design` (decisions with the user, 2026-10-06).
Design: `ARCHITECTURE.md` § 2 "Credential Bindings". Backend counterpart:
`backend-mailbox-binding-registry`, `backend-signup-finalize-claims-mailbox-binding`.

## Why

`frontend/src/pages/accreditation-verify.js` renders every non-retriable error as "Verification
Failed" with a "Request New Accreditation" button, has no branch for the existing 403
`ACCREDITATION_SANCTIONED`, and reads only `res.data.username` on success. A refusal because the
mailbox backs another account would show as a generic failure that invites another attempt. The
request form says nothing about what the address is used for, and the binding's legal basis needs
the purpose stated before the address is submitted.

## Scope

1. **Verify page:** a state for 409 `MAILBOX_ALREADY_BOUND`: the mailbox already backs
   `details.bound_to`; the way through is to sign in to that account and release its
   accreditation (link to the release surface once `ui-accreditation-release-flow` lands;
   until then "or contact PEvO"). No "Request New Accreditation" button in this state. While in
   this file: a state for 403 `ACCREDITATION_SANCTIONED` without that button either, and treat
   `AbortSignal.timeout`'s `TimeoutError` as retriable like the other network errors, since the
   backend keeps the token on a timeout.
2. **Signup finalize:** when `/confirm` or `/link` answers 409 `MAILBOX_ALREADY_BOUND` (no
   session), the signup-verify page says the account was created but not accredited because the
   mailbox already backs another account, with the same way through and a sign-in link; it must
   not suggest signing up again.
3. **Request form (`frontend/src/pages/accreditation.js`) and the signup form:** one sentence under
   the e-mail field naming the legitimate interest and the right to object: the address is used to
   verify an institutional affiliation and, to prevent abuse, to keep one accredited account per
   mailbox; a keyed hash of it is stored for that purpose and the holder can object; link to the
   privacy notice route. Nothing in the UI reveals whether an address is bound: the request answer
   is uniform by design and the explanation arrives by mail.
4. New strings in `en.json`, stubbed in all 15 other locales and recorded in `STUBS.md` per the
   convention; no emdash in UI copy.

## Out of scope

- The release action itself and the admin console (`ui-accreditation-release-flow`).
- The settings e-mail flows (they never bind).

## Acceptance criteria

1. A 409 `MAILBOX_ALREADY_BOUND` on `/verify` renders the bound-account state naming
   `details.bound_to`, with no re-request button; the sanction code renders its own state.
2. A `TimeoutError` from the verify POST lands in the retry state.
3. The finalize refusal renders the created-but-unaccredited explanation.
4. The request and signup forms carry the purpose sentence and the privacy link.
5. Unit tests for the new branches; E2E for the verify state against the real backend once the
   backend task is in.

## UI implementation signal (2026-10-06, commits 64bca0fb, 141840d7, 8a169708)

Landed on main, each verified with `git merge-base --is-ancestor <sha> main`:

- `64bca0fb`: the change: both verify pages, the two form sentences, 13 keys in all sixteen
  locales, the STUBS.md sweep `### Added 2026-10-06 (ui-accreditation-binding-refusal-states)`,
  and the unit specs.
- `141840d7`: fixes from the adversarial verification (below): copy narrowed to what holds, the
  second way through, per-state copy and href pins in the specs.
- `8a169708`: `/ce-simplify-code` pass: test tables and two comments the change made false.
- Also: `db703b76` files `ui-request-and-signup-copy-promises-a-link-a-bound-address-never-gets`;
  `aa2da86e` is the learnings refresh (below).

**Decisions taken with the user before submitting:**

1. **Privacy link.** No privacy notice route exists (the privacy task is on hold), so "You can
   object to this." links to `/contact`. Swap in the notice once it ships.
2. **Finalize refusals.** The signup-verify `unaccredited` phase covers 409 `MAILBOX_ALREADY_BOUND`
   and the two finalize refusals that already exist, 409 `ORCID_ALREADY_LINKED` and 403
   `ACCREDITATION_SANCTIONED`. Before this they showed "creation failed" and sent the user back
   to the username step of an account that was already finalized.
3. **Second way through.** The finalize mailbox copy also names the design's route for a holder
   who is someone else: "If {account} is not yours, sign in to this account and request
   accreditation with another institutional address or your ORCID iD."
4. **Link-promising copy.** `accreditation.emailHint`, `accreditation.checkEmail` and
   `signup.checkEmailDescription` promise a verification link that a bound address never gets.
   Filed as a separate ui task (`db703b76`) instead of re-stubbing translated keys here.

