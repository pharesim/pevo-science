---
title: "Splitting an atomic GETDEL into GET-then-DEL makes a single-use proof replayable, and gating the compensating delete on isRedisAvailable() instead of client existence silently removes the flap backstop"
date: 2026-08-25
category: conventions
module: backend/src/lib
problem_type: convention
component: authentication
severity: high
applies_when:
  - A stored value must be read to discover its kind or shape BEFORE deciding whether to consume it, so an existing atomic GETDEL / SET NX / Lua CAS looks like it has to become a plain GET
  - Adding a second variant to a single-use primitive (a multi-use bounded window, a sliding session, a peek-then-decide path) where the discriminator lives inside the stored value
  - The reply of a Redis del, setnx, or expire is what ARBITRATES a security outcome (burn winner, lock winner, one-shot authorization) rather than being best-effort bookkeeping
  - Writing or reviewing a dual-tier primitive (Redis canonical plus an in-process Map flap backup) where an entry is written to BOTH tiers at issuance and must be removed from both at consume
  - Reaching for the house `if (redis && isRedisAvailable())` guard on a delete, cleanup, or compensating write, as opposed to a read or a cache fill
  - Writing a Redis-flap test by rejecting a single command; verify the branch under test is actually reached, because a rejected command leaves isRedisAvailable() true and never enters a readiness-gated leg
  - Reviewing any change to consumeFreshAuthToken, consumeSessionFreshAuthToken, consumeFreshAuthProof, or consumeUploadToken
related_components:
  - redis
  - authentication
  - ipfs-upload-token
tags:
  - redis
  - getdel
  - atomicity
  - read-then-mutate
  - single-use-token
  - fresh-auth
  - replay
  - is-redis-available
  - ioredis-offline-queue
  - compensating-delete
  - adversarial-verification
  - mutation-confirmation
---

# Splitting an atomic GETDEL into GET-then-DEL makes a single-use proof replayable, and gating the compensating delete on isRedisAvailable() instead of client existence silently removes the flap backstop

## Context

`backend/src/lib/fresh-auth.ts` mints short-lived re-auth proofs for JWT-session users and spends
them on critical actions: set-password, change-email, delete-account, IPFS upload-token issuance,
admin authority ops, and the consent and credit ops. Storage is two-tier. Redis is canonical, and
an in-process `memStore` `Map` is written at issuance as a flap backup, so a Redis outage between
issue and consume does not tell a user that the proof they minted two seconds ago expired.

Consumption used to be one Redis command:

```ts
// previous shape
if (redis && isRedisAvailable()) {
  try {
    raw = await redis.getdel(KEY_PREFIX + token);   // atomic read-and-remove
  } catch (err) { /* logged; fall through to the in-memory tier */ }
}
```

`GETDEL` is atomic: a non-nil reply proves this caller is the one that removed the entry, so "did I
win the burn?" and "what was stored?" are answered by the same round trip. The in-memory fallback
leg additionally fired a best-effort compensating delete, guarded on the client's **existence**,
not its readiness:

```ts
if (consumedFromMemStore && redis) {
  try { await redis.del(KEY_PREFIX + token); } catch (err) { /* best-effort */ }
}
```

Then a second proof kind arrived: a session proof that is multi-use inside a bounded window
(validate, slide the idle deadline, never delete). The kind is only knowable from the stored value,
so the read *had* to become non-destructive. A `GETDEL`-first read would spend a whole session
window just to discover that it was a session window.

The refactor that followed is the natural one, and it is wrong in two independent ways:

```ts
// THE REGRESSION. Read non-destructively for kind discovery...
const raw = await redis.get(KEY_PREFIX + token);
// ...then, for the single-use kind, let a separate DEL's reply arbitrate the burn.
if (redis && isRedisAvailable()) {                            // (2) readiness guard
  burnedInRedis = (await redis.del(KEY_PREFIX + token)) > 0;  // (1) no longer atomic
}
const burnedInMemStore = memStore.delete(token);
return burnedInRedis || burnedInMemStore;
// ...and the compensating delete was dropped as apparently redundant.
```

Both defects are replay of a spent single-use proof. Either one lands without the other.

**Defect 1: the burn stopped being atomic.** `GET` then `DEL` is two commands. A `DEL` that rejects
mid-flight (connection drop, the module's per-command timeout, `maxRetriesPerRequest` exhaustion)
leaves the canonical Redis entry alive, while `memStore.delete(token)` still returns `true` and the
`||` reports a win. The consume returns valid, the critical action proceeds, and once ioredis
reconnects inside the TTL the same proof reads straight back out of Redis and authorizes a second
one. Under `GETDEL` that interleaving does not exist: the reply and the removal are the same event.

**Defect 2: the compensating delete moved behind a stricter guard.** `isRedisAvailable()` is
`status === 'ready'`, and `getRedis()` deliberately keeps returning the same cached client across a
flap rather than nulling it. So during *any* reconnect the readiness guard skips the Redis delete
entirely, while the entry was written to both tiers at issuance and the in-memory delete happily
arbitrates the win. The old compensating delete was guarded on client existence precisely because
ioredis queues commands while offline and flushes them on reconnect; gating it on readiness is
exactly what removed that recovery. This defect needs no failing command at all, only a reconnect
window that spans the consume.

The in-process `inFlightConsumes` lock does not help. It serializes *concurrent* consumes of one
token within the single process; a replay after reconnect is sequential and walks straight through
it.

Blast radius is wider than "the same action twice". The per-user critical targets
(`setPasswordFreshAuthTarget`, `changeEmailFreshAuthTarget`, `deleteAccountFreshAuthTarget`,
`ipfsUploadFreshAuthTarget`, `adminActionFreshAuthTarget`) all bind
`{ action, root_author: username, root_permlink: '' }` and never the operation payload. A second
consume is therefore not constrained to the same *effect*: two different `new_email` values, two
upload tokens, or two admin grants, under one re-authentication act.

## Guidance

**When you split an atomic operation for a reason unrelated to atomicity, name what the atomicity
was buying and re-establish it on the narrowed path.** The reason to split here was kind discovery,
not burn semantics. So split for kind discovery only, and keep the atomic primitive on the leg that
still needs it:

```ts
// readFreshAuthEntry — non-destructive, both tiers, reports which one answered.
const raw = await redis.get(KEY_PREFIX + token);
if (raw) return { raw, fromMemStore: false };
```

```ts
// burnConsentOpEntry — the burn stays a single atomic command.
let burnedInRedis = false;
let redisLegRan = false;
const redis = getRedis();
if (redis && isRedisAvailable()) {
  try {
    burnedInRedis = (await redis.getdel(KEY_PREFIX + token)) !== null;
    redisLegRan = true;                       // only set AFTER the reply lands
  } catch (err) { /* logged; the in-memory tier arbitrates */ }
}
const burnedInMemStore = memStore.delete(token);

// Compensating delete for the case where the readiness-gated leg did not run at
// all. Guarded on the client's EXISTENCE only: ioredis queues it offline and
// flushes it on reconnect, which is the entire point.
if (!redisLegRan && burnedInMemStore && redis) {
  try { await redis.del(KEY_PREFIX + token); } catch (err) { /* best-effort */ }
}
return burnedInRedis || burnedInMemStore;
```

The winning path now issues `GET` then `GETDEL`. That is one extra round trip, and it is the price
of a discriminated store. The thing that must not be split is *read-and-remove*, not *read*.
`redisLegRan` is set after the await resolves, so it is false both when the guard skipped the leg
and when the command rejected; the compensating delete covers both.

**When you move a best-effort compensating call behind a stricter guard, find out what the looser
guard was for.** "Every other Redis call site in this file is wrapped in
`if (redis && isRedisAvailable())`" is a real consistency argument and the wrong one here. The
compensating delete is not a normal read or write. It exists specifically for the window in which
the client is not ready, so guarding it on readiness makes it dead code in the one situation it was
written for. A guard that is deliberately looser than its neighbours is a signal, not an oversight;
treat an unexplained asymmetry as load-bearing until you can say what it bought.

**Keep the two-tier delete symmetric.** The in-memory delete runs unconditionally, so a Redis-side
burn also clears the backup. Otherwise a sibling consume replays through the fallback tier.

**Scope: this rule is about state whose survival is an exposure, not about TTL'd self-healing
state.** It does not overturn the readiness-gated `return` on lock acquire and release in
`redis-advisory-lock-with-lua-cas-nonce-2026-05-15.md`, or the readiness-gated lock-TTL `expire` in
`chain-write-timeout-ambiguous-outcome-2026-04-22.md`. Both are correct: a lock that fails to
release lapses on its own and the worst case is a delayed retry. A single-use credential that fails
to burn does not lapse into safety; it lapses into a second authorization.

## Why This Matters

The failure is invisible in every ordinary sense. The suite is green. Nothing throws. The user sees
a successful action. The audit trail shows one re-authentication. What actually happened is that a
spent proof stayed alive in the canonical tier for the remainder of its TTL and a retrying client,
or whoever captured the proof out of the earlier request body, got a second critical action out of
one consent.

It is also cheap to reintroduce, because both defects are what a careful engineer writes when the
stated reason for the change is something else entirely. Nobody set out to weaken the burn. The task
was "add a windowed kind"; atomicity and the odd-looking guard were collateral.

The deployment facts flatter the mistake, too. PEvO is single-instance forever, so the in-process
lock genuinely closes the concurrent double-consume race, which makes it easy to conclude that
single-use is already covered by the lock. It is not: the lock covers overlap, not sequence.

## When to Apply

Reach for this before touching any of the following.

- A single-use token, nonce, one-time code, idempotency key, or claim check, in any store. Anything
  whose contract is "at most once".
- A refactor that turns one command into two against the same key, for any reason: adding a
  discriminator, logging the old value, validating before deleting, returning richer data.
- A change to a call-site guard on a cached-across-reconnect client. Here that is `getRedis()`
  (client existence, survives a flap) versus `isRedisAvailable()` (`status === 'ready'`, false
  throughout a reconnect). They are not interchangeable, and picking the wrong one fails silently in
  one direction only.
- Any code where an in-memory tier can arbitrate a decision the durable tier was supposed to own.
- Adding a second variant to a primitive whose existing semantics were enforced by the *choice of
  storage command* rather than by branching logic. Those semantics are invisible in the control flow
  and are the first thing a variant-adding refactor eats.

Also apply when reviewing. If a diff replaces an atomic store primitive with a compound sequence,
the burden is on the diff to say what re-establishes the guarantee, and a review that reads only the
new code will not notice, because the new code is internally coherent.

## Examples

### The detection lesson

The full suite was green, including a suite literally named for symmetric dual-tier deletion. That
suite simulated a Redis flap by rejecting **one** command:

```ts
vi.spyOn(redis, 'get').mockRejectedValueOnce(new Error('simulated Redis flap on read'));
```

It rejected the read, left the burn live, and `isRedisAvailable()` stayed true throughout, so the
consume took a completely different branch from either defect. It passed under the broken code and
would have kept passing. A test that rejects one command tests one branch, not "Redis is unhealthy".

It was found by an adversarial verification pass asked to *refute* a specific claim: "a consent-op
proof can still be consumed at most once." That pass enumerated the branches of the burn by hand
rather than running anything. The prompt shape is the point. "Review this change" would not have
produced it; "here is an invariant, break it" did.

Two test shapes reach the defects, and they are different shapes.

**Defect 1** is reachable in the main suite by rejecting the *burn* command instead of the read, and
asserting on a replay after recovery:

```ts
const burnSpy = vi.spyOn(redis, 'getdel').mockRejectedValueOnce(new Error('simulated flap on the burn'));
const first = await consumeFreshAuthToken(issued.token, 'flap-burn', TH);
expect(first.valid).toBe(true);
burnSpy.mockRestore();

// Redis is "recovered": the entry must be gone from IT, not merely from the backup tier.
const replay = await consumeFreshAuthToken(issued.token, 'flap-burn', TH);
expect(replay.valid).toBe(false);
```

**Defect 2 is not reachable that way at all**, and that is why it survived. A rejected command
leaves `isRedisAvailable()` returning true, so no amount of command-level mocking enters the
readiness-skipped branch. It needs its own file with a stubbed readiness predicate and a real
client:

```ts
const { redisReady } = vi.hoisted(() => ({ redisReady: { value: true } }));
vi.mock('../../src/redis.js', async (importActual) => {
  const actual = await importActual<typeof import('../../src/redis.js')>();
  return { ...actual, isRedisAvailable: () => redisReady.value };   // getRedis stays REAL
});
```

```ts
const issued = await issueFreshAuthToken('flap-window', 'password', TARGET);

redisReady.value = false;                       // mid-reconnect for the WHOLE consume
expect((await consumeFreshAuthToken(issued.token, 'flap-window', TARGET_HASH)).valid).toBe(true);

redisReady.value = true;                        // reconnected
const replay = await consumeFreshAuthToken(issued.token, 'flap-window', TARGET_HASH);
expect(replay.valid).toBe(false);               // fails without the compensating delete
```

Only the readiness predicate is stubbed. `getRedis` is not, so the real client, real keyspace, and
real TTLs are used and "the canonical entry is gone" is a genuine round trip rather than a property
of the mock. That split is what makes the test worth trusting, and it is the minimum the test-mock
carve-out asks for: the file header names which real path is impractical (killing the container
mid-call and winning a race against ioredis's reconnect backoff) and names the real-path companion
for the same risk class.

The companion test in the same file is the other half of the contract, and it is easy to forget: a
flap must still authorize the *first* consume. Otherwise a "fix" that simply refuses to consume
whenever Redis is unhealthy passes the replay test and reintroduces the lockout the backup tier
exists to prevent.

### The mutation probe

Neither test was trusted until it was shown to kill. With the fix **committed** (a `git checkout`
restore wipes uncommitted edits and invalidates the probe), each defect was reintroduced in
isolation and the suite re-run:

- swap `getdel` back to `get` plus a separate readiness-gated `del`, and the rejecting-burn test must
  go red;
- delete the `!redisLegRan && burnedInMemStore && redis` compensating leg, and the stubbed-readiness
  file must go red.

Then restore. A test written against a bug you already fixed proves nothing until you have watched
it fail, and doubly so here, where the neighbouring test with the right *name* was passing under
both defects the whole time.

## Cross-references

- `conventions/redis-multi-rejection-retry-precondition-isredisavailable-2026-05-19.md` names the
  same downstream consequence (a delete that did not commit leaves the canonical row alive) from the
  opposite direction: it is about how a TEST must force `isRedisAvailable()` false to reach a
  fallback leg. This entry is about how PRODUCTION must not consult it on a compensating delete. Read
  as a pair.
- `conventions/chain-write-timeout-ambiguous-outcome-2026-04-22.md` and
  `conventions/redis-advisory-lock-with-lua-cas-nonce-2026-05-15.md` are the readiness-gated cases
  this rule deliberately does not touch. See the scope paragraph under Guidance.
- `backend/src/lib/ipfs-upload-token.ts` (`consumeUploadToken`) still carries the original shape:
  atomic `getdel` plus an existence-guarded compensating `del` on the fallback leg. It is the
  surviving reference implementation, and its docblock claims it mirrors the fresh-auth primitive.
  That mirror claim is a two-way obligation. The two now cover different flap classes (fresh-auth
  also covers the readiness-skip case), so the claim is imprecise until one of them is brought into
  line.
