# Rows the old settings verify handler locked out of signup are never repaired

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
