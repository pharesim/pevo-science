# The email-change link rewrites other users' digest addresses

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
