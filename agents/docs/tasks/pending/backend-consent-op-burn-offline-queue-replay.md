# Consent-op burn: the compensating DEL outlives the ioredis retry budget

**Owner:** backend
**Created:** 2026-08-26

## Why

A consent-op fresh-auth proof is the strictest artifact in the system: single-use,
target-bound, 5-minute TTL, burned before the action it authorizes. That single-use
guarantee currently has a hole under a Redis flap.

When the proof is burned while Redis is connected-but-not-ready, `burnConsentOpEntry`
issues its compensating `await redis.del(...)` guarded ONLY on the client object
existing, deliberately not on `isRedisAvailable()`, reasoning in its own comment that
ioredis queues the command while offline and flushes it on reconnect.

That reasoning holds only for about two seconds. The client is constructed with
`maxRetriesPerRequest: 3` and a `retryStrategy` of `min(times * 200, 5000)`, and
ioredis's reconnect handler force-rejects every queued command, offline queue included,
once that budget is exhausted. An ordinary Redis restart comfortably exceeds it. After
that, the in-memory tier has already arbitrated the burn and returned `valid: true`,
while the canonical Redis copy survives for the remainder of its 5-minute TTL and can
be presented again once Redis reconnects.

Because the per-user consent-op targets bind `(action, actor, '')` and never the
payload, a replayed proof is not constrained to the same effect as the first use.

This was found by three reviewers independently during the `/ce-code-review` pass on
`51ecba19`, and the ioredis behaviour was verified against the installed 5.10.1 source.
The guard shape predates that commit, so it is genuinely pre-existing and did not block
that task's review, but it lands squarely on the proof-lifecycle guarantees that task
was strengthening.

## Scope

### 1. Make the compensating delete durable, or make the burn fail closed

Two defensible directions; pick one and record why.

- **Bound the ambiguity.** If the compensating delete cannot be confirmed to have
  landed, do not report the burn as a clean success. The action has already been
  authorized by the in-memory arbitration, so this is about what happens on the NEXT
  presentation of the same proof, not about failing the current request.
- **Give the burn a durable record.** Anything that lets a later consume know the proof
  was already spent without depending on a Redis command that may never flush.

Note the constraint that makes this non-trivial: the in-memory tier exists precisely so
a Redis flap between issue and consume does not produce a spurious `expired` on a proof
the user just minted. Whatever is done here must not reintroduce that.

### 2. The convention entry currently prescribes the unsound guard

`agents/docs/solutions/conventions/atomic-getdel-split-into-read-then-delete-reopens-replay-2026-08-25.md`
prescribes exactly this guard shape, client-existence only and never
`isRedisAvailable()`, and a reviewer confirmed the committed code matches that entry
essentially verbatim, down to variable names. The entry's core lesson is right: an
atomic `GETDEL` must not be split into a read plus a delete without a compensating
path. But its prescribed guard rests on an offline-queue guarantee that does not hold
for longer than the retry budget.

The entry must be corrected in the same round as the code, so the next author does not
reproduce the guard deliberately by following it. **The entry is architect-owned:
surface the needed correction and let the architect run `/ce-compound-refresh` on it,
per the standing rule that `agents/docs/solutions/` entries are never hand-edited by
implementers.**

### 3. Test the real failure mode

The dedicated test `backend/tests/lib/fresh-auth-redis-unavailable-burn.test.ts` does
not exercise this path: it stubs `isRedisAvailable()` while the underlying connection
stays `'ready'` throughout, so the queued command always flushes. Cover the case where
the client is genuinely disconnected long enough for the retry budget to be exhausted
and the queued delete to be rejected, then Redis recovers inside the proof's TTL.

## Acceptance criteria

1. A consent-op proof burned during a Redis outage that outlasts the retry budget
   cannot be successfully presented a second time after Redis recovers, within its TTL.
2. The flap-recovery property is preserved: a Redis blip between issue and consume
   still does not produce a spurious `expired` on a freshly minted proof.
3. A test drives the real rejection path rather than a stubbed readiness predicate.
4. The convention entry no longer prescribes a guard whose stated rationale does not
   hold, with the correction made by the architect.
