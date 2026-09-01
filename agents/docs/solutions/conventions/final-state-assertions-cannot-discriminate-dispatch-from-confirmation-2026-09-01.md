---
title: A final-state assertion cannot tell retire-on-dispatch from retire-on-confirmation — the discriminating sample is synchronous, taken in the gap between them
date: 2026-09-01
category: conventions
module: backend/tests
problem_type: convention
component: testing_framework
severity: high
root_cause: async_timing
resolution_type: test_fix
applies_when:
  - "Writing or reviewing a test for code that mutates local state only once an async operation CONFIRMS (a `.then()` drop, a post-`await` flag clear, a callback-gated eviction)"
  - "The candidate assertion polls or awaits the END state, while the mutation under claim changes only WHEN the local mutation happens, not whether it eventually happens"
  - "A fire-and-forget dispatch such as `void client.del(key).then(() => set.delete(key))`, where dropping on dispatch and dropping on confirmation converge on the happy path"
  - "Judging the reflex objection that a synchronous assertion placed right after a dispatching call is flaky because a real round-trip could beat it"
  - "Re-review intake on a claim that a test pins 'retire only on confirmation' or 'clear only after success' semantics"
symptoms:
  - "The spec passes identically against the correct code and against the mutation its title claims to kill, so there is no failure to investigate"
  - "The only load-bearing assertion is a `waitFor(...)` or post-`await` poll of the operation's final state"
  - "Moving the local mutation out of its `.then()` and onto the line after the dispatch leaves the whole suite green"
  - "A single-use credential stays replayable whenever its compensating delete later fails, with test coverage nominally in place"
related_components:
  - testing_framework
  - backend / lib / fresh-auth
  - authentication
tags:
  - mutation-testing
  - discriminating-assertions
  - vacuous-assertion
  - async-timing
  - microtask
  - fire-and-forget
  - at-most-once
  - reviewer-calibration
---

# A final-state assertion cannot tell retire-on-dispatch from retire-on-confirmation

## Context

`backend/src/lib/fresh-auth.ts` keeps a process-local ledger, `spentConsentOps`, of
single-use consent-op re-auth proofs that were burned while the canonical Redis copy
could not be confirmed removed. Membership is what refuses a replay: while a token sits
in the ledger, `isConsentOpSpent` answers yes and the burn refuses the presentation no
matter what Redis still holds. `drainSpentConsentOps` is the sweeper that retires
entries by deleting the orphaned canonical key.

The question that decides the ledger's correctness is *when* an entry may leave. Two
implementations look equivalent and are not:

```ts
// Retire on DISPATCH. The delete is fired; the entry goes immediately.
void redis.del(KEY_PREFIX + token).catch(() => {});
spentConsentOps.delete(token);
```

```ts
// Retire on CONFIRMATION. The entry goes only when the DEL resolves.
void redis
  .del(KEY_PREFIX + token)
  .then(() => { spentConsentOps.delete(token); })
  .catch(() => { /* unconfirmed: the entry stays for the next trigger */ });
```

A dispatched command is not an applied one. It can time out against a stalled-but-ready
server, or die with a socket whose close flushes it out of ioredis's resend lineage. The
on-dispatch shape therefore retires the only thing still refusing a spent proof while the
key it guards may still be readable, and the key can even come back with a *fresh full*
TTL, because ioredis resends an unreplied issuing `SET` at recovery when a TCP connect
intervened. That is a replayable single-use authorization proof, not a tidiness defect.

The test that was supposed to protect this asserted the end state:

```ts
_drainSpentConsentOpsForTests();
expect(await waitFor(() => _getSpentConsentOpsSizeForTests() === 0, 5_000)).toBe(true);
expect(await redis.exists(key)).toBe(0);
```

It passes under **both** implementations. Against a reachable Redis the two converge:
on-dispatch empties the ledger immediately, on-confirmation empties it a round-trip
later, and a `waitFor` cannot distinguish "already 0" from "0 shortly". The delete lands
either way, so the key check agrees too. The assertion was not weak. It was structurally
incapable of seeing the defect.

That blindness is why the same question stayed open across four consecutive review rounds
of one task. Three of them found the retirement rule wrong one layer deeper than the last:
first an entry stamped with a deadline snapshotted before the guarded key was even
written, then an entry dropped without sweeping the key it guarded, then an entry dropped
on the delete's dispatch rather than on its confirmation; the fourth closed the question
rather than deepening it (session history). No suite ever objected to any of the three,
because every one of them converges with the correct code whenever Redis is healthy, which
is the condition the fixtures provided.

## Guidance

**To discriminate dispatch from confirmation, assert synchronously in the window between
them.**

```ts
_drainSpentConsentOpsForTests();

// No `await` above this line since the dispatching call, so no `.then()`,
// microtask, or I/O callback can have run. Under an on-dispatch mutant the
// ledger is already empty here and this fails.
expect(_getSpentConsentOpsSizeForTests()).toBe(2);

// Then let the confirmations land.
expect(await waitFor(() => _getSpentConsentOpsSizeForTests() === 0, 5_000)).toBe(true);
```

This is deterministic, not racy, and the reason is worth stating plainly because it gets
misjudged: JavaScript is single-threaded and promise callbacks are queued, never
preemptive. `void redis.del(...).then(...)` cannot run its `.then()` until the current
synchronous block yields to the event loop. As long as no `await` separates the
dispatching statement from the assertion, no round-trip can "beat" it, however fast the
server is.

**Do not accept "that would be flaky" as self-evident.** During adversarial review of this
change, one of five verification lenses argued specifically against adding this assertion,
on the grounds that "a real Redis round-trip can beat the assertion and it would be flaky
rather than discriminating." That is false for the reason above. An interleaving claim is
checkable against the event-loop model rather than a matter of taste: identify the awaits
between the two points, and if there are none, there is no interleaving. The assertion was
added, and a mutation probe reintroducing the on-dispatch shape killed it in 9ms.

**Pair the state assertion with one behavioral test that makes the operation actually
fail.** The synchronous check pins *when* the retirement happens; it does not show *why*
that matters. Reaching a dispatched-then-rejected delete needs a failure mode most
harnesses do not have. Severing a connection will not do it: ioredis sets `close` before
any rejection that severing causes, so the client has already left `ready` and the command
never entered the dispatched-and-failing state. What works is stalling, in
`SeverableProxy.stall()` in
`backend/tests/lib/fresh-auth-consent-op-burn-offline-queue.test.ts`: unpipe both
directions and pause both sockets, holding the connection open while bytes stop. The
client stays `ready`, the `DEL` is genuinely dispatched, and it rejects on its own
`commandTimeout`. The test `retains the entry when the drain delete rejects with the
client still ready, and still refuses the replay` then shows the consequence directly, by
proving a replay is refused by the retained entry against a key that is still readable.

## Why This Matters

The failure is invisible to every ordinary signal. The suite is green, nothing throws, the
cleanup does happen, and the end state is identical. What differs is only the state of the
world during the window where the operation failed, which is exactly the window the safety
property lives in.

It is also the shape most likely to be introduced by a well-intentioned simplification.
Moving a mutation out of a `.then()` and onto the line after the dispatch reads as
removing needless asynchrony. Nothing in the test suite objects, and the reviewer sees a
smaller diff.

Vantage-point vacuity recurs on this surface, so treat a green assertion about a temporal
property as unproven until you can name what would make it red. A separate test in the
same task claimed to prove that a retained ledger entry refused a replay, and did not: the
client it replayed through was still severed and the in-memory backup had been emptied by
the first consume, so the refusal it observed came from tier absence and fired before the
ledger was ever consulted. It passed identically with the ledger entry dropped (session
history). Same family as the case above, different mechanism: an assertion positioned
where the thing it names cannot be what produced the result.

The generalization is broader than one Redis sweeper. Any "dispatch now, reconcile later"
pattern has the same blind spot when its tests assert only the settled state:

- fire-and-forget cleanups and compensating deletes
- optimistic local mutation awaiting server confirmation
- cache invalidation issued alongside a write
- queue acknowledgements, where acking on send rather than on completion loses the message
- retry bookkeeping that clears an entry before the retried call has succeeded

In each, the correct implementation and the premature one converge whenever the dependency
is healthy, which is exactly the condition a test fixture usually provides.

## When to Apply

Reach for this whenever local state is retired, cleared, or advanced in response to an
operation that can fail after being issued:

- Writing or reviewing a test for code that mutates in a `.then()`, a callback, or an
  `await` continuation, where moving that mutation earlier would still pass.
- Any guarantee phrased as "at most once", "exactly once", or "until confirmed", where the
  record of the pending state is what enforces it.
- Judging whether an existing test actually kills a mutant, rather than assuming it does
  because its name says so. A test title claiming a temporal property ("only once X
  lands") earns that claim only if some assertion is taken before X.
- Any review comment asserting a race or flakiness. Check it against where the awaits are
  before acting on it.

## Examples

### The test rename that forced the fix

The sweep test in `backend/tests/lib/fresh-auth-redis-unavailable-burn.test.ts` was
originally named for a property it did not pin. Renaming it to `sweeps every entry it
holds, retiring each only once its own delete lands` made the gap obvious: the second
clause had no corresponding assertion. Adding the synchronous size check made the name
true.

The test plants two entries rather than one, using `_setSpentConsentOpForTests`, so that a
drain which stops after its first entry also fails. Two independent mutants therefore die
here: retiring on dispatch, and truncating the loop.

### Why the state test alone is not enough

The synchronous assertion proves the ordering. It does not prove the ordering matters,
because with a healthy client the delete always lands and the entry always retires a
moment later. Only a test where the dispatched delete genuinely fails shows the security
consequence, and that is the one the stall mode exists for. The pair is the unit: one test
pins *when* the state changes, the other pins *what is lost* if it changes too early.

### Grounding the flakiness question

The general check, applied to the assertion above:

```ts
_drainSpentConsentOpsForTests();   // synchronous: dispatches N commands, returns
expect(_getSpentConsentOpsSizeForTests()).toBe(2);   // same synchronous block
```

`_drainSpentConsentOpsForTests` calls `drainSpentConsentOps`, whose body is a `for` loop
of `void redis.del(...).then(...)`. Every `.then()` is a queued continuation. The function
returns synchronously, control has not yielded, and the assertion runs in the same tick.
There is no point at which a network reply could be processed. The claim "a round-trip
could beat this" requires an `await` that does not exist.

## Related

- `agents/docs/solutions/conventions/concurrency-wire-shape-assertions-mutation-blind-under-microtask-fifo-2026-05-19.md`
  is the awaited half of the same rule and the closest neighbour in the corpus: same
  module, same test-only size-accessor idiom, same thesis that an assertion detects only
  what its vantage point can distinguish. It covers a `Promise.all` race whose outcome
  counts are made deterministic by microtask FIFO, and its fix samples state from inside a
  `mockImplementation` on a dependency the code awaits. This entry is the non-awaited half:
  no race, no mock, nothing awaited, and the convergence is between two mutation *timings*
  rather than between two race outcomes. Read them together; neither subsumes the other.
- `agents/docs/solutions/conventions/atomic-getdel-split-into-read-then-delete-reopens-replay-2026-08-25.md` is
  the production-side statement of the same distinction (a removal that was merely issued
  is not a removal that was applied, so an at-most-once primitive records the spend before
  attempting the removal and clears it only on confirmation). This entry is the test-side
  statement, and is substrate-independent.
- `agents/docs/solutions/conventions/tests-must-fail-on-mutation-of-code-under-test-2026-04-22.md` is the parent
  rule; `agents/docs/solutions/conventions/mutation-kill-claims-must-match-assertion-and-corpus-2026-05-15.md`
  covers kill claims that outrun their assertions.
- `agents/docs/solutions/test-failures/assertion-vacuity-from-upstream-bail-in-mocked-tests-2026-05-17.md` and
  `agents/docs/solutions/test-failures/positive-surface-gate-before-alpine-absence-assertion-2026-06-10.md` are
  the same genus by other mechanisms. The second is prior art for the reviewer half of this
  entry: a review round there prescribed a fix against an inverted timing premise, where
  the imagined flaky false-failure never existed.
- `agents/docs/solutions/conventions/mutation-probes-are-per-site-not-per-fix-2026-08-31.md` shares only the
  probe discipline. Its failure is incomplete site enumeration; this one is a single site
  whose probe could not have discriminated wherever it was aimed.
