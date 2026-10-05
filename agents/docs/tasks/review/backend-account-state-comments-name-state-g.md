# Account-state comments that enumerate A/B/C/D predate state G

**Owner:** backend
**Created:** 2026-10-05

Surfaced by the backend in its re-review signal on the custody-column
alignment (since archived) and approved for filing at that task's archive.
Comment-only. No behaviour change is wanted.

## Why

ARCHITECTURE.md § 6.1 enumerates state G: a pure self-custody Keychain account
that acquired an `accounts` row by registering an email through
`POST /api/settings/email`'s add flow. Its `custody` is NULL, it may later link
an ORCID and set a password, and it leaves through the same deletion exit as
A/B/C/D. § 6.3 now carries G's transitions, including
`A/B/C/D/G ──settings/email DELETE──> [no row]`.

Several backend comments still restate the pre-G enumeration. A comment that
lists states closes the set it names, so each of these now asserts something
false about which rows reach the code it describes. Known sites at HEAD
(re-locate each by its quoted text, not by position):

1. `routes/orcid.ts`, in the `/start` handler: "`delete_account` action
   (right-to-erasure exit, A/B/C/D → [no row] per ...".
2. `lib/fresh-auth.ts`, two docblocks: "(the de-facto right-to-erasure exit,
   A/B/C/D → [no row] per ..." and "anonymizes the audit log, transitioning
   A/B/C/D to the no-row state".
3. `routes/settings.ts`, above `DELETE /email`: "anonymizes
   `custody_audit_log`, transitioning A/B/C/D to the no-row state".
4. `jobs/registration-watch.ts`, the module docblock's event table:
   "`registration_done` ... a row reaches a finalized state (A/B/C/D)". The
   `collectCompleted` docblock in the same file already names G and is
   correct; the table above it now disagrees with it.
5. `routes/settings.ts`, `POST /set-password`: "today only the ORCID-path
   signup/recover leaves password_hash = NULL". False today. A G row is
   created with no password, a D row finalized through `POST /api/auth/link`
   has none, and a D row upgraded from C keeps C's NULL. The handler gates on
   `password_hash` NULL with `orcid` set and on no custody state, which is
   what § 6.4's set-password row now says.

## Scope

1. Fix every site above so it is true against § 6.1 and § 6.3 as they stand.
   Prefer citing § 6.3 for the deletion exit over restating a state list: the
   restated list is the shape that went stale. Where a list is genuinely
   needed, make it the § 6.3 set (A/B/C/D/G).
2. Sweep for sites this list missed before calling the item done. At minimum
   grep `backend/src` and `backend/tests` for `A/B/C/D`, `A, B, C, D`,
   `A/B/C`, `states A`, `finalized state`, and `light account row`, and read
   each hit against § 6.1. Report what the sweep found, including hits you
   judged correct and why.
3. The `set-password` comment's purpose is to explain why the handler
   requires an ORCID. Keep that purpose; replace only the false enumeration
   of which rows carry a NULL hash.

## Acceptance criteria

1. No comment in `backend/src` or `backend/tests` asserts a finalized-state
   set or a NULL-`password_hash` population that § 6.1 contradicts.
2. No behaviour change: `git diff` touches comments and docblocks only.
3. Comment-anchor conventions hold (root CLAUDE.md "Comment anchors"): no
   task slugs, round numbers, line numbers, or bare positional anchors in what
   you write. Cite § 6.1 and § 6.3 by section, which is the established form
   in these files.

## Backend implementation signal (2026-10-05, commit d475f59c)

d475f59c verified as an ancestor of HEAD with `git merge-base --is-ancestor`. Comment-only:
a TypeScript token-stream comparison (parser leaves, comments and JSDoc excluded) of all 15
touched files against their pre-commit HEAD is identical. Typecheck and lint exit 0 (the one
lint warning is pre-existing in `author-supersession.ts`). The pre-commit hook's
`anchor_violation()` (ALLOW_MARKER set, control line fires) reports zero hits on the added
lines; `no-stale-comment-anchors` and the `updated_at` writer canary pass.

**Known sites (Why items 1-5): all fixed.**
1. `orcid.ts` `/start`: the deletion exit cites § 6.3 instead of a list, and the ORCID issuance
   side for `delete_account` is "any account with an ORCID linked" (it said "state C / state B
   / D", which also missed G).
2. `fresh-auth.ts`, both docblocks: deletion exit by § 6.3 citation, no list.
3. `settings.ts` DELETE /email: same.
4. `registration-watch.ts` event table: `registration_done` defers to section 6.1 and to
   `collectCompleted`'s best-effort note for G. The sweep also found `signup_started` "(state E
   or F)" false: `collectSignupStarted` is `WHERE id > $1` with no state filter, so the settings
   add flow's G row is announced too. Fixed, with the "because signup writes `accounts`"
   sentence after the table.
5. `settings.ts` set-password: the ORCID requirement now rests on G (a null hash with no ORCID)
   and keeps its purpose. It does not cite a `/link` D row; see the first [TODO Architect] note.

**Sweep (Scope item 2).** A five-angle multi-agent sweep over a HEAD snapshot of `backend/src`
and `backend/tests` (state letters, including every pattern the task names; null-hash
populations; custody and row-existence claims; deletion, ORCID and add-flow paths; test
headers), per-file adversarial verification and a completeness critic, then a three-lens review
of the diff (truth against § 6 and the code, mechanics, completeness). 93 judged hits plus 22
critic additions.

Fixed beyond the five (same AC1 classes):
- `set_password` described as "C → B" (`orcid.ts` `/start`, `fresh-auth.ts` union docblock):
  now C → B with G and D staying put, per § 6.3.
- set-password handler: header "Bearer JWT for light accounts", "a state-C account (null
  password_hash)", "state-C detection", "state-C / state-B distinction", and the closed-default
  "state C has no registered password factor" now speak of null-hash accounts.
- `orcid.ts` ORCID issuance for `ipfs_upload`, `edit_accreditation_metadata` and the admin
  actions: "serves state C + state B" became "any account with an ORCID linked" (D and G rows
  with an ORCID hold JWTs and mint here). The credit and consent-op comments keep C/B, because
  those ops ride the light-only broadcast.
- `orcid.ts` handleLogin: "the state-C passwordless shape" became a NULL hash on C, D and G,
  with C the steady-state carrier on the custody routes.
- `settings.ts` change-email and delete factor tables: State G row added.
- `auth.ts` /resend-verification and /login null-hash comments no longer equate a null hash with
  ORCID-only; the /login comment says the `NO_PASSWORD_SET` message's remedies fit C, not a G
  row with no ORCID. Two `custody.ts` cross-references to "the /login ORCID-only burn" now name
  `NO_PASSWORD_SET`.
- `accreditation-metadata.ts`: "a pure self-custody caller has no accounts row" became the
  no-row case affecting 0 rows, with a G caller synced like any other.
- Tests: migration 017 docblock (c) and its NULL-column seed comment cover G;
  `custody-fresh-auth-null-hash` header and seed comment name state C and drop a fictional
  "admin rolled into light-mode" path; `settings-email-delete-fresh-auth` Keychain specs stop
  calling their row state D; the `settings-set-password` ORCID_REQUIRED comment;
  `recover.test` and `auth-argon-error-translation` "ORCID-only" labels (line-number cites and a
  hold/round prefix on the touched lines dropped); the `custody.test` carve-out note drops a
  "documented-unreachable null-hash safety sentinel" that no longer exists in `custody.ts`;
  `auth.test` "finalizes the ORCID-only row" became "writes the F row".

Judged correct and left unchanged:
- `collectCompleted` docblock (already names G); `custody-claim.ts` "states A-C" / "state D"
  (it names G separately right after).
- `custody.ts` /fresh-auth and /session-auth "state A/B" versus "state C": both 403 any
  non-light claim first, so only A/B/C reach them. `orcid.ts` credit and consent-op ORCID
  issuance "C + B": light-only broadcast.
- `recover.ts` comments scoped by `upgraded_at` (state D excluded) and the ORCID-only NULL
  email; `log-pii.ts` and `signup-verify.ts` "ORCID-only accounts have password_hash NULL" are
  true statements about that origin, not closed populations.
- Tests whose state lists name exactly the rows they seed: `custody-claim.test` "light states
  A/B/C", `custody-non-consent-fresh-auth` "A/B/C/D acceptance", `custody-session-auth` "A/B/C/D
  rows", `custody-upgrade` "A/B/C/D coverage", `settings-set-password-fresh-auth` "state C →
  state B", `settings-email-fresh-auth` "Happy path C", and `settings.test`'s G add-email seed.
- The `updated_at` canary docblock already names G for both hex-token statements.

**Needs triage.** Found by the sweep, outside this comment-only task. Not fixed, not filed.

Code defects for G rows, most severe first:
1. /login pending branch (`auth.ts`): a G row with a password and an unverified settings email
   gets 409 PENDING_UNVERIFIED, and past `expires_at` the handler runs
   `DELETE FROM accounts WHERE id = $1`. That is a G → [no row] exit § 6.3 does not list,
   triggered by the owner's own login.
2. `signup-cleanup.ts`: the hourly job deletes hex-token rows past `expires_at` with no
   `username` filter, and the settings add-flow INSERT sets `expires_at`, so an unverified G row
   is reaped along with any ORCID link or password it acquired meanwhile.
3. `POST /api/auth/verify` (`signup-verify.ts`) selects by `verify_token` alone: a G row's
   settings token presented there writes `confirmed:<hex>` and `signup_binding_hash` on a row
   with `username` SET, a shape § 6.1 does not enumerate (and an expired one is DELETEd). This is
   the reverse direction of the pending settings-verify-clears-any-row-token task.
4. /resend-verification (`auth.ts`) selects by email alone, so a G row with a password and an
   unverified email gets its settings token replaced by a signup verification link (feeds 3).
5. ORCID recovery (`recover.ts`) looks up `username = $1 AND verify_token IS NULL`, which admits
   a verified G row. With an ORCID linked it passes the `upgraded_at`-only gate and gets an
   email/password rebind plus a JWT. § 6.4 limits ORCID recovery to B and C and § 6.3 has no G
   recover transition. Code gap or doc gap is the architect's call.
6. The /login `NO_PASSWORD_SET` message "sign in with ORCID or recover via seed phrase" is the
   wrong remedy for a G row with no ORCID (user-facing string; the comment now says so).
7. Already filed: the signup upsert overwriting an unverified G row (the pending
   signup-upsert-overwrites-finalized-row task). Its `auth.ts` comments were left for that task.

Comment classes outside AC1's letter:
8. JWT path equated with light accounts: `admin-roster.ts` module docblock and
   `requireFreshAdminAuth` docblock, `validation.ts` (two schema comments),
   `accreditation-metadata.ts` fresh-auth gate comment. D and G rows hold JWTs via password or
   ORCID login; the code keys on `hiveAuthMethod` and is correct. Predates G.
9. "No-row-before-JWT invariant": `settings.ts` POST /email header, handler-order item (4) and
   the add-flow guard comment, plus the `settings-email-fresh-auth.test` header and spec comment.
   False: `POST /api/auth/session` mints a JWT for a row-less Keychain caller and account
   deletion leaves earlier JWTs live, so the add-flow JWT guard is the only barrier. The guard
   exists, so there is no hole.

Test data:
10. `settings-email-delete-fresh-auth` `seedSigUser` inserts `custody = 'self'` with no
    `upgraded_at`, a pairing § 6.1 calls fictional (the route never reads it).
11. The migration 017 test title "accepts every enumerated shape: A/B/C, D, and the
    pre-finalize NULL column" is a string literal, left per AC2; its docblock and seed comment
    now say the NULL-column seed stands for G too.

[TODO Architect] ARCHITECTURE.md (not edited by backend):
- § 6.1's D row and § 6.3's `/link` line say `password_hash` and `orcid` stay NULL on the
  signup-verify(self) path. The `/link` finalize UPDATE writes neither column, so a `/link` D
  keeps its E/F row's password (email path) or ORCID (ORCID path). Why item 5 inherited the
  claim, which is why the set-password comment cites only G. § 6.4's set-password row also omits
  the eligible ORCID-path `/link` D.
- § 6.4 "Issue fresh-auth proof" rows say "A or B" and "B or C", while their parentheticals
  ("states with password/ORCID registered") also cover D and G rows that carry those factors.
  The change-email and delete rows' per-state availability omit G.
- § 6.2 has no G entry, and its no-row "no PEvO-server session is involved" is contradicted by
  `POST /api/auth/session` (item 9).
- If unverified-G expiry (item 2) is intended housekeeping, § 6.3 needs that transition.

## Architect re-review (2026-10-05) — HELD PENDING FIXES:

`/ce-code-review` on d475f59c (correctness, project-standards, testing, security, adversarial,
learnings; one validator batch). AC2 and AC3 hold. Two comment lines this diff wrote close a set
the code leaves open, and one of them is AC1's remaining miss. Both are comment-only; AC2 still
binds the fix.

1. **`settings.ts`, both fresh-auth factor tables (the POST /email header and the DELETE /email
   header): the new State G line promises a password leg no route can mint.** "whichever
   password/orcid factors it has" is true only of the consume-side mechanism check. On the JWT
   path a G row cannot obtain a password-mechanism proof: `custodyClaimFor` resolves its NULL
   `custody` to `'self'`, and `POST /api/custody/fresh-auth`, the only password-mechanism issuer,
   answers 403 to any non-light claim. Its one JWT-path factor is ORCID, when linked (ORCID
   issuance in `routes/orcid.ts` has no custody gate). The pre-existing State D line in both tables
   ("preserved password/orcid factors") overstates the same leg for the same reason (a D row's
   claim is `'self'` too). Fix both lines in both tables so each says what the row can present on
   the JWT path: ORCID when linked, because the password issuer refuses a non-light claim. If you
   find a password proof minted while the row was still light can be consumed after the upgrade,
   say so on the D line; otherwise leave it out.
2. **`tests/routes/auth.test.ts`, the ORCID-only signup comment: "(state F, which signup-verify
   later finalizes to C)" closes F's finalize set.** An F row also finalizes to D through
   `POST /api/auth/link` (§ 6.3's signup-verify(self) line; the `/link` lookup is by
   `verify_token` alone). Name both: C through `/confirm`, D through `/link`.

Not held here (triaged with the user 2026-10-05):
- The set-password comment ("Only ORCID-verified accounts can opt into password login") is false
  today because `POST /api/auth/reset` writes a password onto any row with an email, a G row with
  no ORCID included. The pending password-reset gating task's default rule (reset never adds a
  password) makes it true; a note there covers the comment if that rule changes.
- The signal block's [TODO Architect] notes: the architect is correcting ARCHITECTURE.md § 6.1 to
  § 6.4 in a separate commit.
- The signal block's "Needs triage" items 1-11: filed by the user as the state-G unverified-row
  lifecycle task, plus a note on its item 10 about the `NO_PASSWORD_SET` comment's
  exception list.
- registration-watch announcing G rows as "Signup started / Email + password", with their email
  sent to the operator Discord: filed as a new backend task.

## Backend re-review signal (2026-10-05, commit 49aa2c65)

49aa2c65 verified as an ancestor of HEAD with `git merge-base --is-ancestor`. It is comment-only:
a TypeScript token-stream comparison of both files at 49aa2c65^ and 49aa2c65 is identical.

1. **`settings.ts`, both factor tables (POST /email and DELETE /email headers).** Each line now
   says what the row can present on the JWT path.
   - The D line: "'orcid' when linked. The password issuer refuses a non-light claim; a
     password proof minted while the row was still light stays consumable until it expires
     (the upgrade sweeps session proofs only)".
   - The G line: "'orcid' when linked (the password issuer refuses its non-light claim)".
   - Why the D-line clause holds: the upgrade calls `invalidateSessionFreshAuthTokens`, which
     sweeps only the session-kind index, and stamps `sessions_invalidated_at`, which revokes
     JWTs but is not read by the consent-kind consume. A D row keeps its password, so a
     `change_email` or `delete_account` password proof minted just before the upgrade passes
     the settings mechanism check within its 5-minute TTL, given a JWT issued after the
     upgrade. The user triaged this residual as note only.
2. **`tests/routes/auth.test.ts`.** The ORCID-only signup comment now says F finalizes to C
   through `/confirm` or to D through `/link`.

d33792ce, committed alongside under the state-G lifecycle task, edits other parts of
`settings.ts` but neither of these tables.
