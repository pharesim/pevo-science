# Check that a `'self'`-claim session can complete settings critical actions

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
