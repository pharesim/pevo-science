# The /verify broadcast cap keeps the claim of an attempt it refused

**Owner:** backend
**Created:** 2026-10-05
**Priority:** low

Filed from the accreditation and Web of Trust audit (findings 6 and 25). The validator confirmed
finding 6 from the code. Incidence was not measured.

## Why

`incrementBroadcastAttempts` (`backend/src/routes/accreditation.ts`) claims a slot before the
broadcast. On the `attempts > cap` branch the route answers 502
`BROADCAST_ATTEMPT_LIMIT_EXCEEDED` and keeps that claim. The only decrement is on the timeout
branch, where each timed-out broadcast releases its own claim. The counter's TTL is the pending
token's remaining life.

So once the refused attempts on one token number at least `cap`
(`config.verifyBroadcastAttemptsCap`, default 3) and the broadcasts that were in flight have
timed out, the counter sits at or above the cap with nothing in flight, every further attempt is
refused and adds one more, and the block lasts until the token itself expires. The 502 message
says "Please wait or request a fresh accreditation email", and three comments say the block can
be waited out.

Two comments also say that only definitive 502 `BROADCAST_FAILED` outcomes count toward the cap,
and a third that the cap is meant to bound retries on definitive chain rejections. A failure
never counts: the failure branch calls `deleteToken`, which deletes the counter with the token.

## Scope

1. A request that the cap refuses leaves the counter as it found it. The timeout branch shows the
   shape: a best-effort `decrementBroadcastAttempts(token, attemptId)` inside its own `try`,
   placed here before the 502 is sent. This form was not plant-tested. The property to keep: each
   broadcast in flight holds exactly one claim, so at most `cap` are in flight at once.
2. Delete the claims the code does not keep:
   - "only definitive 502 BROADCAST_FAILED outcomes count toward the cap" (the cap comment ahead
     of the claim, and the timeout-branch comment in the catch);
   - in the `DecrementBroadcastAttemptsResult` docblock, "the cap is meant to bound retries on
     definitive chain rejections";
   - "(~24h from the first INCR)": the TTL is the token's remaining life;
   - the wait-out-the-TTL sentences in the `incrementBroadcastAttempts` docblock and in the two
     soft-block comments, in whatever form step 1 leaves true. Delete or narrow; do not write a
     longer explanation in their place.

## Out of scope

- The success path's counter delete, and the in-memory counter used when Redis is not configured.

## Acceptance criteria

1. With `cap` broadcasts held in flight, further attempts answer 502, and afterwards the counter
   equals the number of broadcasts in flight.
2. After those broadcasts time out, the next attempt reaches the broadcast.
3. Comments follow root `CLAUDE.md` "Comment anchors".

## [TODO Architect] at archive

- Re-read the `BROADCAST_ATTEMPT_LIMIT_EXCEEDED` entry in `api-contracts/accreditation.md`. Its
  "after which the user can retry the same token" clause was deleted during the audit.
