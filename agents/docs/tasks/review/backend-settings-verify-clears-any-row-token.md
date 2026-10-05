# The settings email-verify handler clears verify_token on whatever row carries it

**Owner:** backend
**Created:** 2026-09-14

Surfaced by the security lens during the round-4 review of the
`accounts.updated_at` writer canary, and confirmed by an independent validation
pass. Pre-existing and unrelated to that canary's own change, so it is filed
here rather than held there.

## Why

`GET /api/settings/email/verify/:token` looks the row up by the token alone:

```
SELECT id, expires_at FROM accounts WHERE verify_token = $1
```

and then clears it:

```
UPDATE accounts SET verify_token = NULL, expires_at = NULL WHERE id = $1
```

Neither statement scopes the row to the flow that issued the token. The
settings add flow is the intended issuer, and it writes `verify_token` only on a
row it INSERTs for a username that had none, which is state G per
ARCHITECTURE.md section 6.1. But the signup INSERTs in `routes/auth.ts` write
the same column on a pending row, and the signup verify-link step writes the
`confirmed:` form. Either of those tokens presented to this handler is accepted.

The row that results is `verify_token` NULL with `username` NULL, which section
6.1 does not enumerate, and it is terminal:

- `POST /api/auth/signup` answers 409 for an existing row whose `verify_token`
  is NULL, so the address cannot be signed up again.
- The resend route returns before its UPDATE when the token is already NULL, so
  no new link can be issued.
- Signup cleanup deletes only rows whose `verify_token` is NOT NULL, so the row
  is never reaped.

So anyone holding a leaked verification link, or the `confirmed:` auth_token,
can permanently lock that email address out of signup. That is the capability
the signup session binding exists to deny a leaked token, reached through a
different route. Worth tracing on the way in: the login handler's pending-state
branch keys on the token too, so a bricked row falls through to the active
branch, and what a session minted from a row with a NULL `username` does is part
of the blast radius rather than a separate question.

The two stuck-recovery lookups are NOT reachable from this row: both conjoin a
`custody` value no INSERT writes. The marker is not moved either. This is an
availability and account-state defect, not a binding bypass.

## Scope

1. Scope the add-flow lookup and its UPDATE to rows the add flow could have
   created, so a signup token presented here is not accepted. The add flow's
   rows always carry a `username` (the INSERT names it); the signup INSERTs
   leave it NULL. Verify that separation from the code before relying on it
   rather than from this description, and say what you verified.
2. A token that does not match after the narrowing must answer the same generic
   400 the not-found path already answers. Do not add a distinguishing message:
   the difference between "no such token" and "that token is not for this flow"
   is a signup-state oracle.
3. Decide, and state, what happens to the change flow's branch in the same
   handler. It keys on `pending_email_token`, a column no signup path writes, so
   it is not exposed the same way; say so in the commit rather than leaving the
   asymmetry unexplained.

## Acceptance criteria

1. A state E row's own hex token presented to the settings verify handler
   answers the generic 400 and leaves that row's `verify_token` intact, pinned
   by a route test.
2. A state F row's `confirmed:` token does the same, pinned by a route test.
3. The settings add flow's own token still verifies, pinned by a route test that
   exercises the real path rather than asserting the narrowing in isolation.
4. No response distinguishes a wrong-flow token from an unknown one.

## Notes

- Sibling defect, same family, already filed:
  `backend-signup-upsert-overwrites-finalized-row.md`. That one is the signup
  upsert reaching a settings-created row; this one is the settings handler
  reaching a signup-created row. They are opposite directions through the same
  shared column and should read as a pair, but they are separate fixes in
  separate routes.
- The `accounts.updated_at` canary's docblock names this clearer as the third
  statement that clears the token. That sentence stays true whichever way this
  task lands; do not edit the canary from here.

## Backend implementation signal (2026-10-05, commit d33792ce)

d33792ce verified as an ancestor of HEAD with `git merge-base --is-ancestor`. It landed in the
same pass as `backend-state-g-unverified-row-lifecycle`, at the user's request. That task's
signal block holds the shared verification run.

- **Scope 1.** The add-flow lookup is now `WHERE verify_token = $1 AND username IS NOT NULL`. I
  verified the separation from the code: the settings add-flow INSERT always names the
  username, both signup INSERTs in `routes/auth.ts` leave it NULL, and both finalizes clear the
  token in the same UPDATE that sets the username. The clear is also keyed on the presented
  token (`WHERE id = $1 AND verify_token = $2 AND username IS NOT NULL`). The new re-issue
  branch can replace a G row's token between the lookup and the clear, and a link for the
  earlier address must not verify the later one. A clear that matches no row gets the same
  generic 400.
- **Scope 2.** Wrong-flow tokens (E hex, expired E, F `confirmed:`) get the not-found 400
  'Invalid or expired verification link', identical to an unknown token. That includes an
  expired E token, which used to draw the distinct "has expired" message.
- **Scope 3, the change branch.** Not narrowed. A non-NULL `pending_email_token` is written
  only by the settings `POST /email` handler, on a row it found by username, so no signup
  token can match. A code comment says so. Separately, under the lifecycle task's item 8b, the
  change branch now also clears `verify_token` and `expires_at` with the swap.
- **AC1-AC4.** Specs in `tests/routes/settings-state-g-unverified-email.test.ts`:
  - "answers a state E row's hex token with the unknown-token 400 and keeps the row's token"
  - "answers an expired state E row's token with the same unknown-token 400"
  - "answers a state F row's confirmed: token with the unknown-token 400 and keeps the row's
    token"
  - "verifies the settings add flow's own token through the mailed link", which drives the
    real path.

  The first three each failed against the base code. The responses are asserted identical to
  the unknown-token answer.
- **The `updated_at` canary.** The Notes said not to edit it from here. The lifecycle task's
  changes made several of its sentences false: the re-issue writes `verify_token` on an
  existing row, and the change branch now clears the token. So it was rewritten in d33792ce
  under that task, and the clearer it names is described with its new scope.
