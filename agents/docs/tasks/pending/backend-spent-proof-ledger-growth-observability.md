# The spent-proof ledger's accepted retention has no bound and no signal

**Owner:** backend
**Created:** 2026-09-01
**Priority:** low

## Why

The consent-op spent-proof ledger in `backend/src/lib/fresh-auth.ts` is now membership-only
and retires an entry only on a confirmed delete. That is correct and must not be undone:
a deadline can only ever retire an entry EARLIER than a confirmation would, which is the
one direction that reopens the replay. **This task is not a request to reintroduce a
deadline.** Any solution that retires an entry on the passage of time, or on a
server-replied error, is out of scope and would reopen the hole four review rounds closed.

What the round-5 review surfaced is that the cost side of that trade is stated but not
bounded, and is invisible in production.

The drain's docblock accepts indefinite retention under two shapes: a Redis that never
comes back, and a Redis that is `ready` but persistently refuses writes (the realistic
cause being `-MISCONF` while a background save is failing, which a default
`stop-writes-on-bgsave-error yes` returns to every write including `DEL`). Under either,
entries accumulate and nothing retires them.

Two things about that are worse than the docblock says:

1. **The re-dispatch volume is unbounded, not just the entry count.** Every 60s tick, and
   every `ready` transition, dispatches one `DEL` per retained entry. Under a sustained
   incident that is a growing number of commands per tick, indefinitely.
2. **The ioredis `Command` objects are not reclaimed either.** A command rejected by its
   own `commandTimeout` is never removed from `commandQueue` (`Command.reject` only clears
   its timers). Against a stalled server that never replies and never closes, each tick
   therefore adds `spentConsentOps.size` `Command` objects that are never freed. This is
   strictly wider than the pre-conversion behaviour, where entries lapsed after a TTL and
   took their re-dispatch with them. The docblock's accepted-retention paragraph reasons
   only about the `-MISCONF` shape, where the server replies promptly and the queue entry
   is freed.

Neither is a security defect. Both are operational: there is no size metric, no warn
threshold, and no cap, so a correctly-behaving accepted retention and a genuine leak look
identical from outside the process.

## Scope

The goal is to make the accepted trade observable and its cost bounded, WITHOUT weakening
the retirement rule.

Directions worth considering, not prescriptive:

- An in-flight set so a token whose `DEL` has not settled is not re-dispatched on the next
  trigger. This bounds the command volume to one per entry at a time and changes no
  security property. It is the narrowest fix for both problems above.
- A ledger-size signal an operator can see. Note the project's standing position that log
  volume is already too high, so a periodic log line is likely the wrong shape; prefer
  something pull-based or threshold-gated if a signal is added at all. Argue for whatever
  is chosen rather than adding a log by default.
- Splitting the docblock's accepted-retention paragraph so the `-MISCONF` shape (server
  replies, queue entry freed) and the stalled-server shape (no reply, `Command` retained)
  are distinguished, since only the latter grows unboundedly in objects as well as entries.

At minimum, do the last one: the code's own stated residual should match the residual it
actually carries. That was the defect class this whole task kept re-tripping on.

## Acceptance criteria

1. Repeated drain triggers against an unreachable or write-refusing Redis do not dispatch
   an unbounded number of concurrent `DEL` commands for the same retained entry.
2. The retirement rule is unchanged: an entry still leaves only on a confirmed delete or a
   later presentation's resolved `GETDEL`. A test pins that no entry retires on the passage
   of time or on a rejected delete.
3. The drain docblock's accepted-retention paragraph distinguishes the write-refusing shape
   from the stalled-no-reply shape, and states the object-growth cost of the latter.
4. If a size signal is added, its shape is justified against the project's low-log-volume
   position rather than defaulting to a periodic log line.
