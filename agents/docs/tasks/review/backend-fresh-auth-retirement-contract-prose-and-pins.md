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

---

Backend implementation signal (2026-09-30, commits `6dd794d3` and `b80ebff1`, both verified ancestors of `main`):

**Item 1.** The comment above `memStore.set` in `issueSessionFreshAuthToken` now uses the consent-op site's unconditional wording and the dead-code clause is gone.

**Item 2.** The `drainSpentConsentOps` docblock states both release events and scopes itself to the one the drain can produce.

**Item 3, with one deviation from the task text.** The task says the `alreadySpent` release event "is asserted by nothing". That was not the case at the reviewed state: `fresh-auth-redis-unavailable-burn.test.ts` ("a ledger entry refuses the consume itself, with the canonical key still readable") already asserts refused, ledger empty, key gone, and two offline-queue tests assert the ledger empties after a refused replay. Probe m1 below confirms all of them kill the mutation. What was genuinely unpinned is the retained direction. So instead of a standalone duplicate, one new test in `fresh-auth.test.ts` ("a spent-proof ledger entry survives a presentation whose own GETDEL rejects, and retires on the one whose GETDEL resolves") pins both directions in sequence: the entry and key survive a rejected `GETDEL`, then both go on the resolved one.

**Item 4.** Both split-tier tests assert `expect(delSpy).not.toHaveBeenCalled()`.

**AC1, technique.** A four-lens read-only sweep over both files at `6dd794d3`, each finding then handed to an independent refuter. The mechanical lens extracted every line comment, block comment and test title, stripped comment prefixes, joined consecutive comment lines into single-space paragraphs (217 in the source, 265 in the test), and matched 22 case-insensitive pattern families (conditional-backup: `whenever Redis`, `Redis[- ]success`, `dead code`, `backup.{0,60}(when|if|on|whenever|after|once).{0,40}(succe|healthy|available|resolv|land)` and similar; one-event: `one event`, `only event`, `leaves only`, `only (once|when|on|after|by).{0,80}(DEL|delete)`, ledger/entry near `expir|stale|age|TTL|dispatch` and similar). 49 hits, all read against the code, all false positives. Three semantic lenses then read every statement about the backup write, about ledger retirement, and every line the first commit added. They found two statements the patterns could not: the `isConsentOpSpent` docblock bounding the ledger by "confirmed sweeps" (one event named where there are two) and the cleanup docblock's "under no-Redis ops" (presupposes the conditional backup). Both fixed in `b80ebff1`, along with a space my first commit dropped from a test title. One conditional-backup sentence in the test file (the flap-recovery test's "writes a backup to memStore on Redis-issuance success") was fixed in `6dd794d3`.

**AC2 to AC4, probes.** Run serially in a scratchpad copy built with `git archive 6dd794d3 backend`, restored between mutants with `git show 6dd794d3:<path>` and `cmp`-verified at the end, so the shared checkout was never mutated and no `git checkout --` restore was needed. `b80ebff1` changes only comments and one test title, so the results carry.

| Probe | Mutation in `burnConsentOpEntry` | Killed by |
|---|---|---|
| baseline | none | 109 / 5 / 4 pass |
| m1 | remove `if (redisLegRan) spentConsentOps.delete(token);` | the new test (ledger size after the resolved `GETDEL`), the redis-unavailable-burn test named above, two offline-queue tests |
| m2 | make that delete unconditional | the new test ONLY (ledger size after the rejected `GETDEL`); the other two suites stay green |
| m3 | remove `redisLegRan = true;` | both split-tier tests, each at the new `delSpy` assertion, plus the new test |

**AC5.** Typecheck clean. Lint: 0 errors, 1 pre-existing warning in `src/lib/author-supersession.ts`, untouched. The three suites pass at `b80ebff1` run one file at a time (109, 5, 4). Run as one three-file invocation, the offline-queue suite's first test failed once on a vanished canonical key, which is the per-file keyspace flush collision the task's notes describe, not a regression.

**Out of scope, surfaced to the user rather than fixed.** The sweep confirmed four statements that are false or over-general but belong to neither retired model: the `fresh_auth.redis_getdel_failed` warn string promises "a compensating delete follows" on paths where none is issued (the new test drives one such path); the TTL-expiry describe comment in `fresh-auth.test.ts` says the in-memory guard is bypassed when Redis is available, though a nil reply falls through to it; and the `persistSessionSlide` docblock plus two test comments give "would recreate a key Redis has dropped" as the reason for skipping the write in cases where the key still stands.
