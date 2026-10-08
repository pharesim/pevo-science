## The email-change link rewrites other users' digest addresses (archived 2026-10-08): clean review of the username-scoped digest move

### Architect archive note (2026-10-08)

- **Review:** `/ce-code-review` full path on `f96090c4` (branch-remote, base `e72a99b8`): correctness, security, adversarial (in-process, no cross-model peer), testing, project-standards, learnings. Zero findings. The testing reviewer reproduced 26 passed with 0 skipped and killed 6 of 6 mutants: the four in AC2, plus `RETURNING email` without the username and `$3` bound to `oldEmail`. The orchestrator re-ran `npm run typecheck`, eslint on both files and `tests/eslint` (146 passed), all exit 0.
- **Noted, no action:** the pending `backend-email-change-hold-and-owner-notice` moves this swap and the prefs move into its apply function, which its sweep also runs. The moved statement carries both predicates, and the V/X route spec catches a dropped username predicate on the route path. A sweep-path spec for it would be preemptive hardening.
- **Pre-existing, left as recorded in the Notes and signal block:** the swap and the move are two statements with no transaction; a mixed-case own prefs row does not move; both recovery paths leave the prefs email alone.
- **Learnings checkpoint:** a grep of `agents/docs/solutions/` for `notification_preferences` finds no entry, and `mailed-credential-token-dies-with-its-address-and-credential.md` stays accurate (the swap's SET list and key are unchanged). No new `/ce-compound`: the username predicate and the commit message carry the lesson.

**Owner:** backend
**Created:** 2026-10-06
**Priority:** high

Filed at the user's request from the pre-existing findings in the signal block of
`backend-settings-verify-clears-any-row-token` (its items 1 and 3), after a scoping pass that
measured both on 02c66d99 through the real routes.

## Why

After the swap, the change branch of `GET /api/settings/email/verify/:token` (`routes/settings.ts`)
moves the digest address with

```
UPDATE notification_preferences SET email = $1 WHERE email = $2
```

The new address comes from the swap's `RETURNING email`, and the old one from the change-branch
lookup. There is no username predicate. Every other writer of `notification_preferences` is keyed
on username: the `PUT /api/profile/:username/notification-preferences` upsert, the unsubscribe
route, `digest.ts` `updateLastDigestBlock`, and the `DELETE /api/settings/email` erasure.

`notification_preferences.email` is an address the user sets, not a mirror of `accounts.email`.
The table is keyed `username TEXT PRIMARY KEY`, and `email` is nullable with no UNIQUE.
`PUT /api/profile/:username/notification-preferences` stores any syntactically valid address
without verifying it. Any Hive account holder can write their own row on the signature path,
with no `accounts` row.

**Disclosure (measured).** X sets its prefs email to V's current account address A0. V verifies
an email change to A. X's row now holds A, and `GET /api/profile/X/notification-preferences`
returns it to X. So anyone who knows a user's address learns every new address that user
verifies, including a user who changes address to get away from someone. It also works as a slow
membership check: a guessed address in your own prefs row changes only if it was an account
email whose owner changed it.

**Misdirected digest (code reading).** `digest.ts` `getDigestUsers` mails each row's `email`. A
third user whose digest address equalled V's old address therefore gets their digest sent to V's
new mailbox. That needs the digest scheduler running (it starts only when SMTP is configured),
`email_digest` true, and a prefs row written by a direct API call, since no frontend code calls
the prefs endpoints today.

**Nothing pins the move.** Feeding it `[oldEmail, oldEmail]`, or deleting it, keeps every spec
that hits the route green: `tests/routes/settings.test.ts` and
`tests/routes/settings-state-g-unverified-email.test.ts` (measured).
`frontend/tests/e2e/settings.spec.js` follows the link but asserts only `accounts` columns.

## Scope

1. Add `username` to the swap's `RETURNING` and scope the move to that account:
   `UPDATE notification_preferences SET email = $1 WHERE email = $2 AND username = $3`, bound to
   the swapped row. Keep `email = $2`: the verifying account's own digest address moves only when
   it was the old account address, and a digest address set separately stays.
2. Narrow the comment above the move to what the code does. No new response, status or error
   code.
3. Specs in `tests/routes/settings.test.ts`, next to "verify token - change flow". Seed by INSERT
   against real Postgres. The route has no auth middleware, so no mock is needed.
   - V has a pending change. Prefs rows: V holds V's old account address, and X (no `accounts`
     row) holds the same address. After the 200, V's prefs email is the new address and X's is
     unchanged.
   - A second account W with a pending change, whose prefs email differs from its old account
     address, keeps that prefs email after its link verifies. This case pins `email = $2`.

## Acceptance criteria

1. The move carries a username predicate bound to the swapped row.
2. The specs above. The signal block carries mutation evidence from a scratch copy:
   - fails on HEAD's unscoped UPDATE (X's row moves);
   - fails with the move fed `[oldEmail, oldEmail]` or deleted (V's row stays);
   - fails with `email = $2` dropped (W's row is overwritten);
   - passes with the fix.
3. The diff changes no `sendOk` or `sendError` call and no status in the handler.
4. `tests/routes/settings.test.ts` and `tests/routes/settings-state-g-unverified-email.test.ts`
   are green by exit code and the Errors line. tsc and eslint are clean.

## Notes

- Account-state check: the change branch reaches only rows that carry a `pending_email_token`.
  Only `POST /api/settings/email` writes one, on a row it found by username (states A, B, C, D
  and G per ARCHITECTURE.md § 6.1). The swapped row always has a username, so the new predicate
  defends no fictional state.
- Overlap: the same swap UPDATE is edited by `backend-reset-tokens-outlive-email-changes-and-recovery`
  (Scope item 2, the `reset_token` clear) and by `backend-email-change-swap-500s-on-a-taken-address`.
  These are adjacent edits, and whichever lands second merges onto the other. This task builds on
  the token-keyed swap from 02c66d99, which is in review: if that review reshapes the swap,
  re-anchor the username source.
- Out of scope, reported as fact: both recovery paths (`POST /api/auth/recover`,
  `POST /api/auth/recover/verify`) move `accounts.email` but leave the prefs email alone. After a
  recovery away from a compromised mailbox, a digest address equal to it keeps mailing it. That is
  not this defect (no cross-account write). File it separately only if the user wants recovery to
  carry the digest address.
- `PUT /api/profile/:username/notification-preferences` accepting an unverified address is a
  separate property, covered by `architect-audit-admin-profile-search-routes`.
- Rows already rewritten on a deployment cannot be told apart from addresses users set
  deliberately. No repair is proposed.
- The prefs email is stored as typed and the account email is lowercased, so a mixed-case own row
  does not move on a change. This is pre-existing and not proposed for change.

## Architect note (2026-10-08): the swap moves into an exported apply function

`backend-email-change-hold-and-owner-notice` (high, filed 2026-10-08) splits the change branch of
`GET /api/settings/email/verify/:token` into an exported apply function that is the one site
swapping the address, and `backend-email-changed-at-stamp-and-displaced-address-notice` (high)
adds `email_changed_at = NOW()` to the same UPDATE. Land this task first if you can; otherwise
merge the username-scoped `notification_preferences` move into the apply function, after the
swap and before the displaced-address mail.

## Backend implementation signal (2026-10-08, commit f96090c4)

- Landed in `f96090c4` (`backend(settings): an email change moves only the verifying account's
  digest address`), ahead of the hold and `email_changed_at` tasks, so nothing needed merging into
  an apply function. Self-verified: `git merge-base --is-ancestor f96090c4 main` exits 0, and
  `git show --name-status f96090c4` lists `M backend/src/routes/settings.ts` and
  `M backend/tests/routes/settings.test.ts`.
- Scope 1: the swap returns `email, username`, and the move is
  `UPDATE notification_preferences SET email = $1 WHERE email = $2 AND username = $3`, where `$3`
  is the swapped row's username. `email = $2` is kept.
- Scope 2: the comment above the move now reads "This account's digest address follows the change
  when it equals the old account address." No `sendOk` or `sendError` call and no status changed
  (AC3).
- Scope 3: two specs in `tests/routes/settings.test.ts` after "verify token - change flow":
  "verify token - change flow moves only the verifying account's digest address" (V, plus X with
  no `accounts` row) and "verify token - change flow keeps a digest address set apart from the
  account email" (W). Both seed by INSERT against real Postgres and delete their rows in `finally`.
- AC2 mutation evidence, from a `git archive f96090c4` copy on Redis DB 6, whole
  `settings.test.ts` per variant:
  - parent's unscoped UPDATE: exit 1, the V/X spec fails, X's row received
    `settings_digest_v_new_*` (it moved);
  - move fed `[oldEmail, oldEmail, username]`: exit 1, the V/X spec fails, V's row stays
    `settings_digest_v_old_*`;
  - move deleted: exit 1, the V/X spec fails, V's row stays `settings_digest_v_old_*`;
  - `email = $2` dropped (`WHERE username = $2`, params renumbered so the SQL stays valid): exit 1,
    the W spec fails, expected `settings_digest_w_own_*`, received `settings_digest_w_new_*`;
  - the fix: exit 0, 26 passed.
  The V/X spec was also red in the live checkout before the fix (X's row moved).
- AC4: `tests/routes/settings.test.ts` with `tests/routes/settings-state-g-unverified-email.test.ts`
  gives Test Files 2 passed, Tests 39 passed, exit 0, no Errors line. `npm run typecheck` exits 0,
  eslint on both changed files exits 0, and `tests/eslint` gives 9 files, 146 passed, exit 0. The
  other two files that drive the route (`recovery-and-reset-drop-queued-email-change.test.ts`,
  `reset-token-cleared-by-account-writes.test.ts`) give 12 passed, exit 0. Full backend suite not
  run: the change is confined to one handler, and the suite has a standing red bar.
- Supplementary adversarial review (two lenses on `f96090c4`, correctness/conventions and spec
  quality, each re-running the mutations in its own copy): zero findings. The backend does not run
  `/ce-code-review`; that is the architect's at intake.
- Out of scope, reported as fact (pre-existing, not touched): the swap and the digest move are two
  statements with no transaction around them. If the move throws after the swap commits, the client
  gets a 500, a re-click gets `INVALID_TOKEN`, and the digest address stays on the old address. If
  this should close, the apply function from `backend-email-change-hold-and-owner-notice` is where
  both statements will sit.
- No `[TODO Architect]` contract change: no response shape, status or error code changed.
- Learnings checkpoint: a grep of `agents/docs/solutions/` for `notification_preferences`,
  `getDigestUsers` and "digest address" found no entry, so nothing to refresh. Nothing new
  qualified, since the username predicate and the commit message carry the lesson.

## /verify tells a WoT enrollee below the threshold that they are accredited (archived 2026-10-08): clean re-review of the ORCID-carry fix; docs and the latest-action-wins entry updated, five residuals dismissed

### Architect archive note (2026-10-08)

- **Review:** `/ce-code-review` full path on `925024f7` and `851fe922` (branch-remote, base `5184c970`): correctness, security, adversarial (in-process, no cross-model peer), testing, project-standards, learnings. Zero findings. Hold item 1 is fixed: the email op carries the latest `wot` op's ORCID from the chain, never `pending.orcid`. The testing reviewer reproduced the signal's counts and killed 7 of 7 mutants; an orchestrator mutant dropping the gate's authority filter fails only the unit SQL-shape spec.
- **Done at archive:** `eed87d44` (ARCHITECTURE.md section 2 email-pin paragraph; the "Released" and "Credential Bindings" `/verify` sentences narrowed; `api-contracts/accreditation.md` `already_accredited` paragraph and PATCH `/metadata` intro); `31503ef1` (latest-action-wins entry rewritten in place, user-approved; CONCEPTS.md "Accreditation Method"); the real-HAF discovery task's quoted spec name now ends "misses".
- **Recorded with the accepted residual:** a `handleLink` rebind that lands between the `/verify` gate read and the email op is overwritten by the email op's older ORCID; a re-link repairs it.
- **Dismissed (user, as recommended):** the WoT auto-accredit broadcasting over a first authority accredit HAF has not indexed (pre-existing, limited to HAF lag, already stated under ARCHITECTURE.md "WoT auto-accreditation"); `handleLink` or PATCH `/metadata` re-writing `method: 'wot'` before the pin is indexed; a typeless revoke after an ORCID-holding accredit (no writer emits one, none under `pevotest`); the authority filter pinned only by the SQL-shape spec; the pre-existing `Round-1 hold item N` and slug labels in the test files.
- **Learnings checkpoint:** `/ce-compound-refresh` on `accreditation-state-read-latest-action-wins-2026-05-15.md` (rewritten); no new `/ce-compound`, since the ORCID carry-forward rule is in ARCHITECTURE.md "Credential Bindings".

**Owner:** backend
**Created:** 2026-10-05
**Priority:** high

Filed from the accreditation and Web of Trust audit (finding 1). Seven reviewers reported it and
the validator confirmed it from the code. Incidence was not measured.

**Sequencing:** `backend-latest-op-haf-lookups-walk-the-blocks-index` rewrites the same query.
Take that task first. If it is not archived when you pick this one up, stop and say so.

## Why

`POST /api/accreditation/verify` calls `findExistingAccreditation`
(`backend/src/lib/idempotency.ts`) before anything else that reads the chain. That helper returns
a hit whenever the account's latest authority-signed op among `accredit` and `revoke` is an
`accredit`, whatever its `method`. On a hit the route writes the completion record, which deletes
the pending token, and answers 200 "Accreditation confirmed" with `outcome: 'already_accredited'`.
It broadcasts nothing.

For an account in the "Below-threshold (WoT)" state of `ARCHITECTURE.md` § 2, the latest op is a
`method: 'wot'` accredit and the account is not accredited: `active_accreditations` drops a `wot`
row that does not meet the live vouch threshold. A user in that state who verifies an
institutional email is told they are accredited, loses the token, and stays unaccredited.
`POST /api/wot/retract` broadcasts no revoke, so ordinary retractions lead there.

**Decision (user, 2026-10-05):** an email verification makes any WoT enrollee authority-pinned,
whether or not the account currently meets the threshold.

## Scope

1. The gate short-circuits only when the latest op is an `accredit` whose method is not `wot`.
   Use `IS DISTINCT FROM 'wot'`, the test `auth_accredit` applies in `activeAccreditationsCteBody`
   (`backend/src/hafsql.ts`). When the latest op is a `wot` accredit, `/verify` goes on to the
   sanction guard, the per-token lookup and the broadcast, so the `method: 'email'` op becomes the
   account's latest accredit op.

   What stays as it is: a latest `revoke` is still a miss, and `hasUnliftedSanction` still refuses
   a sanctioned account after the gate. Once the email op is indexed, a second pending token for
   the same account sees an `email` accredit as the latest op and hits the gate.
2. Two comments in the `/verify` handler equate a gate hit with "currently accredited": the one
   at the gate ("is this account already accredited?") and the opening of the "Ever-sanctioned
   guard" comment ("reaching here means the account is NOT currently accredited (latest op is a
   revoke or there is no accredit)"). Cut each to what the gate checks.
3. The `findExistingAccreditation` docblock says "The WoT cleanup path in routes/wot.ts is a live
   producer of revoke ops" and "Scope per the filing task". No WoT path broadcasts a revoke, and
   the second is a task redirect. Delete both while you are in that docblock.

## Out of scope

- The per-token idempotency branch (`already_landed`). It stays.
- The limiters, the session requirement and the mail text. Each has its own task.

## Acceptance criteria

1. A `/verify` spec for an account whose latest op is a `wot` accredit below the live threshold:
   the route broadcasts an accredit op with `method: 'email'` and answers 200 with no `outcome`.
2. An account whose latest op is an `email`, `orcid` or `manual` accredit still answers
   `already_accredited` and broadcasts nothing.
3. A sanctioned account whose latest op is a `wot` accredit is refused with 403
   `ACCREDITATION_SANCTIONED`.
4. Comments follow root `CLAUDE.md` "Comment anchors".

## [TODO Architect] at archive

- Update the `already_accredited` paragraph of `api-contracts/accreditation.md`, and say in
  `ARCHITECTURE.md` § 2 that an email verification pins a WoT enrollee.
- `/ce-compound-refresh` on `accreditation-state-read-latest-action-wins-2026-05-15.md`.
  The same refresh deletes the entry's claim that `backend/src/wot.ts:347` produces revoke ops,
  in its sibling-site list and in "The bug is reachable, not theoretical". `wot.ts` broadcasts no
  revoke op; the admin sanction route (`/accreditation/sanction` in `routes/admin.ts`) does.
  (Added 2026-10-07 from the review of `backend-latest-op-haf-lookups-walk-the-blocks-index`.)
- The same refresh also covers, in that entry: guidance step 4 ("'accredit' means currently
  accredited"), the canonical SQL (no `method` projection), the caller branching snippet (no
  `wot` check), the route example's null comment, and the task-file citation in Related.
  (Added 2026-10-08 from the intake review of `31994b09`.)
- `ARCHITECTURE.md` "Credential Bindings", the `/verify` paragraph: "An already-accredited
  account verifying a mailbox claims the row as `bound` at once, with no second `accredit` op."
  An account whose latest op is a `wot` accredit now gets a `method: 'email'` op. Narrow it.
