---
title: "Splitting an atomic GETDEL into GET-then-DEL makes a single-use proof replayable, and gating the compensating delete on isRedisAvailable() instead of client existence silently removes the flap backstop"
date: 2026-08-25
last_updated: 2026-09-07
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
  - Relying on a client's offline queue to carry a command across an outage, on any path where that command's eventual execution is what establishes a security property rather than tidying up after one
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
  - at-most-once
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
arbitrates the win. The old compensating delete was guarded on client existence so that ioredis
would at least queue it and get a chance to flush it on reconnect; gating it on readiness removed
even that attempt. This defect needs no failing command at all, only a reconnect window that spans
the consume.

Note what that sentence does *not* claim, and what an earlier version of this entry asserted as
settled fact: queuing the delete is an attempt at recovery, not a guarantee of one.

**Defect 3: the queued delete is bounded by the retry budget, so it cannot be the guarantee.**
Found later, by an adversarial pass over the fix for Defects 1 and 2. ioredis does not hold an
offline-queued command indefinitely. Its reconnect handler flushes the **entire** offline queue with
`MaxRetriesPerRequestError` whenever the reconnect count reaches a multiple of
`maxRetriesPerRequest + 1`. On this client (`maxRetriesPerRequest: 3`, `retryStrategy` of
`min(times * 200, 5000)`) that lands a little over a second into an outage, on the fourth close
after delays of 200, 400 and 600ms, which an ordinary Redis restart comfortably outlasts. Past that point the queued delete is discarded unsent, the canonical
copy stands for the rest of its TTL, and the replay is back — with the compensating delete present,
correctly guarded, and doing nothing.

So Defect 2's fix is necessary and not sufficient. A guard that lets the command be queued is
strictly better than one that drops it on the floor. But "the command will eventually run" is not a
property the client offers, and a security guarantee cannot rest on it.

The in-process `inFlightConsumes` lock does not help. It serializes *concurrent* consumes of one
token within the single process; a replay after reconnect is sequential and walks straight through
it.

Blast radius is wider than "the same action twice". Every target builder in the per-user critical
family binds `{ action, root_author: username, root_permlink: '' }` and never the operation payload:
the `PER_USER_CRITICAL_ACTION_TUPLE` actions, plus the set-password and admin builders. (Anchor on
that tuple rather than a hand list. This paragraph originally named five builders and was already
missing one on the day it was written, because the sixth had arrived from an unrelated task.) A second
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
// Sampled BEFORE the awaits, inside the existing per-token critical section, so
// the decision rests on the state as it was on entry: the record can be retired
// concurrently by the drain, which the critical section does not serialize
// against. A proof recorded as spent is refused whatever either tier reports.
const alreadySpent = isConsentOpSpent(token);

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

if (alreadySpent) {
  // Refuse — and note this is one of only TWO events that may retire the
  // record. A GETDEL that RESOLVED proves the canonical copy is gone, so the
  // refused replay cleans up after itself. A GETDEL that threw proves nothing,
  // and the record stays for the drain to finish.
  if (redisLegRan) spentConsentOps.delete(token);
  return false;
}

// Compensating delete for the case where the leg did not run at all. Still
// guarded on the client's EXISTENCE only, so ioredis can queue it and flush it
// if the outage is short. Best-effort CLEANUP, NOT the guarantee.
if (!redisLegRan && burnedInMemStore && redis) {
  // Arm the reconnect sweep alongside the ledger write: this branch is the only
  // thing that ever gives that sweep work to do. Like the delete, the sweep is
  // cleanup and not the guarantee — what it buys is that an orphaned canonical
  // key does not outlive the ledger entry guarding it, which is what makes a
  // later restart safe.
  armDrainOnReady(redis);
  // Record the spend FIRST. A record written before the command survives that
  // command failing, timing out, or being flushed unsent. Membership is the
  // WHOLE record — no deadline: a resent issuing `SET` restarts its `EX` from
  // recovery, so none computable here can bound the key's life.
  spentConsentOps.add(token);
  try {
    await redis.del(KEY_PREFIX + token);
    spentConsentOps.delete(token);   // confirmed gone; nothing left to guard
  } catch (err) { /* the ledger still refuses the replay */ }
}
return burnedInRedis || burnedInMemStore;
```

The winning path now issues `GET` then `GETDEL`. That is one extra round trip, and it is the price
of a discriminated store. The thing that must not be split is *read-and-remove*, not *read*.
`redisLegRan` is set after the await resolves, so it is false both when the guard skipped the leg
and when the command rejected; the compensating delete covers both.

**A primitive whose contract is "at most once" needs a record of the spend that survives the
compensating command never running.** This is the part that took two passes to see. Once the burn is
arbitrated by a tier that is not the canonical one, no amount of care about *how* the canonical copy
gets removed can establish single-use, because every version of that removal is a command that may
not execute. The durable fact has to be "this proof was spent", recorded before the removal is
attempted and retired only once the removal is confirmed — not "this proof's canonical copy was
removed", inferred from a command that was merely issued.

Order matters and is the whole trick: write the record, then attempt the delete, then clear the
record only on a confirmed reply. Written in that order the record survives every way the delete can
fail. Written the other way round it is decoration.

**Give the record no expiry at all. Retire it only on a reply that proves the guarded key is
unreadable.** Membership is the whole record. An entry leaves on exactly two events: a compensating
delete that RESOLVED, or a later presentation's `GETDEL` that resolved. A command that was merely
dispatched proves nothing — it can still time out against a stalled-but-ready server, or die with a
socket whose close flushes it out of the resend lineage — so retiring on dispatch retires the one
refusal left standing while the key is still there.

The tempting alternative is a deadline that **dominates** the canonical copy's, stamped from the
burn on the reasoning that the burn necessarily happens after the canonical `SET` executed. That
reasoning is false, and the way it fails is worth knowing because it is invisible from the call
site. When the issuing `SET` never got a reply, ioredis retains it and resends it at recovery
(`autoResendUnfulfilledCommands` defaults true); Redis applies `EX` relative to *execution* time, so
the resurrected key's life restarts from recovery and outruns any deadline computed at burn time.
No clock available on this side of the connection can bound the key's life. A deadline can therefore
only ever retire an entry EARLIER than a confirmation would, which is the one direction that reopens
the replay.

What that costs is a record with no time bound: while the canonical store is unreachable, or is
reachable but refusing writes, entries accumulate and nothing retires them. Take that trade
deliberately and say so where the record is declared. Retention only ever refuses a proof that was
already spent, growth is one entry per unconfirmed burn, and each entry costs an attacker whatever
minting a proof costs. Retiring on a server-replied error instead would trade that bounded growth
for a guess that the error implies the key is unreadable, which no permission or persistence failure
actually tells you.

The scope of such a record is the scope of the tier that arbitrated the burn. Here that is one
process, which is exactly as durable as the `memStore` whose win it is backstopping — past a
restart, Redis is the sole arbiter either way. A cross-process deployment would need this record to
be as durable as the canonical tier, which is a different and much heavier design.

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

**The second probe stopped killing, and why is the more useful lesson.** Once the spent-proof record
landed, it — not the compensating delete — was what refused the replay, so deleting the compensating
leg left every suite green. The delete still earns its place: it retires the record promptly and
keeps an orphaned canonical key from outliving the process-local entry guarding it. That demoted
role was pinned by no assertion, which is exactly how a later refactor reading it as dead weight
would have removed it unopposed. When a new layer takes over a guarantee an older layer used to
provide, the older layer's mutation probe goes quiet without anyone editing a test. Re-run the
probes a fix supersedes, and re-pin the demoted layer against what it still does.

That re-pin has since landed. Both flap tests now assert the canonical key's absence directly,
before any replay, rather than inferring it from a second consume — the only assertion that
distinguishes the delete from the record, and what re-arms both probes.

Then restore. A test written against a bug you already fixed proves nothing until you have watched
it fail, and doubly so here, where the neighbouring test with the right *name* was passing under
both defects the whole time.

## Cross-references

- `agents/docs/solutions/conventions/redis-multi-rejection-retry-precondition-isredisavailable-2026-05-19.md` names the
  same downstream consequence (a delete that did not commit leaves the canonical row alive) from the
  opposite direction: it is about how a TEST must force `isRedisAvailable()` false to reach a
  fallback leg. This entry is about how PRODUCTION must not consult it on a compensating delete. Read
  as a pair.
- `agents/docs/solutions/conventions/chain-write-timeout-ambiguous-outcome-2026-04-22.md` and
  `agents/docs/solutions/conventions/redis-advisory-lock-with-lua-cas-nonce-2026-05-15.md` are the readiness-gated cases
  this rule deliberately does not touch. See the scope paragraph under Guidance.
- `backend/src/lib/ipfs-upload-token.ts` (`consumeUploadToken`) still carries the original shape:
  atomic `getdel` plus an existence-guarded compensating `del` on the fallback leg, and no record of
  the spend. Its docblock claims it mirrors the fresh-auth primitive, and that mirror claim is a
  two-way obligation. What actually diverges is narrower than it first looks. Defect 2 never applied
  there: that compensating delete was guarded on the client's existence from the start. Defect 3 does
  apply, since there is no record of the spend behind a delete the offline queue can flush unsent.
  The inline comment at the compensating delete already concedes the residual window it leaves; the
  overclaim is in the module docblock above it, which still states flatly that single-use is enforced
  by the `GETDEL` and the delete-on-read. What contains the impact there today is not the delete but
  the `file_sha256` re-verification at the pin route and the independent pin cap. Treat the
  divergence as a correctness-of-claim problem: either mirror the record, or downgrade the module
  docblock to describe the containment that actually applies. The trap is a future change that
  widens what an upload token authorizes while reasoning from the older claim.
- `agents/docs/solutions/conventions/final-state-assertions-cannot-discriminate-dispatch-from-confirmation-2026-09-01.md`
  is the test-side statement of the rule this entry makes about production: a command that was merely
  issued is not a command that was applied. It shows why a suite cannot notice the difference - an
  assertion on the settled state converges under both shapes whenever Redis is healthy - and what a
  discriminating assertion looks like. Read it before trusting any green test that claims to pin the
  record-then-delete-then-retire ordering prescribed above.
- `agents/docs/solutions/conventions/fail-closed-guard-must-replace-the-recovery-a-round-trip-provided-2026-09-07.md` is
  this entry's opening rule playing out in the frontend. A fail-closed type guard added ahead of an
  upload request deleted the remintable-401 handler that had been evicting a poisoned proof cache as
  a side effect, so a condition that healed itself on the next attempt became a lockout for the rest
  of the cached entry's life. Different subsystem, no atomicity involved, same check: name what the
  step you are removing was buying before you remove it. Read as the pair that generalizes the rule
  beyond Redis.
