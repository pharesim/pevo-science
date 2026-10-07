---
title: A mailed credential token is cleared by every write that moves its address or replaces its credential, and the reset-token write re-checks its lookup
date: 2026-10-07
category: conventions
module: backend/src/routes
problem_type: convention
component: authentication
severity: high
root_cause: incomplete_enumeration
resolution_type: code_fix
applies_when:
  - Adding or changing a statement that writes `accounts.email` or `accounts.password_hash`, including an `INSERT ... ON CONFLICT DO UPDATE` and a failure-path restore
  - Adding a token that one route mails to an address and a later route redeems by the token alone
  - Adding an eviction path (recovery, password reset) meant to cut off a party holding an old credential
  - A route looks a row up, does other work, then writes a token or link onto it by id
tags:
  - mailed-link-token
  - password-reset
  - email-change
  - writer-completeness
  - account-recovery
  - lookup-write-race
  - upsert-excluded
  - account-takeover
---

# A mailed credential token is cleared by every write that moves its address or replaces its credential, and the reset-token write re-checks its lookup

## Context

Among the tokens mailed from the `accounts` row, two are redeemed by the token alone and then change the account's password or its email:

- The password reset token, `reset_token` with `reset_token_expires_at`. `POST /api/auth/reset-request` writes it and mails the link to the row's email. `POST /api/auth/reset` finds the row `WHERE reset_token = $1` and rotates the password.
- The queued email change, `pending_email`, `pending_email_token` and `pending_email_expires_at`. The change flow of `POST /api/settings/email` writes it and mails the link to the new address only. `GET /api/settings/email/verify/:token` finds the row by `pending_email_token` and swaps the address in.

Only their own routes cleared them, which left three openings:

- A reset token kept working after the email it was mailed to was replaced, by a recovery or by the change-email swap.
- A reset token also survived its password being dropped: an ORCID recovery without a new password leaves no hash, and once the owner set a password again through settings, the old token rotated it.
- A change queued by someone holding only the password survived the owner's recovery or password reset. The link still moved the email to that party's address, and a reset sent there handed the account back. This chain was measured end to end through the real routes before it was filed (session history).

## Guidance

1. **Every writer clears the token in the same statement; the redeem route cannot.** A statement that moves the delivery address (`email`) or replaces or drops the credential the token acts on (`password_hash`) also sets `reset_token = NULL, reset_token_expires_at = NULL`. An eviction is a write that replaces the password or the email and stamps `sessions_invalidated_at`: both recovery UPDATEs in `backend/src/routes/recover.ts` and the `POST /reset` UPDATE in `backend/src/routes/auth.ts`. Every eviction also clears all three `pending_email` columns, so a change queued by the party being evicted dies with it. Write the three columns together: the swap in `GET /api/settings/email/verify/:token` installs the address its token was mailed to only because every write of `pending_email` or `pending_email_token` writes both.

2. **Measure the writer set; the list a task is filed with misses writers.** The filing listed four writers. Three independent sweeps (SQL text, column-name trace, route-by-route walk) plus a critic found seven: the ORCID recovery and the seed-phrase recovery's apply step in `backend/src/routes/recover.ts`; the settings re-issue for an unverified state G row, that re-issue's SMTP-failure restore, and the change-email swap in `backend/src/routes/settings.ts`; and both `POST /api/auth/signup` upserts in `backend/src/routes/auth.ts`. The filing's list missed two kinds of writer:
   - **Upserts that write `EXCLUDED.<col>`.** Both signup upserts are `INSERT ... ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash`. The text never says `= NULL`, but `EXCLUDED.password_hash` is NULL whenever the inserted value is. The ORCID signup upsert can null a hash: an ORCID signup sent without a password over a pending signup row E does, and an E row with a password can hold a reset token. The email signup upsert requires a password, so it replaces the hash rather than dropping it, and it is a writer under the same rule.
   - **Failure-path restores.** When the verification mail fails to send, the SMTP-failure branch of the settings re-issue writes the earlier email back with an UPDATE. It spells `SET email` like any other writer; it was missed because it sits in an error branch.

   Search by column (`email`, `password_hash`, `EXCLUDED.<col>`, `COALESCE(...)`) as well as by `UPDATE accounts`. Trace each bound parameter back through the handler to decide whether it can be NULL: the ORCID recovery binds `passwordProvided ? hash : null`. The sweep belongs to the implementer, not the filer. This one came with a list of four.

3. **The write that issues the token re-checks the lookup's predicate.** `/reset-request` reads the row by email and its gate, mints a token, then writes the token in a second statement. Keyed on `id` alone, that write lands on a row that a recovery or swap moved in between, and a token mailed to the old address rotates the password. Key the write on everything the lookup checked:

   ```sql
   UPDATE accounts SET reset_token = $1, reset_token_expires_at = $2
    WHERE id = $3 AND email = $4 AND password_hash IS NOT NULL AND (username IS NULL OR verify_token IS NULL)
   ```

   Under READ COMMITTED a blocked UPDATE re-evaluates its WHERE against the row that committed ahead of it, so a concurrent move makes the write match nothing. The handler does not read the write's row count. It still mails the link and answers the uniform 200, so a token no row holds goes to the old address and the answer is unchanged.

   The queued email change's issuing write does not do this. The change flow of `POST /api/settings/email` writes the `pending_email` columns keyed on `username` alone, so an eviction that commits while a change request is in flight still leaves that request's change queued. That was accepted as a residual when the eviction clears were scoped: the window is server-side and the requester cannot stretch it.

4. **Spell the gate out at each accounts write.** Factoring the shared predicate into a constant and interpolating it into the UPDATEs turns `backend/tests/eslint/no-accounts-updated-at-write-outside-signup-finalize.test.ts` red. Its no-assembled-write rule refuses an accounts write whose text carries a `${...}` interpolation, because the scan reads the SET list from the statement's own text. The predicate stays written out at the `/reset-request` lookup, its token write and the `/reset` UPDATE.

## Why This Matters

Neither redeem route can tell a stale token from a live one: both select by the token alone. One writer that forgets the clear reopens the whole takeover chain, and nothing at the redeem side notices.

Each part of this rule was found late. The filing listed four writers and three more surfaced in the sweep. The lookup-to-write race surfaced only in an adversarial review, after every per-writer spec was already green.

## When to Apply

- A new route or statement writes `accounts.email` or `accounts.password_hash`, directly, through an upsert's `EXCLUDED`, or in a failure restore. Add the reset-token clear, and add a spec to `backend/tests/routes/reset-token-cleared-by-account-writes.test.ts`.
- A new eviction path. Also clear the `pending_email` columns, and add a spec beside those in `backend/tests/routes/recovery-and-reset-drop-queued-email-change.test.ts`.
- A new mailed token. Decide which writes must kill it, then sweep for them by column.
- Any read-then-write that puts a token, link or claim onto a row it looked up without a lock.

## Examples

ORCID recovery, before:

```sql
UPDATE accounts SET password_hash = $1, email = $2, sessions_invalidated_at = $3 WHERE id = $4
```

After:

```sql
UPDATE accounts
   SET password_hash = $1, email = $2, sessions_invalidated_at = $3,
       reset_token = NULL, reset_token_expires_at = NULL,
       pending_email = NULL, pending_email_token = NULL, pending_email_expires_at = NULL
 WHERE id = $4
```

The per-writer specs follow one shape:

- issue a token (through `/reset-request` where it serves the row, or written directly where it does not);
- run the writer through its route;
- assert the row holds no token, that `/reset` answers the token exactly as it answers an unknown one, and that the password did not change.

Each spec failed against the code from before the clears.

**Forcing the race on the real path.** A first version wrapped `pool.query` to run a recovery just before the token write. That falls under the mock carve-out, and its clause-(a) claim that the window could be placed no other way was false. The landed spec holds the race open with a row lock instead:

1. Run the email move in a transaction held open on a second pool connection. That connection's UPDATE holds the row lock.
2. Send `/reset-request` for the old address. Its lookup is a plain SELECT, so it reads the committed old row and passes. Its token write then blocks on the lock.
3. Wait until `pg_blocking_pids()` shows the write waiting on the mover's pid.
4. Commit the move, then assert that no token landed.

A copy of the route whose token write is keyed on `id` alone fails this spec.

## Related

- `agents/docs/solutions/conventions/sidecar-index-writer-completeness-2026-06-12.md`: the same writer-completeness rule in another domain. An invariant holds only if its least careful writer keeps it.
- `agents/docs/solutions/conventions/convention-sweep-syntactic-form-misses-semantic-siblings-2026-05-21.md`: sweep by meaning, not by syntax. The `EXCLUDED` upserts are an instance.
- `agents/docs/solutions/conventions/completeness-claim-tasks-need-independent-re-enumeration-2026-06-14.md`: the review-side counterpart. A task's "these N writers" is re-enumerated from the tree.
- `agents/docs/solutions/conventions/real-postgres-race-test-holds-the-row-lock-and-follows-the-blocker-chain.md`: the row-lock technique the race spec uses, and the earlier write-re-checks-the-read fix on `POST /api/auth/reset` (`reset_token = $3`).
- `agents/docs/solutions/conventions/credential-setting-token-redeem-must-not-name-the-account.md`: the sibling rule on the same token, about what its redeem response may reveal.
- `agents/docs/solutions/conventions/timing-equalization-smtp-failure-mode-oracle-2026-04-22.md`: why `/reset-request` keeps one status and body whatever the token write did.
- `agents/docs/solutions/conventions/recovery-defenses-vs-seed-phrase-holder-non-load-bearing-2026-05-25.md`: the eviction clears defend against a password-only attacker, which that entry keeps load-bearing.
