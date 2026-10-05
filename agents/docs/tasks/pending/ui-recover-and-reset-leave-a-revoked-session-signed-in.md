# Recovery and password reset leave this browser's revoked session in place

**Owner:** ui
**Created:** 2026-09-30
**Priority:** high

## Why

`pages/recover.js` and `pages/reset-password.js` complete their flow without
touching the auth store. Both recovery arms await the API call and move to the
done phase, discarding the reissued token in the response. The reset route
returns no token at all. Each of these revokes every earlier session for the
account on the server.

A user who is signed in on the same browser and runs either flow keeps the
revoked token in the store and in the stored session. Nothing happens until
the next bearer request, which can be the notification poll up to five minutes
later. At that point `handleRevokedSession` tears every tab down, shows the
signed-out message and opens the sign-in modal, possibly over the done screen
or over `/login`. The outcome is coherent, since the done screens already send
the user to sign in, but it is delayed and unprompted, and it reads as if
someone else changed the account.

## Scope

1. On a successful recovery or reset, end a live session in this browser for
   the same account at that moment, through the auth store's existing
   disconnect path, so the sign-out is part of the user's own action.
2. Decide whether recovery should instead adopt the reissued token its
   response carries. That changes what the done screen says and what state the
   account is in, so check it against `ARCHITECTURE.md` § 6.1 and § 6.3 before
   choosing, and ask if the answer is not clear from there.
3. A session for a different account must be left alone.

## Acceptance criteria

1. After a successful recovery or reset in a browser signed in as that
   account, no revoked session remains stored, and no teardown message or
   sign-in modal appears later on its own.
2. A session for another account survives.
3. Unit tests pin both pages.
