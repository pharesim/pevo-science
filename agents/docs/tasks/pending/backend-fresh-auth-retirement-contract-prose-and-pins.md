# Close the last two retired-model sentences in fresh-auth, and pin the retirement contract

**Owner:** backend
**Created:** 2026-09-02

Routed out of the architect review that archived the consent-op burn task. That task's
six review passes were all one failure class: a sentence stating a model the code no
longer implements, left standing by a rewrite that touched the lines around it. Two
such sentences remain, and the release event the last round newly documented is
asserted nowhere. Filed separately rather than held, because the parent's three items
were confirmed closed and a seventh round on one comment is not worth reopening a
1477-line task file.

## Why

The reviewed state is `b8b4277d`. Items 1 and 2 are prose defects in
`backend/src/lib/fresh-auth.ts`; items 3 and 4 are test pins in
`backend/tests/lib/fresh-auth.test.ts`.

## Scope

### 1. The session issuance backup comment states a conditional model its own code contradicts

`issueSessionFreshAuthToken`'s comment above the `memStore.set(...)` call says the
write happens "whenever Redis-issuance succeeds", and defends itself as "NOT dead code
in the Redis-success branch". Both are false about the lines beneath them: the write is
unconditional and runs before `getRedis()` is called at all, so no Redis-success branch
contains it.

It matters beyond tidiness because the sentence names `issueFreshAuthToken` as its
referent ("same recovery rationale as"), and the consent-op sibling's matching comment
was rewritten to the opposite, unconditional model. The cross-reference now resolves to
text stating the opposite of what it claims to share. The question it misleads on,
which tier can hold a presentable proof during a flap, is the reasoning the whole ledger
design rests on.

Fix: adopt the wording already used at the consent-op site, and drop the dead-code
clause, which presupposes a branch the write does not sit in.

### 2. The drain docblock's "one event" survives item 2 of the parent's round-6 hold

The `drainSpentConsentOps` docblock still says the `DEL` resolving is "the one event
that proves the canonical key unreadable". That sentence was deliberately not held in
the parent's round 6, on the reasoning that its "its delete" scoping kept it defensible
and that it would become the last over-readable statement in the file once the burn
docblock adopted the two-event form. The burn docblock has adopted it. A wrap-tolerant
sweep over both files now returns this as the only remaining hit.

Fix: bring it into the same two-event form `burnConsentOpEntry` and `spentConsentOps`
already use, scoped so it stays true of the drain specifically.

### 3. The second release event has no test

The burn's retirement contract has exactly two release events. The one the last round
newly documented, the `alreadySpent` branch retiring an entry on its own resolved
`GETDEL`, is asserted by nothing. The contract is agreed between prose and code only by
inspection, which is precisely how the parent's item 2 drifted with no failing test to
catch it.

The hooks already exist: `_setSpentConsentOpForTests` and
`_getSpentConsentOpsSizeForTests` are exported. Plant a ledger entry for a token whose
Redis key is still live, consume it, then assert the consume is refused, the ledger is
empty, and the canonical key is gone.

Pin the retained direction too: an entry must SURVIVE a presentation whose own `GETDEL`
rejects, since `redisLegRan` is false there and the guard must stay standing.

### 4. Neither split-tier test pins that the tiers actually split

Both split-tier race tests install a `redis.del` spy, restore it, and never assert on
it. The compensating delete is issued only on the `!redisLegRan && burnedInMemStore &&
redis` branch, so asserting it was NOT called is exactly the pin that the one burn which
ran was arbitrated by a resolving `GETDEL` on the Redis tier rather than by the
in-memory fallback. Without it the tests prove one winner without proving the fixture
built the race it describes.

Add the assertion to both tests.

## Acceptance criteria

1. Neither `backend/src/lib/fresh-auth.ts` nor `backend/tests/lib/fresh-auth.test.ts`
   contains a statement of the retired conditional-backup or one-event-retirement model.
   Verify with a wrap-tolerant sweep that collapses comment prefixes and newlines before
   matching, not a single-line grep. Report the technique, not just the phrase searched.
2. The `alreadySpent` release event and the retained direction each have a test that
   fails when the behavior is mutated away.
3. Both split-tier tests assert the compensating delete was not called.
4. Mutation probes run per site against a committed baseline, with `git status` verified
   clean for the target file immediately before every `git checkout --` restore.
5. Typecheck and lint clean. The three fresh-auth suites pass.

## Notes

Items 1 and 2 are comment-only and change no behavior. Items 3 and 4 add assertions
only. No production logic should change in this task; if it does, that is a signal the
prose was describing something real that the code does not do, and it should be raised
rather than silently fixed.

Do not run the full suite concurrently with sibling agents. The per-file `${appTag}:*`
Redis flush collides with other workers, and the parent task already recorded one
deterministic pre-existing failure caused by exactly that collision.
