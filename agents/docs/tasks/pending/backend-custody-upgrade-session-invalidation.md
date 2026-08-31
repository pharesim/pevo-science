# Close open session windows on custody upgrade

**Owner:** backend
**Created:** 2026-08-31

Routed out of the architect review of `b9526720` (windowed session fresh-auth,
round 4). Pre-existing, on a route that task never touched.

## Why

`POST /api/custody/upgrade` moves an account from server-held custody to
self-custody: keys rotate, a new JWT is issued, and the server's encrypted copy
of the posting key is deleted. It writes no revocation epoch and runs no sweep,
so any session-kind proof outstanding at that moment stays live until its
absolute cap.

The three routes that do invalidate are the password reset and the two recovery
paths. Upgrade is the fourth route that materially changes an account's
authentication posture and the only one that does not.

Impact is bounded rather than severe, which is why this is its own task and not
a hold. After the upgrade the server cannot broadcast for the account at all,
and the broadcast route refuses non-light custody before it ever consumes a
proof. What survives is the ability to mint IPFS upload tokens against PEvO's
node with a credential issued under the previous custody model, for up to the
remainder of the window. That is resource abuse and a stale credential, not
account takeover.

It is also squarely within what the windowed-session work set out to guarantee:
invalidating a user's sessions must also invalidate their outstanding
session-kind proofs. Upgrade was simply never enumerated as a case of that.

## Scope

1. Stamp the revocation epoch and sweep the account's outstanding session proofs
   as part of the upgrade, in the same transaction boundary the other three
   routes use.
2. Decide whether upgrade should also invalidate the account's bearer JWTs. It
   already issues a new one, so the question is whether the old one should keep
   working; the reset and recovery routes both say no. Whichever way it goes,
   state the reason in the route.
3. Consider whether the revocation-write canary should enforce the inverse
   direction it currently does not. It requires every writer of the epoch to
   sweep, and never requires a route that rotates credentials to write the epoch,
   which is why this gap had no guard pointing at it. If a general rule is not
   expressible, pin the known set of credential-rotating routes explicitly.

## Acceptance criteria

1. A session window minted before an upgrade is refused afterwards, asserted at
   the route level rather than only at the library.
2. The refusal is the epoch check, not merely the Redis sweep. A test that
   withholds the sweep must still show the window closed.
3. The JWT question from scope item 2 is decided, implemented, and covered.
4. Whatever guard comes out of scope item 3 fails when the new invalidation is
   removed from the upgrade route.

## Notes

Found by probing the guards rather than the behaviour: the canary that enforces
"every epoch writer sweeps" is one-directional, so a route that should stamp and
does not is invisible to it. That asymmetry is the more general lesson and is
why scope item 3 is in this task rather than left implicit.
