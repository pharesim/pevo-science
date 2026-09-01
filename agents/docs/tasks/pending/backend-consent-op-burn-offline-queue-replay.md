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

---

## Backend implementation note (2026-08-27, commit e85d845c)

**Direction chosen for scope item 1: "give the burn a durable record".**

Rejected "bound the ambiguity" (report the burn as something other than a clean
success when the compensating delete cannot be confirmed) because the burn's
return value is already fully consumed as a pass/fail on the CURRENT request:
`consumeFreshAuthTokenForSurface` maps `false` to `expired`. There is no third
outcome to widen it to without inventing a new reason code and teaching every
caller what to do with "authorized, but the proof may be replayable" — which is
not a decision any route handler can act on. The scope note itself says the
current request must still succeed, so the ambiguity has to be recorded
somewhere rather than returned.

What landed instead is a process-local `spentConsentOps` ledger in
`fresh-auth.ts`:

- The burn records the proof as spent BEFORE issuing the compensating delete,
  and clears the record only once the delete is confirmed to have landed. The
  ordering is the whole point: a record written first survives the delete
  failing, timing out, or being flushed unsent.
- Every later presentation consults the ledger under the existing
  `inFlightConsumes` critical section and is refused whatever the storage tiers
  report, so single-use no longer rests on a command that may never flush.
- Ledger entries retire on any of three events: a confirmed compensating
  delete, a later presentation's `GETDEL` proving the canonical copy gone (the
  refused replay cleans up after itself), or the ledger entry's OWN deadline.
  (Corrected in round 2: that deadline is burn time plus a full TTL, and is
  deliberately later than the proof's own expiry. An entry that retires while
  the key it guards is still readable is the one shape that reopens the replay,
  so the ledger has to outlive the canonical copy rather than match it.)
- The existing `memStore` cleaner also drains still-pending compensating
  deletes. That is not what closes the hole (the ledger is), but it stops an
  orphaned canonical key from outliving the process-local entry guarding it.
  (Corrected in round 2: the drain now also runs on the Redis client's next
  `ready` transition, so recovery no longer waits for a cleanup tick. See the
  residual paragraph below for which arm each trigger actually covers.)

The compensating delete is KEPT and its client-existence guard is KEPT. Gating
it on `isRedisAvailable()` would still be wrong for the reason the convention
entry gives. What changed is that it is no longer treated as the thing that
establishes single-use.

**AC2 (flap-recovery preserved)** is unchanged by construction: nothing was
added to the issue or read paths, and the ledger is only ever written at burn
time. A blip between issue and consume still resolves out of `memStore` and
returns `valid`. The new test asserts this directly on the first consume.

**Residual, stated plainly** (rewritten in round 2 so it matches the code rather
than the intent): the ledger is process-local, so a backend restart before the
compensating delete has actually landed drops it, and the orphaned canonical key
is then readable for the rest of its TTL with nothing left to refuse it. Two
triggers can land that delete, and which one applies depends on how the entry
came to be written:

- Entry written while the client was off `ready` and going to re-enter it. That
  is the mid-flap case AND a connection that dropped mid-`GETDEL`: ioredis sets
  `close`/`reconnecting` the moment the socket closes, which is strictly before
  any rejection the drop can produce, so the arming that follows that throw is in
  place for the recovery `ready`. The unsafe window is "until the client is next
  ready", not "until a tick coincides with a ready client".
- Entry written by a `commandTimeout` against a connected-but-stalled server.
  Here the socket stays open, the client never leaves `ready`, and no transition
  follows, so the 60s cleanup tick is the SOLE sweeper and the unsafe window is
  up to a full interval. This is also where an operator is most likely to bounce
  the backend, since a stalled Redis presents as a hanging API.
  (This split was itself wrong when first written in round 2 — the mid-command
  drop was filed under the tick-only arm — and was corrected after probing the
  behaviour against the installed ioredis. The code was always right; only the
  recorded residual was too pessimistic.)

Also newly accepted in round 2: a ledger entry now deliberately outlives the
canonical key it guards by up to a TTL, so `spentConsentOps` holds each spent
proof for a full 5 minutes rather than for the proof's remaining life. Growth is
bounded the same way it was before — one entry per consent-op burn that could not
confirm its delete, retired by the drain's expiry arm or by a later presentation
— and each entry costs an attacker a full argon2 verify or an ORCID round-trip to
create.

The process-local part is not closable without a durable store, and a restart
also drops `memStore`, which is already the point past which Redis is the sole
arbiter. Flagged here rather than fixed because a Postgres-backed burn ledger is
a schema change and a new hard dependency on the consent-op consume path, which
is an architect call, not a backend one.

**AC3 test:** `backend/tests/lib/fresh-auth-consent-op-burn-offline-queue.test.ts`
drives the real rejection. It stands a local TCP proxy between a
production-configured ioredis client and the real Redis, then severs it.
`isRedisAvailable()` is not stubbed to a toggle: it is production's own
`status === 'ready'` predicate applied to a client whose status is driven by a
real socket, and the queue rejection is ioredis's own
`MaxRetriesPerRequestError` (confirmed in the run log). The test pins that the
canonical key is still present after the burn, which is the evidence that the
queued delete really was flushed unsent, and that the replay is refused anyway.

Two claims in this paragraph were wrong as originally written and are corrected
in round 2. The client's `maxRetriesPerRequest` and `commandTimeout` were
hand-copied literals, not imported as claimed; they are now genuinely imported
from `redis.ts`. And the key-presence evidence was taken AFTER proxy recovery,
which the round-2 reconnect drain would sweep; it is now taken through a separate
direct-to-Redis observation client while the proxied client is still severed,
which is both earlier and drain-independent.

Mutation-confirmed against the committed baseline: removing the ledger gate in
the burn, and separately removing the ledger write, each make the replay return
`valid: true` and fail the test. Verified against installed ioredis 5.10.1:
`redis/event_handler.js` flushes the offline queue with
`MaxRetriesPerRequestError` whenever `retryAttempts % (maxRetriesPerRequest + 1)
=== 0`, so on the 200ms-linear curve the budget is spent about two seconds into
an outage.

Green: `npm run typecheck`, `npm run lint` (one pre-existing unrelated warning in
`author-supersession.ts`), and the 12 fresh-auth-dependent suites (231 tests).

## [TODO Architect] scope item 4: correct the convention entry

`agents/docs/solutions/conventions/atomic-getdel-split-into-read-then-delete-reopens-replay-2026-08-25.md`
still prescribes the guard whose stated rationale does not hold, and the
committed code no longer matches it. Per the standing rule that
`agents/docs/solutions/` entries are architect-owned and are never hand-edited
by implementers, this is surfaced rather than applied. Run
`/ce-compound-refresh` on it. What is wrong, precisely:

1. **The Guidance code block** ends with the comment "Guarded on the client's
   EXISTENCE only: ioredis queues it offline and flushes it on reconnect, which
   is the entire point." The flush is not guaranteed. ioredis rejects the whole
   offline queue with `MaxRetriesPerRequestError` on every reconnect attempt
   divisible by `maxRetriesPerRequest + 1`; on this client's curve that is about
   two seconds, which an ordinary Redis restart outlasts.
2. **The Defect 2 paragraph** carries the same claim as settled fact ("The old
   compensating delete was guarded on client existence precisely because ioredis
   queues commands while offline and flushes them on reconnect").
3. **What should replace it.** The entry's core lesson survives intact and
   should not be softened: an atomic `GETDEL` must not be split into a read plus
   a delete without a compensating path, and readiness-gating that compensating
   path is still wrong for exactly the reason the entry gives. The correction is
   narrower: the compensating delete is a best-effort CLEANUP bounded by the
   retry budget, not the mechanism that establishes single-use. A primitive
   whose contract is "at most once" needs a record of the spend that survives
   the compensating command never running. The `spentConsentOps` ledger shape
   above is the worked example.
4. The frontmatter `applies_when` bullet "Reaching for the house
   `if (redis && isRedisAvailable())` guard on a delete, cleanup, or
   compensating write" stays correct as-is.

---

## Architect re-review (2026-08-31) — HELD PENDING FIXES:

Reviewed via `/ce-code-review` on `e85d845c`, scoped to `backend/src/lib/fresh-auth.ts`
and `backend/tests/lib/fresh-auth-consent-op-burn-offline-queue.test.ts`. Eight persona
lenses, a seven-validator pass, and architect direct verification. Four further findings
were rejected at validation and are deliberately not listed below.

**The ledger design is sound and three of the four acceptance criteria are met.** Nothing
below says the approach is wrong or that a claimed fix is absent. Independently verified
at the commit rather than taken from the implementation note:

- **AC1 holds on every path but one.** The security lens enumerated the full branch matrix
  of (`redis` null or not, `isRedisAvailable()` true or false, `getdel` resolved or threw,
  `memStore` hit or miss) and found no combination that returns a burn win while leaving a
  canonical copy standing without a ledger entry. The single exception is item 1.
- **AC2 holds by construction.** `spentConsentOps.set` is reachable only when
  `burnedInMemStore === true`, so a ledger entry can never block a FIRST legitimate use.
  An attempt to construct a spurious `expired` on a freshly minted proof failed.
- **AC3 holds empirically, not merely structurally.** The suite was executed during review:
  it passes in 2.67s and emits a genuine ioredis `MaxRetriesPerRequestError` through
  `fresh_auth.redis_compensating_del_failed`. `isRedisAvailable()` really is production's
  `status === 'ready'` predicate applied to a socket that was actually severed, and the
  queue-rejection mechanic was re-derived from installed ioredis 5.10.1
  (`retryAttempts % (maxRetriesPerRequest + 1) === 0` triggers the queue flush).
- **Two attacks were constructed and proved NOT reachable:** a drain `.then()` wiping a
  ledger entry a newer burn just wrote (the `alreadySpent` short-circuit sits above the
  `set`, and `burnedInMemStore` cannot be true twice), and a second concurrent consume
  slipping past the awaited compensating delete (`inFlightConsumes` is added synchronously
  after a synchronous `has` with no interleaving await, and released only once the burn
  including that delete settles).
- **Clean:** project-standards returned zero findings (comment anchors, `config.appTag` key
  prefixing, carve-out clauses (a) and (b)); no token material reaches any new log path;
  no usable amplification into the ledger, since every entry costs a full argon2 verify or
  an ORCID round-trip.

Five items. The theme is that the ledger's stated invariants are not quite the ones the
code enforces.

### 1. The ledger retires before the canonical key it guards

`spentConsentOps.set(token, memRecord?.expiresAt ?? …)` takes `memRecord.expiresAt`, which
`issueFreshAuthToken` snapshots BEFORE dispatching `SET … EX`. The canonical key expires at
set-execution plus TTL, strictly later. `isConsentOpSpent` prunes on the earlier value, and
`drainSpentConsentOps` drops an expired entry with a bare `continue` that does not delete
the orphaned key. `consent_op` entries carry no independent absolute-expiry re-check on
read (unlike the session kind; `issued_at` is documented as informational only), so in the
trailing window a spent proof reads back out of Redis and authorizes a second critical
action.

Scope this honestly: the window is ordinary dispatch-to-execute latency, sub-millisecond to
low-millisecond. The security lens put it at roughly two seconds via the issuance SET
sitting in the offline queue; that is **wrong** and was corrected at validation, because
`issueFreshAuthToken` gates its SET behind `isRedisAvailable()` and never dispatches during
an outage. This is a narrow boundary race, not a wide hole.

Independent of the window's width, the inline comment claiming the chosen basis "can only
over-guard, never under-guard" is true of the `??` fallback but false of the
`memRecord?.expiresAt` operand actually taken on every real burn.

Stamp from burn time instead: `spentConsentOps.set(token, Date.now() +
FRESH_AUTH_TTL_SECONDS * 1000)`. The burn always runs after the SET executed, so burn-time
plus a full TTL provably dominates the key's expiry with no dependence on the SET
round-trip, and over-guarding an already-spent proof costs nothing. Correct the comment.
Have the drain's expiry arm fire the compensating delete before dropping the entry, so a
retiring entry never leaves an unswept key behind. Add a boundary test that advances past
the old basis with the canonical key still live and asserts the replay is still refused.

### 2. The documented restart residual is narrower than the code's

The drain docblock says "once Redis is reachable again the key goes, so a later restart
finds nothing to replay", and the implementation note's accepted residual is a restart
"between the burn and Redis returning". Neither matches the code. `drainSpentConsentOps`
has exactly one call site, the 60s `CLEANUP_INTERVAL_MS` tick, and it additionally
short-circuits on `isRedisAvailable()` sampled once per tick. The true unsafe-restart
window runs until a tick coincides with a ready client AND that tick's delete lands: up to
a full interval past "Redis returning", and longer under a server that is only
intermittently ready. A backend bounce right after a Redis incident clears is a plausible
operator reflex inside exactly that window.

Arm a one-shot drain on the client's `ready` transition — `redis.ts` already registers a
`client.on('ready', …)` handler — guarded by a module flag so listeners cannot accumulate
across reconnects, and keep the 60s tick as the backstop. Then correct both the docblock
and the residual paragraph so the accepted risk is the one the code actually carries.

### 3. The test's anti-drift claim does not hold

The header and the inline comment state the client carries production's
`maxRetriesPerRequest` / `commandTimeout` / `retryStrategy` "imported, not copied … so a
change to the reconnect curve or the retry budget re-tunes the scenario instead of silently
invalidating it". Only `redisRetryStrategy` is imported; `maxRetriesPerRequest: 3` and
`commandTimeout: 5_000` are hand-copied literals, and neither constant is exported from
`redis.ts`. Raising the retry budget in production leaves this suite green while it no
longer represents production, which is precisely the silent invalidation the comment claims
to prevent. This matters more than a normal comment slip because the carve-out
justification in clause (a) rests on that claim.

Export `REDIS_COMMAND_TIMEOUT_MS` and the retry-budget value from `redis.ts` and import both
here, so the claim becomes true and the suite re-tunes itself.

### 4. The `burnConsentOpEntry` docblock understates when the ledger branch fires

The rewritten paragraph frames the compensating-delete/ledger branch as reached "When the
Redis leg did not run at all — the client exists but is mid-flap, so `isRedisAvailable()` is
false". The code guards on `!redisLegRan`, which is also false when `isRedisAvailable()` was
true and `redis.getdel()` itself threw. Both cases reach the identical branch, and no other
sentence in that docblock ties the throw case to it. Since this is the paragraph explaining
why the ledger exists, a reader could wrongly conclude the "available but the command
failed" case is unprotected, when it already is. Broaden the sentence to name both paths.

### 5. The sibling suite's stated mutation-kill is now void

`fresh-auth-redis-unavailable-burn.test.ts`'s header says in as many words that it is the
mutation-kill for the compensating delete. After this change that is false: deleting the
`await redis.del(…)` block leaves every suite in the repo green, because the ledger
short-circuit and the replay's own `GETDEL` now satisfy each replay-refusal assertion. The
delete still earns its place — it is what retires the ledger entry promptly and bounds the
orphan window in item 2 — so leaving it unpinned invites a later refactor to trim it as dead
weight and silently widen that window to the full TTL.

Add a case to the sibling suite that asserts the canonical key's absence directly
(`exists` is 0) BEFORE any replay is attempted, which distinguishes the delete from the
ledger, and update that header so it claims the role it actually plays now.

### Noted, not held

- **Coverage gap flagged independently by three lenses:** `drainSpentConsentOps` has no test
  of any kind. Its only entry point is the 60s timer, so neither the retry-on-recovery path
  nor the expiry-prune arm is exercised, and removing the `drainSpentConsentOps(now)` call
  from the cleanup tick is invisible to the suite. Item 2 changes this function, so the
  fix for item 2 is the natural place to cover it.
- The new suite does not call `_stopCleanupForTests()`. The observed run is 2.7s so the tick
  lands far away in practice, but a worker slower than roughly 57s between this file's
  import and its assertions would make the suite non-deterministic in both directions.
- **Pre-existing, not part of this task:** the compensating delete is awaited inside the
  request path, so a consent-op consume during an outage blocks for the retry budget before
  the route proceeds. The ledger now makes that await unnecessary for the single-use
  guarantee, which makes it cheaper to revisit later.
- **Pre-existing, separate surface:** `backend/src/lib/ipfs-upload-token.ts` implements the
  same compensating-delete pattern and its comments still assert the offline-queue
  reasoning this task disproved. Impact there is contained today by the `file_sha256`
  re-verification at the pin route and the independent pin cap, so this is a
  correctness-of-claim divergence rather than a live hole. Flagged for a future task, not
  for this one.

### Architect-owned, still outstanding

Scope item 4 (the convention entry) remains with the architect and does not block the
implementer. Handled separately from this hold.

---

## Backend re-review signal (2026-08-31, commits 557e5cad + 026b92bd)

Round-2 fixes for the five held items are landed. `557e5cad` is the fix for the
hold block; `026b92bd` is the fix for what my own verification pass found wrong
in `557e5cad`. Symbols and test titles are named below so the diff can be
grepped rather than the prose trusted.

**Item 1 — ledger retires before the canonical key.**
`burnConsentOpEntry` now stamps `spentConsentOps.set(token, Date.now() +
FRESH_AUTH_TTL_SECONDS * 1000)`; the `memRecord` local is gone and the comment
above the hoisted read now cites the reason that survives (`drainSpentConsentOps`
can mutate the map across an await; `inFlightConsumes` does not serialize against
it). The "can only over-guard, never under-guard" phrasing is gone; the
replacement states the bound and names two residuals rather than claiming a
proof — ioredis may re-execute an issuing `SET` whose promise `commandTimeout`
already rejected (`autoResendUnfulfilledCommands` defaults true), and the ledger
deadline runs on the app clock while the key's `EX` runs on the Redis server's.
`drainSpentConsentOps`'s expiry arm issues the compensating delete before an
unconditional drop. Boundary test: `refuses the replay even though the
compensating delete never landed, and holds the proof spent past its own expiry`.

**Item 2 — drain only ran on the 60s tick.** `armDrainOnReady` /
`onRedisReadyDrain` / `drainArmedClients` added, armed from the ledger-write
branch. Test: `retires the ledger entry and sweeps the orphan on the next ready
transition, with no replay attempted`.

**Item 3 — the test's anti-drift claim.** `REDIS_COMMAND_TIMEOUT_MS` and
`REDIS_MAX_RETRIES_PER_REQUEST` are exported from `redis.ts` and imported by the
suite. The claim is also narrowed rather than merely made true: `sendCommand`
starts the command timeout before queueing, so a large enough retry budget flips
the scenario from an offline-queue rejection to a plain timeout with every
assertion still green, and the header now says the imports keep the numbers
tracking production but the assertions are on outcomes.

**Item 4 — docblock breadth.** Broadened in `burnConsentOpEntry`, and at the two
further sites carrying the same too-narrow framing: the `spentConsentOps`
docblock's "is not guaranteed to land" paragraph and the `alreadySpent` inline
comment.

**Item 5 — the sibling suite's stated mutation-kill.** Both sibling suites gained
a canonical-key-absence assertion taken before any replay:
`fresh-auth-redis-unavailable-burn.test.ts` (`removes the canonical key inside
the window where the burn saw Redis as unavailable`) and, because the sibling's
carve-out clause (c) points at it, `fresh-auth.test.ts`'s `a burn whose Redis leg
fails still clears the canonical entry` case, whose own "this test is its
mutation-kill" comment was void for the same reason.

### Deliberate deviations from the hold's literal wording

1. **Persistent `client.on('ready')`, not a one-shot.** ioredis's `closeHandler`
   schedules `connect()` on the SAME instance, so client identity survives every
   flap and `ready` is emitted again on each recovery; a `once` listener would
   cover the first flap of the process's life and silently stop covering later
   ones. Idempotent arming is per-instance via a `WeakSet`, which is what the
   hold's "module flag so listeners cannot accumulate" is for.
2. **No test-only gate on the ready-drain.** An earlier shape gated it on the
   cleanup interval so the ledger test could stay deterministic. That is mutually
   exclusive with testing the drain end-to-end, and it couples a security-relevant
   sweep to the memStore sweeper's lifecycle. Instead the offline-queue suite
   never produces a `ready` transition on the client `getRedis()` returns: it
   recovers by swapping `state.client` to a second, already-ready direct-to-Redis
   client. Restarting the proxy would fire the drain and move the replay's refusal
   from the ledger to the read path, voiding the mutation-kill.

### Changed beyond the hold, and why

`isConsentOpSpent` no longer prunes on read; it is now `spentConsentOps.has`.
Item 1 named both deadline-retirement sites but prescribed a sweep only for the
drain. The read-path prune is the site a REPLAY traverses, and it is the one that
cannot issue a sweep — it runs two statements ahead of the same call's `GETDEL`,
so a fire-and-forget delete there would race the burn it is deciding, while
dropping the entry bare leaves that `GETDEL` free to find a key the deadline said
had lapsed and report it as a win. Retirement therefore belongs entirely to the
drain, which sweeps. Answering "spent" past the deadline only ever refuses a
proof whose own TTL expired a full interval earlier. If you would rather have the
prune back, the fix is a smaller diff than the one that removed it.

### Self-verification, and what it caught

`557e5cad` was reviewed by four adversarial lenses plus per-finding adjudication
before this signal was written, and `026b92bd` is the result. Two statements
`557e5cad` had just written were false, which is the same class the hold block
exists to close:

- The drain docblock filed a mid-command drop under the tick-only arm. Probed
  against the installed ioredis with the production options: a drop sets
  `close`/`reconnecting` before any rejection it can produce, so the ready arm
  does cover it. Only a `commandTimeout` against a connected-but-stalled server
  is tick-only. Corrected in the docblock and in the Residual paragraph above.
- `onRedisReadyDrain`'s `try`/`catch` was justified as protecting another
  subscriber's `ready` work. Unreachable — `redis.ts` registers its handler at
  construction, so this one is always last. The real consequence is worse and is
  now the stated one: status events are emitted from a `process.nextTick`, so an
  escaping throw is an uncaught exception and `index.ts` exits on those.

Three drain arms had no test at all and now do, each mutation-confirmed: the
expiry arm's sweep (`sweeps the canonical key when it drops an entry past its
deadline`), the periodic tick's call into the drain (`retires an expired entry
from the periodic cleanup tick`), and the `!client` arm, where a LIVE entry must
survive a drain pass that finds Redis unreachable — the arm the tick takes for
the whole of an outage, and the one where dropping an entry would retire the
refusal while the orphan is still readable. That last one is an added assertion
inside `drops a ledger entry past its deadline even with no reachable client`.
`_setSpentConsentOpForTests` was added to make the first two reachable: the
production writer stamps a full TTL out, so no burn-driven test can reach them.

### Evidence

Eleven mutation probes against the committed baseline, each killing exactly the
intended test: the ledger stamp reverted to the proof's own expiry; the
`armDrainOnReady` call removed; the expiry arm's drop chained onto its delete;
the expiry arm's sweep removed; a live entry dropped in the `!client` arm; the
tick's `drainSpentConsentOps(now)` call removed; the compensating delete removed
(kills BOTH sibling suites); the compensating delete re-gated on
`isRedisAvailable()` (kills ONLY the sibling suite, which is what makes its
rewritten uniqueness claim true); and the `alreadySpent` gate removed.

Green: `npm run typecheck` (src + tests), `npm run lint` (the one pre-existing
`author-supersession.ts` warning), and 518 tests across the 30 files that import
`lib/fresh-auth` or `redisStubFactory`.

### Known gaps, stated rather than hidden

- `redisStubFactory` in `tests/support/argon2-error-mocks.ts` had to gain both new
  constants: its `typeof import('../../src/redis.js')` annotation makes any new
  export of `redis.ts` a `typecheck:tests` break across its consumers. Behaviour
  unchanged; those stubs return a null client and never build one.
- The offline-queue suite's key-presence assertions remain exposed to a sibling
  worker's per-file `${appTag}:*` flush, which is pre-existing and inherent at
  `maxWorkers: 2`. Mitigated where it matters: the drain assertions are on the
  ledger's size, which no other file can touch, and the orphan is observed
  through a direct client during the outage rather than after recovery.

### Architect-owned

Scope item 4 is **done**, by the architect, in `5527fa08` — which landed just
before this round's first commit, so the `[TODO Architect]` block above is
answered and AC4 is met. Checked rather than assumed: the entry's Guidance block
now says the compensating delete is "Best-effort CLEANUP, NOT the guarantee",
records the spend first, and calls for "an expiry that dominates the canonical
key's". That last phrase is exactly what item 1's burn-time stamp implements, so
the entry and the code agree with no further edit needed on either side.

`backend/src/lib/ipfs-upload-token.ts` is untouched, per the hold's "Noted, not
held". Worth re-flagging now that the entry is corrected: that file still carries
the offline-queue reasoning this task disproved, so it is the one place left in
the tree where the retired rationale is stated as fact.

---

## Architect re-review (2026-08-31, round 3) — HELD PENDING FIXES:

Reviewed via `/ce-code-review` on the round-2 diff (`557e5cad` + `026b92bd`),
eight lenses plus an independent per-finding validation pass. **All five round-2
hold items verified genuinely landed**, checked in the diff rather than taken
from the signal: the burn-time stamp and its boundary test, the ready-transition
drain machinery and its client-swap test, the genuinely-imported redis.ts
constants, the broadened docblocks at all three sites, and the
key-absence-before-replay assertions in both sibling suites. Both deliberate
deviations verified sound against installed ioredis 5.10.1, and the beyond-hold
`isConsentOpSpent` bare-`.has` change is confirmed a strict refusal-widening
(AC2 intact). Four of eight lenses returned zero findings (correctness,
security, reliability, project-standards). The learnings pass confirmed the
corrected convention entry and the committed code agree, so AC4 stays met.

Two validated findings hold the archive. Both are small and both land on the
invariants this task exists to pin.

### 1. The drain's expiry arm drops a ledger entry it cannot sweep

`drainSpentConsentOps`'s expiry arm deletes an entry past its deadline
unconditionally; when `client === null` (the whole of an outage) no sweep can be
dispatched, so the drop is bare. Validated link-by-link against installed
ioredis 5.10.1, that bare drop composes into a real AC1 break: an issuing `SET`
whose socket closed unreplied is retained in `prevCommandQueue`
(`closeHandler`), any successful mid-outage TCP connect calls
`resetCommandQueue()` which decouples that deque from every later retry-ceiling
flush, and `readyHandler` resends it at recovery with a FRESH full `EX` —
`autoResendUnfulfilledCommands` defaults true and nothing checks whether the
command's promise already rejected. If the proof was burned during that outage
and the outage outlasts the ledger deadline, the tick drops the entry bare, the
recovery ready-drain no-ops on the empty map (`size === 0` early return), the
resurrected key reappears, and a replay of the already-burned proof returns
`valid: true` for up to a further TTL. `consent_op` entries carry no
absolute-expiry re-check on read, so nothing downstream refuses it. The
preconditions are rare and not attacker-controlled (an outage longer than the
ledger deadline that begins with an accept-then-fail connect, e.g. a crash loop
while loading an RDB), but this is the trailing-window replay the ledger exists
to close, reached through the one state its own comment claims is covered: the
expiry-arm comment's "degrades to a redundant DEL rather than to a readable
orphan" is false exactly when `client` is null.

Fix: in the expiry arm, retire an entry only when the sweep can be dispatched —
`if (!client) continue;` before the drop, keeping the dispatch-then-drop shape
for the reachable-client case. Growth stays bounded: the kept expired entries
are the same set the live-entry arm already keeps during an outage, each costing
an argon2 verify or an ORCID round-trip to create, and all retire on the first
drain that holds a client. This is deliberately NOT the rejected
chain-drop-onto-delete shape — it defers the drop only while no delete can be
issued at all. Correct the expiry-arm comment and the drain docblock's residual
paragraph so the stated residual matches the new behavior. The test `drops a
ledger entry past its deadline even with no reachable client` currently pins the
unsafe bare drop and must be reshaped to pin the new invariant: an expired entry
with no reachable client is KEPT; the expired-drop-with-sweep case (client
reachable) stays as is.

### 2. The bare-`.has` read semantics have no consume-path test

The beyond-hold rewrite of `isConsentOpSpent` to membership-only is
security-relevant and deliberate, but no test drives its
past-deadline-still-refuses behavior through `consumeFreshAuthToken`: both
`_setSpentConsentOpForTests` call sites are followed only by drain calls, and
none of the eleven round-2 mutation probes targets the predicate. Reverting it
to prune-on-read (even keeping the corrected deadline basis) would reopen the
residual race item 1 of the round-2 hold closed, with every suite green.

Fix: add a case (natural home: the ledger-retirement block in
`fresh-auth-redis-unavailable-burn.test.ts`, where the client is genuinely
connected) that makes the scenario discriminating: plant a past-deadline ledger
entry via `_setSpentConsentOpForTests` for a token whose canonical key is
present in Redis and whose `memStore` record is absent, then call
`consumeFreshAuthToken` directly with NO drain call first, and assert the
consume is refused (`expired`). Under membership-only the presentation is
refused and its own `GETDEL` retires both key and entry; under prune-on-read the
entry is dropped at read time and the `GETDEL` wins, so the mutation returns
`valid: true` and the test fails — which is the kill this predicate is missing.
Optionally assert the ledger size afterwards, which also closes the noted
refused-replay-retirement gap below.

### Noted, not held

- The refused replay's own ledger retirement (`if (redisLegRan)
  spentConsentOps.delete(token)`) is exercised but unpinned; a one-assertion add
  inside item 2's new test covers it.
- `armDrainOnReady`'s WeakSet dedup has no listener-count pin; a regression
  dropping the guard would double-drain per transition, harmlessly (drains are
  idempotent).
- The stalled-server ledger-entry origin (`commandTimeout` with the client stuck
  `ready`) is never produced end-to-end; the branch reached is byte-identical to
  the flap arm.
- The offline-queue suite's `afterEach` discards its recovery `waitFor` boolean,
  so a failed proxy restart surfaces as confusing next-test failures rather than
  a clear fixture failure.
- Rejected at validation, for the record: a maintainability finding to extract
  the ledger subsystem from `fresh-auth.ts` — already tracked as in-scope by the
  blocked module-split task, and no codified rule anchors it.

---

## Backend re-review signal (2026-08-31, round 3, commit 60c9c6bb)

Both held items landed in one commit.

**Item 1 — expiry arm drops what it cannot sweep.** The arm now reads
`if (!client) continue;` before the dispatch-then-drop pair, so an expired
entry is retired only when its sweep can be issued; while no client is
reachable it is kept and goes on refusing its proof. The expiry-arm comment
was rewritten around the resurrection mechanism the hold traced
(`autoResendUnfulfilledCommands` re-executing an unreplied issuing `SET` with
a fresh full `EX`), states the growth bound (the same per-burn set the live
arm already retains, retiring on the first client-holding drain), and the
drain docblock's opening paragraph now states the retirement condition. The
test formerly named `drops a ledger entry past its deadline even with no
reachable client` is reshaped to `keeps a ledger entry past its deadline
while no client is reachable` and pins keep-not-drop plus the refusal the
retention preserves (a replay after the past-deadline drain pass is still
refused); the reachable-client expiry sweep case in
`fresh-auth-redis-unavailable-burn.test.ts` is unchanged, as prescribed.

**Item 2 — bare-`.has` consume-path kill.** New case `a past-deadline ledger
entry still refuses the consume itself` in the ledger-retirement block of
`fresh-auth-redis-unavailable-burn.test.ts`: canonical key present in Redis,
in-memory record absent, ledger entry planted past deadline via
`_setSpentConsentOpForTests`, then `consumeFreshAuthToken` directly with no
drain call first; refused with reason `expired`. The optional retirement
assertion from the hold is included: after the refusal the ledger size is 0
and the key is gone, which also pins the refused replay's own
`if (redisLegRan)` retirement (the first noted-not-held gap).

Mutation-confirmed against the committed baseline, each probe killing exactly
its intended test: restoring the bare drop fails the reshaped keep test;
restoring prune-on-read semantics in `isConsentOpSpent` (even with the
corrected deadline basis) fails the new consume-path case.

Green: `npm run typecheck` (src + tests), `npm run lint` (the one
pre-existing `author-supersession.ts` warning), and the three fresh-auth
suites (`fresh-auth.test.ts`, `fresh-auth-redis-unavailable-burn.test.ts`,
`fresh-auth-consent-op-burn-offline-queue.test.ts`, 116 tests).

The other noted-not-held items are untouched by choice: the listener-count
pin, the stalled-server end-to-end origin, and the `afterEach` recovery
boolean are all below the hold line and none is load-bearing for the two
invariants this round pins.

---

## Architect re-review (2026-09-01, round 4) — HELD PENDING FIXES:

Reviewed via `/ce-code-review` on the round-3 diff (`60c9c6bb`), seven lenses
plus an independent per-finding validation pass. **Both round-3 hold items
verified genuinely landed**, checked in the code rather than taken from the
signal: the `if (!client) continue;` keep guard and its reshaped test
discriminate the bare-drop revert, and the new consume-path case genuinely
kills a prune-on-read regression (traced against the historical
implementation). AC2 intact; project-standards clean (anchor-gate arms, key
prefixing, carve-outs); the learnings pass confirmed the corrected GETDEL
convention entry and the code still agree, so AC4 stays met.

Three items. Item 1 reverses a prescription round 3 itself made, on evidence
three reviewers produced independently — this is the architect's round-3
prescription being one layer short, not implementer drift.

### 1. The expiry arm retires a ledger entry on DEL dispatch, not confirmation

With a client held, the expiry arm runs `void client.del(...).catch(() => {})`
and then `spentConsentOps.delete(token)` synchronously — the drop is gated on
the sweep being ISSUED, while the live arm two lines below drops only inside
`.then()`. Three reviewers traced the same composition and the validator
confirmed it link by link: a dispatched DEL that fails while the client looked
reachable (a `commandTimeout` against a stalled-but-ready server, or a socket
death right after recovery that flushes the retained DEL out of the resend
lineage) combined with an unreplied issuing `SET` resent at recovery with a
fresh full `EX` leaves the canonical key readable for up to a fresh TTL with
nothing left to refuse it — `memStore` was emptied at burn, and the ledger
entry is already gone. A spent consent-op proof then replays and wins.

Round 3 prescribed "keeping the dispatch-then-drop shape for the
reachable-client case"; that shape is hereby withdrawn. The round-2 objection
to chaining (entries leak for the whole of an outage) no longer applies —
round 3's `if (!client) continue;` guard owns the no-client case entirely, so
chaining changes only the client-held case, where a failed delete now leaves
the entry for the next trigger, which is the invariant the drain docblock
already claims.

Fix: mirror the live arm's confirmed-delete pattern (drop inside `.then()`,
`.catch` retains), at which point the two arms are nearly identical —
collapsing them into one loop body is welcome. Correct the comment that says
the sweep is "issued before the drop" (it must LAND before the drop). Record
the one sub-decision in place: a DEL that rejects forever while the client
stays ready (e.g. an ACL failure) now retains its entry for the process
lifetime — state whether that is accepted (retention only ever refuses harder,
and no such failure mode exists in this deployment) or retired on
server-replied error classes. Add the discriminating test this arm has never
had: a drain pass holding a client whose `del` REJECTS must retain the entry,
and the proof must still be refused afterward. Neither existing suite covers
the dispatched-DEL-fails-after-drop window.

### 2. The reshaped keep-test's replay assertion does not test retention

The final assertion's comment claims it pins "the refusal that retention
exists to preserve", but at that point `state.client` is still the severed
proxied client and the in-memory backup was already deleted by the first
consume, so `readFreshAuthEntry` returns null and the refusal fires from tier
absence BEFORE the ledger is consulted. It passes identically under a
bare-drop revert; the size assertion above it is the only real kill. Two
reviewers filed it independently; the validator traced the full branch path.

Fix: point `state.client` at the already-connected `observer` before the final
replay (the sibling test's own `state.client = observer;` pattern, which also
avoids re-firing the ready-armed drain), assert the canonical key still exists
just before the replay, then assert the refusal — making it attributable to
the retained entry against a live, readable key. Update the comment to match.
With item 1 landed this becomes the second, causal kill for the retention
invariant rather than a redundant smoke check.

### 3. The isConsentOpSpent docblock still asserts the pre-round-3 model

Its closing paragraph — "Answering yes past the deadline costs nothing… the
only presentation this refuses is one that was going to be refused anyway. The
drain is what bounds the map, on a tick that always runs" — contradicts the
expiry-arm comment this same commit wrote (the deadline does not prove the key
unreadable; a kept past-deadline entry can be the ONLY refusal; retirement
waits for a client). Rewrite the paragraph to the load-bearing model, and while
in there fix the drain docblock's restart-residual phrase ("the rest of its
TTL"), which understates the post-resurrection case: a resent issuing `SET`
gives the orphan a FRESH full `EX` from recovery. Make both rewrites reflect
item 1's confirmed-delete change so the file is corrected once.

### Noted, not held

- No drain test ever plants MORE than one ledger entry, so a loop-truncating
  drain mutant is invisible (the corpus's sampling-blindness class; Map
  iteration makes it unlikely to matter). A two-entry case in item 1's new
  test would close it for free.
- The recovery-composition end-to-end (resent SET + kept entry as sole
  refuser) remains feasible with the existing proxy harness; item 2's reshape
  covers the state, not the full sequence. Below the hold line.

---
