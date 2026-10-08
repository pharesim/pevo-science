## Check that a `'self'`-claim session can complete settings critical actions (archived 2026-10-08): ui fix reviewed Ready with fixes; both findings and two follow-ups folded into open tasks, five tasks filed, two dismissed

### Architect archive note (2026-10-08)

- **Review:** `/ce-code-review` full path on `8cbde35e`, `a7753a8b` and `0d80a27c` (branch-remote, a synthetic head of the task's 7 files on base `1e9b3172`): correctness, security, adversarial (in-process, no cross-model peer), testing, julik-frontend-races, project-standards, learnings. Verdict "Ready with fixes": two findings, both new in this diff and confirmed by the validator. The orchestrator re-ran the full frontend suite (98 files / 2305 tests, exit 0) and the build in an isolated copy, and checked the testing reviewer's 11 mutants against the brief (9 killed; the 2 survivors are the signal's).
- **Folded** (`b7dc4acf`): finding 1's unverified-G cell (a `'self'` set-password submit now detours through an ORCID round-trip the callback refuses, so the "map the 409" option no longer reaches a G user) and finding 2 (stale email-section lines on delete) into `ui-pending-unverified-and-no-password-set-copy`; the cross-tab subject switch during the Keychain prompt (delete and metadata edit) into `ui-keychain-broadcast-subject-teardown`; the `_performKeychainImport` "proven by the account_update sign" comment into `ui-fresh-auth-and-upload-comments-that-overclaim`.
- **Filed** (`b7dc4acf`): `backend-settings-email-status-reports-orcid` (normal; finding 1's no-row and verified-G-without-ORCID cells, user: "file a task"); `backend-light-row-keychain-session-and-signature-proof` (high; user chose option (a), the backend follows ARCHITECTURE.md § 6.4 and § 6.5 invariant #6); `backend-signature-replay-cache-keys-on-header-text` (high; pre-existing, confirmed against dhive's hex decoding); `ui-keychain-failure-copy-on-settings-actions` (normal; follow-up 4); `ui-delete-account-control-for-rows-without-email` (normal; confirmed against the template and the DELETE handler).
- **Dismissed:** `signMessage` has no timeout (follow-up 2; theoretical, no reproduction, a reload clears it); `consumeFreshAuthProof` has no registered-factor check (the factor match is checked when the proof is minted).
- **Learnings checkpoint:** the new entry `conventions/credential-skip-at-the-orchestrator-must-be-pinned-at-the-request-layer.md` and the three CONCEPTS.md edits (`21d16508`) were checked against the code by two reviewers and hold; `9274ee97` is correctly scoped; `defensive-gate-co-land-unblocking-surface-2026-05-16.md` needs no action. `/ce-compound-refresh` narrowed the replay-cache, body-hash and location claims in `hive-signature-request-binding-shape-2026-04-21.md` (`bf933549`).

**Owner:** ui
**Created:** 2026-10-05
**Priority:** high

Raised by the backend in the custody-column alignment (since archived) and
approved for filing at that task's archive. Reproduce first. This may turn out
to be a non-issue, and the task is done once that is shown.

## Why

A state-D account (ARCHITECTURE.md § 6.1: a light account upgraded through
`POST /api/custody/upgrade`, password and ORCID preserved) can still log in by
password or by ORCID. Both logins now mint the same derived claim,
`custody: 'self'`, for that account. ORCID login used to mint a stale
`'light'`, which the custody-column alignment fixed.

On the client, `frontend/src/lib/settings-fresh-auth.js` treats any
`custody !== 'light'` session as a Keychain session whose per-request
signature is itself the fresh proof, and sends no body proof. On the server,
§ 6.4 requires a body proof on the JWT path for change-email and
delete-account. `POST /api/custody/fresh-auth` refuses any session whose
claim is not `'light'` with 403, so a state-D JWT session cannot mint a
password proof there.

Whether this is a real gap depends on how a state-D session's settings
requests actually go out. If the SPA signs them with Keychain, the backend
takes the signature path, where the middleware signature is the fresh proof,
and nothing is wrong. If they go out with the JWT bearer and no body proof,
the backend refuses them, and the user cannot complete the action from that
session. Password-login state-D sessions were already in this position before
the custody-column change; ORCID-login ones joined them.

## Scope

1. Reproduce with a state-D account logged in by password, and again by
   ORCID. Attempt change-email and delete-account from settings, plus
   set-password if the account has an ORCID and no password. Record for each
   action which auth path the request took (signature or bearer), whether a
   body proof was sent, and the response.
2. If every action completes, record the evidence in this file, move it to
   `review/`, and stop. No code change.
3. If any action cannot complete, do not pick a fix on your own. The choices
   cross the client/server boundary: sign these requests with Keychain for a
   `'self'` session, route state D to the ORCID fresh-auth factor, or change
   the backend's proof rule for D. Move this file to `blocked/` with a
   `[BLOCKED by Architect]` note giving the reproduction and the options you
   see.

## Acceptance criteria

1. Every action above has a recorded reproduction for both login factors.
2. No code change lands without an architect decision, unless step 2 applies.

## Architect note (2026-10-07): widened to every `'self'` session, priority raised to high

Folded in at the archive of the state G unverified-row lifecycle task (its `[TODO UI]` item 3).
User triage: "as recommended". The priority is high because part of this is a broken flow
already shown by reading the code, not only a suspected one.

`submitEmail`, `deleteEmail` and `setPassword` in `frontend/src/api.js` all go through
`authenticatedRequest`, which sends the session JWT as a Bearer token; none of them signs with
Keychain. A Keychain user's session carries the `'self'` claim (`POST /api/auth/session`), so
these calls take the backend's JWT path:

1. **No row (pure Keychain user adding an email).** `POST /api/settings/email` answers 401
   `UNAUTHORIZED` to the add flow on the JWT path and writes no row (ARCHITECTURE.md § 6.4
   "Change email"; `api-contracts/settings.md`). A Keychain user therefore cannot register an
   email from settings.
2. **State G row whose email is unverified.** Re-issuing the link (`POST /api/settings/email`)
   and deleting the row (`DELETE /api/settings/email`) need a fresh-auth proof on the JWT path.
   The password issuer refuses the row's claim, and the row cannot acquire an ORCID while the
   email is unverified, so unless it already holds one it has no proof it can mint.
3. **State D**, as above.

Scope addition: reproduce 1 and 2 as well. Items 1 and 2 need no architect decision: § 6.4
admits those rows only on the Keychain (Hive-signature) path, so the fix is to sign these
settings requests with Keychain for a `'self'` session, as the SPA already does for
`POST /api/auth/link`. Step 3 of the Scope still applies to state D, which has factors a JWT-path
proof could use.

## UI implementation signal (2026-10-08, commits 8cbde35e, a7753a8b, 0d80a27c)

### Reproduction (Scope step 1 and the Architect note's items 1 to 3)

Run against the real backend at e07c3716: a route probe in a scratchpad copy of `backend/` with the real `verifyHiveSignature`, the real session mint routes, the real fresh-auth issue and consume, Postgres `pevo_app` and Redis DB 6. Stubbed: `hiveClient.database.getAccounts` (to publish a posting key the probe controls), the ORCID provider token exchange, the SMTP transporter, the admin broadcast and the three HAF accreditation readers. Sessions came from the real mint routes: `POST /api/auth/session` (Keychain), `POST /api/auth/login` (password), `/api/orcid/start` + `/callback` in mode `login` (ORCID). All three mint the same `{sub, custody: 'self'}` claim, and every result below was identical across the login factors a state admits. The probe rows and their audit rows were deleted afterwards.

What the SPA sent before the fix (code trace at e07c3716, confirmed after the fix in a real browser): every action went out as a bearer request with no body proof. `withSettingsFreshAuth` returned `run(undefined)` for any non-light custody, and `submitEmail`, `deleteEmail`, `setPassword` and `submitAccreditationMetadata` all used `authenticatedRequest`. The user saw only the handler's generic failure copy.

Bearer request with no proof, the shape the SPA sent:

| State (login factors) | Add / re-issue / change email | Delete account | Set password | Metadata edit |
|---|---|---|---|---|
| No row (Keychain) | add: 401 `UNAUTHORIZED` | no row; no Delete control | form renders; 401 `UNAUTHORIZED` | 401 `FRESH_AUTH_REQUIRED` |
| G, unverified (Keychain) | re-issue: 401 `FRESH_AUTH_REQUIRED` missing | 401 `FRESH_AUTH_REQUIRED` | 409 `PENDING_UNVERIFIED` | 401 `FRESH_AUTH_REQUIRED` |
| G, verified, no ORCID (Keychain) | change: 401 `FRESH_AUTH_REQUIRED` | 401 | 403 `ORCID_REQUIRED` | 401 |
| G, verified, ORCID (Keychain, ORCID) | change: 401 | 401 | 401 `FRESH_AUTH_REQUIRED` | 401 |
| D, password + ORCID (Keychain, password, ORCID) | change: 401 | 401 | section hidden; 409 `PASSWORD_ALREADY_SET` | 401 |
| D, ORCID, no password (Keychain, ORCID) | change: 401 | 401 | 401 `FRESH_AUTH_REQUIRED` | 401 |

- Password factor: `POST /api/custody/fresh-auth` answers 403 `FORBIDDEN` to every 'self' claim, including a D session minted by a password login a moment earlier.
- Signature headers only, no bearer: 200 for add, re-issue, change, delete and the metadata edit in every state with a row (S0 add: 200, writes the state G row). Bearer plus signature headers takes the JWT path and gets the same 401s.
- Set-password on the signature path: 401 `FRESH_AUTH_REQUIRED`. Its handler consumes an ORCID proof on every auth path.
- ORCID factor for a 'self' session whose row holds an ORCID: `/orcid/start` mode `fresh_auth` plus `/callback` mint a proof with mechanism `orcid`. On the bearer path with that proof: change-email, delete and the metadata edit 200; set-password 200 for D without a password and for verified G with an ORCID.
- Acceptance criterion 1 for set-password: the only D shape it applies to (ORCID, no password) cannot log in by password (`NO_PASSWORD_SET`), so it is recorded for Keychain and ORCID login. D with a password and no ORCID (D from A, or from E/F on the email path) was traced, not seeded: it has no factor on the bearer path, and ORCID login answers 404 `NO_ACCOUNT`.

### Outcome

Scope step 3 applied. The options were put to the user in session, who chose:

1. Every 'self' session signs change-email, add, re-issue and delete-account with Keychain and sends no bearer, as `adminMutation` and the IPFS pre-flight already do. A D session in a browser whose Keychain lacks the account's posting key cannot complete these, as votes and publishing already cannot there. ARCHITECTURE.md § 6.4 already admits the Keychain path for D and G on these rows, so no doc change.
2. Set-password: the Architect note's "sign these settings requests with Keychain" does not fix `setPassword`, because the handler consumes an ORCID proof on every auth path. A 'self' session now takes the ORCID round-trip light accounts use; `setPassword` stays on the bearer path with the proof.
3. The accreditation metadata edit (`PATCH /api/accreditation/metadata`), a fourth broken site no task covered, is folded in with the same fix.
4. The verified-email state hid the email section's success and error lines inside the change form, so a successful change-email and a failed delete-account showed nothing (pre-existing, light accounts too). Folded in: the lines now sit where the unverified state already places them.

Landed in `8cbde35e` (signing helper `settingsActionRequest` in `api.js`; `withSettingsFreshAuth` no longer exempts `set_password`), `a7753a8b` (State 2 message placement; comments narrowed) and `0d80a27c` (two more comment narrowings from the `/ce-simplify-code` pass). All three are on main (`git merge-base --is-ancestor` checked).

Verification:
- Frontend unit suite: 98 files, 2305 tests, exit 0. Production build clean in a scratch copy. `/ce-simplify-code`: 2 comment fixes applied, 5 findings skipped (consolidating with `adminMutation` is out of scope and its split is inverted; the proof spread is the file's idiom; test tidies low-value). Code review: deferred to the architect's `/ce-code-review` at intake, per `agents/ui/CLAUDE.md`.
- New tests: signed shape per action for a 'self' session (no Authorization, signed full `/api/...` path, method, body), `setPassword` stays bearer, light keeps bearer plus proof; the 'self' `set_password` ORCID start and cached-proof run; a template test that no email message or error line sits inside the change form.
- Real-browser click-through (vite dev, headless Chromium, every `/api` call intercepted, Keychain stubbed): change-email, add (no row), re-issue (G unverified), the metadata edit and delete went out signed with no bearer. Each signed message equals what the backend's `buildCanonicalAuthMessage` rebuilds from the wire. Set-password ran the full ORCID start, callback and resubmit, sending the bearer plus the ORCID proof. With Keychain absent or cancelled, the failure copy now shows in State 2.
- Mutation probes: 8 of 10 caught. Survivors: `=== 'self'` to `!== 'light'` (a connected store holds only `'light'` or `'self'`) and sending `JSON.stringify(body)` instead of `signed.body` (byte-identical with the real `signRequest`).
- Adversarial correctness and account-state review: no findings. Comment-truth review: five overclaims, all fixed in `a7753a8b`.

### Follow-ups for filing (out of scope; the user chose not to fold them in)

- No subject-teardown guard on the self-custody path of `withSettingsFreshAuth`. The Keychain prompt is a long await: if another tab signs in as a different user meanwhile, a successful delete then runs `removeAccountDrafts` and `disconnect()` against the new subject. `ui-keychain-broadcast-subject-teardown` covers only `broadcastWithFreshAuth`.
- `signMessage` (`keychain.js`) has no timeout. A Keychain callback that never fires leaves the settings submit and delete buttons disabled until reload. Admin actions and uploads share the gap.
- The set-password form renders where it can never succeed: no row (`GET /api/settings/email` answers `hasPassword: false`) and verified G without an ORCID (403 `ORCID_REQUIRED`). With this change a 'self' session's submit there starts an ORCID round-trip that ends in `orcid.verificationFailed`, instead of failing at once. `ui-pending-unverified-and-no-password-set-copy` covers only the 409 `PENDING_UNVERIFIED` case.
- Keychain failures (not installed, missing key, cancelled) surface as the generic "try again / contact support" copy, which is the wrong advice on a device without Keychain.
- Seen, not traced further: a light A/B/C account signing in through Keychain gets a 'self' claim, which hides the upgrade section; a C or D row with no email has no delete control; the `_performKeychainImport` docblock says the account_update signature proved Keychain, but dhive signs that op; `consumeFreshAuthProof` (metadata edit) has no registered-factor mechanism check (backend).

Learnings checkpoint: `/ce-compound` wrote `agents/docs/solutions/conventions/credential-skip-at-the-orchestrator-must-be-pinned-at-the-request-layer.md` and refined three `CONCEPTS.md` entries the same evidence contradicted (Self-custody Account, No-row Case, Per-request Hive-signature Auth) in `21d16508`; `/ce-compound-refresh` narrowed the custody posture axis of `mutation-probes-are-per-site-not-per-fix-2026-08-31.md` in `9274ee97`. Not refreshed, for the architect's call: `defensive-gate-co-land-unblocking-surface-2026-05-16.md` says its round-trip worked end-to-end, true then for light sessions only; `hive-signature-request-binding-shape-2026-04-21.md` does not say a signed request must omit the bearer (the new entry carries that rule).

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
