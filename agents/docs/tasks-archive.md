## Rows the old settings verify handler locked out of signup are never repaired (archived 2026-10-06) — clean first review; the operator procedure now lives in ARCHITECTURE.md

### Architect archive note (2026-10-06)

Clean `/ce-code-review` of 2fd1c633, b238605c and 5e9510a4: seven reviewers (correctness, adversarial,
project-standards, testing, data-migration, deployment verification, learnings), zero findings. Six of
them independently enumerated every `accounts` writer at 5e9510a4 and found none that leaves
`verify_token` and `username` both NULL, even transiently. The testing reviewer reproduced every
mutation-kill claim in the signal. The `[TODO Architect]` is done: ARCHITECTURE.md § Schema Migrations
gains "Post-deploy cleanup: rows the old settings verify handler locked", with the operator commands
plus the pre-delete backup step (a COPY of the matched rows) that the deployment reviewer asked for.
§ 6.1's "No transition produces a row that doesn't match one of the rows above" stays as is: it is true
of the current code, and the new section records the history. The production run is the user's, after
a backend whose settings verify add flow requires a username is deployed. No `/ce-compound`.

**Owner:** backend
**Created:** 2026-10-05
**Priority:** high

## Why

Before d33792ce, `GET /api/settings/email/verify/:token` looked a row up by the token alone and
cleared `verify_token` and `expires_at` on it. A pending signup row's token (state E's hex
token, or state F's `confirmed:` token) presented there was accepted. That left the row with
`verify_token` NULL and `username` NULL. No state in ARCHITECTURE.md section 6.1 has that
combination: E and F carry a token, and every state with a NULL token has a username.

d33792ce stops producing these rows but does not repair any that already exist. Such a row is
terminal:

- `POST /api/auth/signup` answers 409 for its email, so the address cannot sign up again.
- `ABANDONED_ACCOUNT_ROWS` in `signup-cleanup.ts` requires `verify_token IS NOT NULL`, so the
  signup cleanup never reaps it.
- A password login on it mints a JWT whose `sub` is null. `verifyHiveSignature` accepts only
  a non-empty string `sub`, so the session authorizes nothing. The row only holds the address.

Had the token not been cleared, the cleanup would have deleted the row: an E row once its
link expired, an F row 30 days after creation. Deleting a locked row therefore reaches the
end state the cleanup would have reached, and the person can sign up again from the start.

Nobody has checked whether the beta database holds any such rows. No review runs queries
against a deployed database.

## Scope

1. Add a one-time repair the operator runs against a deployed database. It deletes the rows
   with `verify_token IS NULL AND username IS NULL`, the one combination section 6.1 does
   not enumerate, which only the old handler produced.

   Do not put it in `backend/migrations/`. `./deploy.sh migrate` re-applies every file there
   on every deploy, so a DELETE there would become a standing sweeper. It would run forever
   against a shape no current writer produces, which the account-state rule treats as
   defending a fictional state. Make it an operator script, for example under
   `backend/scripts/`, that runs from the repo root against the postgres container. It has
   two steps:
   - A read-only count step the operator runs first. It lists each row the delete would
     remove: id, created_at, and whether `password_hash` and `orcid` are set.
   - A delete step, in one transaction, that removes only those rows.
2. Before writing the delete, enumerate every table that refers to an `accounts` row.
   That means foreign keys to `accounts.id`, plus rows keyed by the account's email or
   username, such as `notification_preferences`. State in the signal what happens to a
   deleted row's dependents. A row with a NULL username has no on-chain account and no
   username-keyed rows, but verify that from the schema and code rather than relying on it.
3. Put the exact operator commands in the signal block: the count step, then the delete
   step. The user runs them on the server. Agents cannot reach it.

## Acceptance criteria

1. A test seeds the following rows, runs the delete step against the test database, and
   asserts that only the locked row is gone:
   - one locked row (`verify_token` NULL, `username` NULL);
   - a state E row and a state F row (token set, `username` NULL);
   - a finalized state A row;
   - a verified state G row (`username` set, token NULL).
2. The count step writes nothing. Pin this in the same test, or make it true by
   construction (a file that holds only a SELECT).
3. Running the delete step a second time, after a successful run, deletes nothing.

## Notes

- The producer is fixed in d33792ce: the settings verify handler's add-flow lookup now
  requires `username IS NOT NULL`. The opposite direction through the same column is
  `backend-signup-upsert-overwrites-finalized-row.md`.
- Database-only. No chain operations are involved.

## Backend implementation signal (2026-10-05, commits 2fd1c633, b238605c, 5e9510a4)

**Commits:**

- `2fd1c633`, `backend(scripts): a one-time repair for rows with neither a verify token nor a username`:
  - `backend/scripts/repair-locked-signup-rows-count.sql`: one SELECT. It lists each row with
    `verify_token IS NULL AND username IS NULL`: id, created_at, and whether email,
    password_hash and orcid are set (`has_email`, `has_password`, `has_orcid`). It writes nothing
    by construction (AC2).
  - `backend/scripts/repair-locked-signup-rows-delete.sql`: one `DELETE ... RETURNING id` over
    the same predicate, run under `--single-transaction`.
  - `backend/tests/scripts/repair-locked-signup-rows.test.ts`: AC1 to AC3. Each spec runs the
    files verbatim on a dedicated connection. On that connection the unqualified `accounts` is a
    temporary table built `LIKE public.accounts INCLUDING ALL`. The spec's transaction is rolled
    back and the connection destroyed, so the shared table is never touched.
    - Seeds: two locked rows (email path; ORCID path with email NULL and no password), plus E, F,
      A, verified G and unverified G.
    - AC2 is also pinned at runtime: the count's transaction is never assigned a transaction id.
  - `backend/tests/eslint/no-accounts-updated-at-write-outside-signup-finalize.test.ts`:
    - Its `backend/scripts` KNOWN LIMITS entry said a script there that writes rows in the
      application database is a new root.
    - Its scanned SQL set now includes `backend/scripts/**/*.sql`, keyed `scripts/<name>`.
    - Its prose says so.
- `b238605c`: fixes from my own verification pass, triaged by the user. Details are under
  "Verification" below.
- `5e9510a4`: the `/ce-simplify-code` pass.

**Checks:**

- The new test and the canary pass: 34 tests, `--retry=0`.
- `npm run typecheck` and `npm run lint` are clean.
- Full suite at `b238605c`: 8 files and 18 specs fail, out of 250 files and 2760 specs.
  - Every one of those files is on the recorded list of failures on clean main:
    `cast-hardening-author-index-weight`, `idempotency-real-haf`, `accreditation-idempotency`,
    the two `accreditation.test.ts` broadcast-attempts-cap specs, `papers-enrichment-parity-gate`,
    `profile-auth-bypass`, the two `reviews.test.ts` SQL-gate specs, and the self-poisoning
    `signup-verify-activation-recovery` `LOCK_HELD` spec.
  - The run also hit HAF connect timeouts.
  - None of these commits touches `backend/src`.

### Operator commands (on the server, from the repo root)

0. First deploy a build that contains d33792ce (`./deploy.sh restart`). The old settings verify
   handler stays live until then, and it can create new locked rows after the delete.
   - d33792ce is on main. Its task, `backend-settings-verify-clears-any-row-token.md`, is still
     in `pending/` under a hold.
   - The hold may change the add-flow clear's conjuncts. The add-flow SELECT keeps
     `username IS NOT NULL` either way.
1. Count (read-only):

   ```bash
   docker compose exec -T postgres psql -U pevo -d pevo_app -v ON_ERROR_STOP=1 \
     -f - < backend/scripts/repair-locked-signup-rows-count.sql
   ```

2. Check the list, then delete:

   ```bash
   docker compose exec -T postgres psql -U pevo -d pevo_app -v ON_ERROR_STOP=1 \
     --single-transaction -f - < backend/scripts/repair-locked-signup-rows-delete.sql
   ```

   - It prints the deleted ids and `DELETE <n>`.
   - Run step 1 again afterwards: it should list no rows.

**Notes for the operator:**

- The postgres container mounts only `backend/migrations`, so both files are fed in over stdin
  (`-T` plus `-f -`).
- The count may well be zero. Reaching the bug took a token holder who sent a signup token to the
  settings verify route on purpose, since neither email links there.
- Both commands were run as written against a throwaway database (`pevo_probe_repair`, all 17
  migrations applied, then dropped):
  - The count listed exactly the two seeded locked rows.
  - The delete returned their ids, and a second run gave `DELETE 0`.
  - A broken file under `ON_ERROR_STOP=1 --single-transaction` exited 3 with nothing deleted.

### Dependents of a deleted row (Scope item 2)

Checked in the migrations, the code, and the live catalogs of `pevo_app` and `pevo_app_test`.

- **Foreign keys:** none reference `accounts`, and no table has a trigger or rule.
  - `009_audit_log_fk_anonymize.sql` adds no FK, despite its name. It only drops NOT NULL on
    `custody_audit_log.username`.
  - So the DELETE removes the matched rows and nothing else: no cascade, no SET NULL, no RESTRICT
    error.
- **Tables keyed by username:** none can hold a row for an account whose username is NULL.
  - `notification_preferences.username`: PK, NOT NULL.
  - `pending_recovery.username`: NOT NULL.
  - `pending_ipfs_uploads.uploader_account`: NOT NULL.
  - `bridge_import_queue.username`: NOT NULL.
  - `custody_audit_log.username`: nullable since 009 for anonymized rows. It is written under an
    authenticated username, which a locked row never had.
  - The script deliberately cascades nowhere:
    - a `custody_audit_log WHERE username IS NULL` co-delete would destroy the anonymized forensic
      rows left by earlier email erasures;
    - an email-keyed cascade on `notification_preferences.email`, `pending_recovery.new_email` or
      `pending_accred` would hit other identities' free-text addresses.
- **The row's own claims:** the delete releases its `accounts_email_key` and
  `accounts_orcid_unique` claims. This is the intended effect: the address and ORCID iD can sign
  up again.
  - A staged `pending_recovery` row whose `new_email` equals a locked row's email is refused at
    phase 2 while the locked row exists. The delete unblocks it, which is harmless.
- **Redis:**
  - The `rl:` byAuthToken keys and `signup_activation_lock:` keys for the row's old token are
    TTL-bound and keyed by a token the row no longer carries.
  - The `regwatch` cursors are high-water ids. SERIAL ids are never reused.
- **Outside the database:**
  - If the registration-watch webhook was configured, its "Signup started" post already carried
    the row's email, name and institution. The delete does not retract it.
  - Reset links and signup cookies that point at the row stop working.
- **Chain:** the task says "a row with a NULL username has no on-chain account". That is not
  strictly true, though the delete is unaffected.
  - An F row could crash mid-`/confirm`, after `createClaimedAccount` but before the finalize
    UPDATE, and then be locked by the old handler.
  - Such a row matches an on-chain account the app DB records nowhere.
  - That account holds no server-side keys: `posting_key_enc`/`memo_key_enc` are written only by
    the finalize UPDATE that also sets `username`. It also has no accreditation.
  - The user controls it through the mnemonic and can sign up again after the delete.

### Producer history

- The old `GET /api/settings/email/verify/:token` add flow, from 9a6772aa up to d33792ce, is the
  only producer that reached rows.
- A second writer with the same SQL shape existed: the ORCID sibling sweep in `/confirm` and
  `/link`, from 44b26476 to b8b1287e.
  - It matched nothing, because `accounts_orcid_unique` (508ce94e, an ancestor) forbids a second
    row with the same ORCID.
- No current writer produces the shape. Every token-clearing write either:
  - sets `username` in the same UPDATE (the `/confirm` and `/link` finalizes), or
  - requires a username (the settings verify add flow; the change flow reaches only rows found by
    `pending_email_token`, which only username-keyed writes set).
- Nothing sets `accounts.username` to NULL.

### Verification and triage (user-approved 2026-10-05)

I ran a verification workflow:

- **Mutation probes** in a scratchpad copy:
  - Every behavior pinned by the new test goes red when broken: dropping either conjunct from the
    delete or the count; a count that writes; a delete qualified as `public.accounts`, which
    committed nothing.
  - The canary goes red on an `updated_at` writer planted in a scripts `.sql`, and green when the
    scripts root is removed.
  - With `release()` instead of `release(true)`, the next spec fails 42P07, so a leaked shadow is
    loud.
- **The operator-command run** described above.
- **A claim audit** of every new comment.

The user approved my recommendations:

- **Fixed** in `b238605c`:
  - The canary's codeSourcesUnder docblock counted the call sites held by reading as two. There
    are now three.
  - The roots paragraph said "collected the same way". The scripts root is walked recursively.
  - The symlink KNOWN LIMITS entry now covers `backend/scripts`.
  - Scripts rels are keyed `scripts/<name>`, so they no longer share the bare-filename namespace
    of migrations.
  - A short reflow line.
- **Dismissed** (low, theoretical or cosmetic):
  - The seeds advance the real `accounts_id_seq`. The serial default is copied by
    `LIKE ... INCLUDING ALL`, and sequences are non-transactional, so this means id gaps only.
  - The count's "writes nothing" probe does not see a non-transactional `nextval()`.
  - Dropping `ORDER BY` from the count stays green.

