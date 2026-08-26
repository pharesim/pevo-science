---
title: "Spot-checking a few members of an unordered collection is mutation-blind to a truncating batch operation — count survivors across the whole set"
date: 2026-08-26
category: conventions
module: backend/tests
problem_type: convention
component: testing_framework
severity: medium
applies_when:
  - "Testing an operation that processes a collection in chunks, batches, pages, or slices"
  - "The collection's iteration order is unspecified — a Redis SET read with SMEMBERS, a JS Set or Map built from concurrent writes, an unordered SQL result, a directory listing"
  - "The mutation you mean to kill is a TRUNCATION: only the first batch is processed, the loop bound is wrong, the pagination cursor is never advanced"
  - "The candidate assertion names a handful of specific members and asserts something about those"
  - "A test passes only on a vitest/jest retry rather than on its first attempt"
tags:
  - mutation-testing
  - unordered-collections
  - redis
  - batching
  - test-sampling
  - flaky-tests
related_components:
  - testing_framework
  - backend / lib / fresh-auth
---

## Context

`invalidateSessionFreshAuthTokens` in `backend/src/lib/fresh-auth.ts` sweeps a per-user
Redis SET of outstanding session-proof tokens and deletes the entry behind each member.
It used to spread every member into one `del(...members)` call, which reaches the
engine's argument limit on a large enough index and throws `RangeError` — so the sweep
BROKE rather than degrading, and it broke for exactly the accounts with the most open
windows. The fix was to delete in fixed-size chunks.

The first test written for that fix planted real token keys behind three of 1201 index
members and asserted those three were gone after the sweep. It looked like a reasonable
"swept completely is observable rather than inferred" assertion.

It passed against a deliberately truncating mutant — a sweep rewritten to
`del(...tokens.slice(0, 500))`, dropping roughly 700 members on the floor.

The reason is that `SMEMBERS` returns hash order, not insertion order. Which members
land in the surviving tail is not a property the test controls, so a three-member sample
is three coin flips. The test was not deterministic-and-wrong; it was
non-deterministic-and-usually-lucky, which is worse, because the runner's automatic
retry re-rolled the dice and reported a pass.

The blindness was caught only because the fix was committed BEFORE the probes ran, so
reverting the chunking to see the test go red was a `git checkout` away. It did not go
red. Had the probe run against an uncommitted tree there would have been no safe way to
revert one change and restore it, and the weak assertion would have shipped.

## Guidance

When the operation under test batches over a collection whose order you do not control,
do not name members. **Assert an aggregate over the entire set**, so no sampling
decision is being made at all:

```typescript
// WRONG — three coin flips against a truncating mutant. SMEMBERS returns hash
// order, so which members survive is not a property this test controls.
await Promise.all(
  planted.slice(0, 3).map((t) => redis.set(TOKEN_PREFIX + t, '{}', 'EX', 300)),
);
await invalidateSessionFreshAuthTokens(username);
expect(await redis.exists(TOKEN_PREFIX + planted[0])).toBe(0);
expect(await redis.exists(TOKEN_PREFIX + planted[2])).toBe(0);
```

```typescript
// RIGHT — an entry behind EVERY member, and a survivor count over all of them.
// A 500-truncated sweep leaves a deterministic 701.
const pipeline = redis.pipeline();
for (const t of planted) pipeline.set(TOKEN_PREFIX + t, '{}', 'EX', 300);
await pipeline.exec();

await invalidateSessionFreshAuthTokens(username);

let survivors = 0;
for (let i = 0; i < planted.length; i += 500) {
  survivors += await redis.exists(...planted.slice(i, i + 500).map((t) => TOKEN_PREFIX + t));
}
expect(survivors, 'every indexed window must be deleted, not just the first batch').toBe(0);
```

Three properties make the second form work:

1. **No sampling.** Every member carries an observable, so the assertion cannot be
   satisfied by luck about which ones the mutant happened to reach.
2. **A count, not a membership check.** `survivors` is a number the failure message
   reports (`expected 701 to be +0`), which names the size of the gap rather than just
   the fact of one. That is the difference between "something is wrong" and "roughly 700
   members were never processed."
3. **A size well past the batch boundary.** Pick a corpus that spans several chunks —
   1201 against a chunk of 500 crosses two boundaries and leaves a remainder. A corpus
   smaller than one chunk cannot distinguish a chunked implementation from an unchunked
   one at all.

Setup cost is not a reason to sample. A `pipeline()` plants 1201 keys in a single
round-trip and the whole test runs in tens of milliseconds.

**Treat a retry-only pass as a finding, not as noise.** When a test fails its first
attempt and passes on retry with no concurrency in play, the assertion is reading
something the test does not control. Investigate the source of the variance before
accepting the green bar — that variance is usually the same hole a mutant will walk
through.

## Why This Matters

The generalization beyond Redis: a **truncating** mutation and an **unordered** corpus
compose into a specific blindness that neither produces alone. Against an ordered
corpus, sampling the first and last elements kills a truncation immediately. Against an
unordered corpus with an operation that touches everything, sampling is fine because
every member has the same fate. It is only the combination — unspecified order plus a
mutant that processes a prefix of that order — where a sample's outcome becomes a
property of the runtime rather than of the code.

The failure mode is also self-concealing in a way most weak assertions are not. A test
that asserts nothing is visibly vacuous on inspection; this one asserts something
specific and real, and reads as thorough. Its weakness is only visible by running the
mutant, and even then only if you notice that the pass came on a retry.

The same shape appears anywhere a batch bound meets an unordered source:

- `SCAN`/`SMEMBERS`/`HGETALL` feeding a chunked `DEL`, `SREM`, or `HDEL`.
- A paginated API sweep where the cursor is never advanced past page one.
- `readdirSync` feeding a batched file operation — directory order is filesystem-defined.
- A `Set` or `Map` populated by concurrent writes, then drained in slices.

## When to Apply

Reach for the survivor-count form whenever both halves are present: the corpus order is
unspecified, and the mutation class you are trying to kill would process a *subset*.
When only one half is present, naming a few members is fine and cheaper.

Related: `mutation-kill-claims-must-match-assertion-and-corpus-2026-05-15.md` is the
parent principle — a kill claim must actually match the corpus it runs against. This
entry is the specific case where the corpus's ORDER, not its content, is what defeats
the claim. `concurrency-wire-shape-assertions-mutation-blind-under-microtask-fifo-2026-05-19.md`
is the sibling case where engine scheduling, rather than collection order, collapses the
mutation difference before it becomes observable.
