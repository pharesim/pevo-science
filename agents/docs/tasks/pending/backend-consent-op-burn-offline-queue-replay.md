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

## Backend re-review signal (2026-09-01, round 4, commits 5a681e1e + 155e0c1d)

`5a681e1e` is the fix for the three held items. `155e0c1d` is the fix for what
my own five-lens verification pass found wrong in `5a681e1e` — seven claims the
code did not support, none of them behavioral.

**Item 1 — retirement on dispatch rather than confirmation.** The expiry arm's
drop now lives inside `.then()`, so an entry may leave only once its `DEL`
resolves; `.catch` retains. With that change the two arms became identical and
are collapsed into one loop body, which the hold invited. The per-entry
`if (!client) continue;` became a single early return
(`if (redis === null || !isRedisAvailable()) return;`) — same semantics, one
decision instead of N. The comment claiming the sweep is "issued before the
drop" is replaced by "The drop lives HERE and not after the dispatch: the
delete has to land before the entry may leave."

The sub-decision the hold asked to be recorded is stated in the drain docblock,
with a position taken: accepted, not retired on server-replied error classes,
because retirement on an error would guess that the error implies the key is
unreadable, which it does not. Its premise was wrong when first written and is
corrected in `155e0c1d` — see the self-verification section.

New discriminating test: `retains the entry when the drain delete rejects with
the client still ready, and still refuses the replay`. It required a second
proxy failure mode. Severing cannot produce a rejection at `status === 'ready'`
(ioredis sets `close` before any rejection it can cause), so `SeverableProxy`
gained a `stall()`: sockets held open, both directions unpiped and paused, so a
dispatched `DEL` rejects on its own `commandTimeout` with the client never
leaving `ready`. That is the one shape the round-3 hold's dispatch-then-drop
prescription could not survive.

**Item 2 — the keep-test's replay assertion did not test retention.** The final
replay now runs with `state.client` pointed at the already-connected observer,
with `expect(await observer!.exists(key)).toBe(1)` immediately before it, so the
refusal is attributable to the retained entry against a live readable key rather
than to tier absence. The comment was rewritten to claim only that.

**Item 3 — the `isConsentOpSpent` docblock asserted the pre-round-3 model.** Its
closing paragraph is rewritten around what is now load-bearing: age proves
nothing, a stale entry can be the only refusal standing, and the ledger is
bounded by confirmed sweeps rather than by time. The drain docblock's
restart-residual phrase now covers the resurrection case: the orphan is readable
"for the rest of its TTL, or for a FRESH full `EX` measured from recovery when
the key was resurrected by a resent issuing `SET`."

### Changed beyond the hold, and why

`spentConsentOps` is now a `Set<string>`. This was not a taste change: once
retirement is gated on confirmation, nothing reads the deadline. The expiry arm
was the last consumer (`isConsentOpSpent` stopped pruning in round 2), so
keeping a deadline would have meant storing a number that no code branches on
and that the file's own comments now argue cannot bound the key's life anyway —
a resent issuing `SET` restarts the key's `EX` from recovery, so no burn-time
stamp dominates it. `_getSpentConsentOpExpiryForTests` is deleted;
`_setSpentConsentOpForTests` and `_drainSpentConsentOpsForTests` lost their time
parameters. AC2 is unaffected: the ledger write is still reachable only when
`burnedInMemStore === true`, so no first use can be blocked.

If you would rather keep a deadline as defence-in-depth, note that it can only
ever retire an entry EARLIER than a confirmation would, which is the direction
that reopens the replay. That asymmetry is why it went.

### Self-verification, and what it caught

`5a681e1e` was checked by five independent lenses (hold-compliance,
comment-truth, ioredis-behavior against the installed 5.10.1 source,
test-discrimination, stale-model sweep) before this signal was written.
`155e0c1d` is the result. What they caught, all prose-vs-code:

- **The accepted-retention premise was false.** It read "this deployment has no
  per-command ACLs — past authentication, a dispatched command fails only by
  timeout or connection loss, and both end." Two lenses independently produced
  the counterexample: a default `stop-writes-on-bgsave-error yes` makes Redis
  reply `-MISCONF` to every write command, `DEL` included, indefinitely and on a
  healthy `ready` connection. I had checked the deployment for ACLs (there are
  none, `--requirepass` only) and stopped there. The decision is unchanged and
  still correct; the premise now names MISCONF and the never-returning-Redis
  shape, and states that each tick re-dispatches one rejecting `DEL` per entry
  for the incident's duration.
- **The new test's own justification comment claimed a false impossibility** —
  that a burn "cannot produce" the planted state because the ledger write needs
  the Redis leg to fail while the scenario needs the client `ready`. Those are
  not exclusive; that combination is the stalled-server origin the same commit
  added a stall mode for. Three lenses caught it independently. Restated as the
  cost/determinism choice it actually is (a burn-produced origin serializes
  three command timeouts). This also retires a standing noted-not-held item: the
  stalled-server origin is now producible end to end, one issue-then-stall away.
- **A renamed test claimed a kill it did not have.** `retires entries only once
  their sweeps land` passed identically under a drop-on-dispatch mutant. Now
  named `sweeps every entry it holds, retiring each only once its own delete
  lands`, and made to earn it: a synchronous `expect(size).toBe(2)` sits between
  the drain's dispatch and its confirmations. One lens objected that a real
  round-trip could beat such an assertion; that is wrong — there is no await
  between the two statements, so no I/O callback can interleave. Confirmed by
  probe: the mutant now dies here in 9ms.
- Smaller corrections: the retry-ceiling flush lands a little over a second into
  an outage (delays 200/400/600 before the fourth close, `retryAttempts % 4 === 0`),
  not "about two seconds" — I re-derived this from `event_handler.js` rather than
  taking the lens's word; the resurrection claim needs an intervening TCP connect
  to survive the ceiling flush; the tick is the sole SWEEPER, not the sole
  retirement trigger (a refused replay's `GETDEL` also retires); "the map" for a
  `Set`; "proofs that already authorized an action" for proofs that were merely
  spent (burn-before-check means a username/target-mismatched proof is spent
  too); and the cleanup docblock no longer claims to bound the ledger under
  no-Redis ops, which is exactly what it stopped doing.

Two coverage gaps the lenses found were closed rather than noted. The keep-test
gained a trailing `expect(size).toBe(0)`, so a sibling worker's per-file
keyspace flush landing in its one-macrotask window becomes a loud failure
instead of a silent weakening — it also pins the refused replay's own
retirement, which the round-3 hold listed as unpinned. And
`fresh-auth-redis-unavailable-burn.test.ts` now pauses the cleanup tick
file-wide (`beforeAll`/`afterAll`), so a 60s tick landing inside the two-entry
test's poll window cannot finish a sweep a loop-truncating mutant skipped.

The hold's two-entry suggestion is implemented, but in the sibling suite's sweep
test rather than in item 1's new test, which plants one entry and is about the
rejection rather than the loop.

### Evidence

Nine mutation probes against a committed baseline, each killing exactly its
intended tests: retirement moved to dispatch (kills the stalled test, and after
`155e0c1d` the sibling sweep test too); the drop moved into `.catch`; the
no-client early return replaced by a clear; the drain loop truncated after one
entry; the tick's `drainSpentConsentOps()` call removed; the `alreadySpent` gate
neutralized (kills four); the ledger write removed (kills three); and the
refused replay's `if (redisLegRan)` retirement removed (kills three, one of them
newly).

One process note worth recording: mid-probe I ran `git checkout --` on
`fresh-auth.ts` while it still held uncommitted documentation fixes and lost all
four of them. They were redone and committed BEFORE the remaining probes. This
is the already-documented "commit before mutation probes" rule; I violated it
and it cost a rewrite.

Green: `npm run typecheck` (src + tests), `npm run lint` (the one pre-existing
`author-supersession.ts` warning), and 412 tests across the 16 fresh-auth and
eslint-canary files, plus 163 tests across the 13 remaining fresh-auth-consuming
route suites — 29 files in total, the full set that imports `lib/fresh-auth`.

### Not done, by choice

The remaining noted-not-held items are untouched: the `armDrainOnReady`
listener-count pin, the recovery-composition end-to-end sequence, and the
offline-queue suite's discarded `afterEach` recovery boolean. None is
load-bearing for the invariants this round pins.

## [TODO Architect] the two learnings entries the Set conversion invalidated

Both are architect-owned; surfaced rather than edited, per the standing rule.
Two lenses flagged the first independently as an AC4 regression.

1. `agents/docs/solutions/conventions/atomic-getdel-split-into-read-then-delete-reopens-replay-2026-08-25.md`
   now prescribes the model this round retired, so AC4 has reopened since the
   round-4 preamble recorded it met. Three sites:
   - The Guidance code block writes the ledger as a deadline map:
     `spentConsentOps.set(token, /* an expiry that dominates the canonical key's */);`
     Production is `spentConsentOps.add(token)` against a `Set<string>`.
   - The paragraph beginning "Give the record an expiry that **dominates** the
     canonical copy's" is not merely stale, it is now asserted false by the code
     it documents: a resent issuing `SET` restarts the key's `EX` from recovery,
     so no burn-time stamp dominates the key's life. That is precisely why the
     deadline was removed. The entry's core lesson survives untouched — record
     the spend before attempting the removal, retire only on confirmation — and
     that sentence of it is now MORE exactly true than when written.
   - The same block shows `if (isConsentOpSpent(token)) return false;` as a bare
     early return, missing the refused replay's `if (redisLegRan)
     spentConsentOps.delete(token)`, which is now one of only two retirement
     events.
2. `agents/docs/solutions/conventions/hold-prescriptions-expire-with-their-premise-2026-09-01.md`
   describes a two-arm `drainSpentConsentOps` in the present tense ("still
   carries the dispatch-then-drop shape", "the confirmed-delete fix ... is
   prescribed but not yet landed", "already present two statements below"). The
   arms are now one loop body. Its worked example is legitimately historical; it
   is the "as of this writing" framing that rots. Its Related bullet also records
   "(verified: that entry does not describe the expiry arm, so the pending
   confirmed-delete change does not contradict it)" — that verification is what
   missed item 1 above, since the Set conversion's blast radius was wider than
   the confirmed-delete change it was scoped to.

Also still open from the earlier rounds, unchanged by this one:
`backend/src/lib/ipfs-upload-token.ts` remains the one place in the tree
asserting the offline-queue rationale this task disproved.

---

## Architect re-review (2026-09-01, round 5) — HELD PENDING FIXES:

Reviewed via `/ce-code-review` on the round-4 diff (`5a681e1e` + `155e0c1d`), eight
lenses plus an independent per-finding validation pass.

**All three round-4 hold items verified genuinely landed**, checked in the code rather
than taken from the signal:

- **Item 1.** The expiry arm's drop lives inside `.then()`; `.catch` retains. The two
  arms are collapsed into one loop body behind a single early return. The new stalled
  test drives a genuinely DISPATCHED delete that rejects on its own `commandTimeout`
  with the client never leaving `ready` — the one rejection shape severing cannot
  produce, confirmed against the installed ioredis: `closeHandler` sets `close`
  synchronously before any rejection a severed socket can cause.
- **Item 2.** The keep-test's final replay now runs with `state.client` pointed at the
  connected observer and `exists(key) === 1` asserted immediately before it, so the
  refusal is attributable to the retained entry rather than to tier absence. Verified it
  now fails under a bare-drop revert; the previous shape passed identically.
- **Item 3.** `isConsentOpSpent`'s closing paragraph and the drain's restart-residual
  are rewritten to the load-bearing model.

**The security work is done and nothing this round reopens it.** Four lenses independently
enumerated the burn matrix over (`redis` null or not, `isRedisAvailable()`, `getdel`
resolved or threw, `memStore` hit or miss, `alreadySpent`) and none found a combination
returning a win with a canonical copy readable and unguarded. AC2 holds structurally:
`spentConsentOps.add` has exactly two call sites, and the production one sits inside
`!redisLegRan && burnedInMemStore && redis`. The `Set` conversion is a strict
refusal-widening. The beyond-hold removal of the deadline was checked in both directions
and cannot retire an entry earlier than a confirmation would.

**Notably, and for the first time in this task, every ioredis claim the diff makes is
correct.** Five reviewers verified independently against installed 5.10.1 rather than
against the comments: the `retryAttempts % (maxRetriesPerRequest + 1)` flush condition,
`autoResendUnfulfilledCommands` defaulting true and resending the original `SET ... EX`
at recovery, `resetCommandQueue` on a successful connect, `commandTimeout` armed before
the offline-queue check, and `setStatus` emitting via `process.nextTick`. The rewritten
docblocks are accurate. What follows is text the rewrite did not reach.

Three items. All are the same class: statements of the retired model left standing
where the `Set` conversion did not reach. None affects behaviour.

### 1. The compensating-delete failure log still promises release on expiry

`burnConsentOpEntry`'s `logger.warn` on the failed compensating delete tells the operator
the proof is "held spent in-process until the delete lands **or it expires**". Nothing
expires any more. The ledger is a `Set<string>` whose own docblock states entries leave
on exactly two events, neither of which is expiry.

This is the only operator-facing artifact in the feature, and it fires during precisely
the incident the ledger exists to survive — where, under a Redis that stays down or
returns `-MISCONF`, the entry is retained indefinitely by design. An operator reading it
has been told the wrong recovery model at the moment they most need the right one. It is
also the last statement of the retired model inside a function whose surrounding docblock
this same commit already corrected, which makes it the single line most likely to seduce
a future author back into deadline-based retirement.

Fix: drop the `or it expires` clause and name the actual release condition (a confirmed
delete, or a later presentation proving the canonical copy gone). Operator log, so the
no-emdash rule does not bind.

### 2. The retry-ceiling figure was corrected in two places and left wrong in two others

`155e0c1d` corrected this claim in the `spentConsentOps` docblock to "divisible by
`maxRetriesPerRequest + 1` ... flushing on the fourth close ... a little over a second".
Two copies were missed, and both are wrong in both halves:

- `burnConsentOpEntry`'s docblock still says "rejected wholesale once the reconnect count
  reaches `maxRetriesPerRequest`, which on this client's backoff curve is about two
  seconds". This is the docblock that explains why the ledger exists at all.
- The offline-queue suite's header still says "once its reconnect count reaches
  `maxRetriesPerRequest`" — directly beside the "on the fourth close" clause this same
  diff added. The sentence now contradicts itself.

With `REDIS_MAX_RETRIES_PER_REQUEST = 3` the flush is at attempt 4, and on the 200ms
linear curve (200/400/600) that is a little over one second. Settle the wording once and
apply it to both sites. Four lenses flagged the first; two flagged the second.

For the record, the same stale figure was in the architect-owned GETDEL convention entry
and has been corrected there in `ac3ce047`, so all four copies now agree.

### 3. The drain docblock's "SOLE sweeper" claim is false

The docblock calls the periodic tick "the SOLE sweeper" for the stalled-server arm.
`burnConsentOpEntry`'s `if (redisLegRan) spentConsentOps.delete(token);` also retires
that entry, whenever a replay's own `GETDEL` resolves.

This same commit already wrote the correct qualifier into the tick test — "the only
trigger that sweeps it WITHOUT a further presentation of the proof; a replay's own
resolved `GETDEL` would also retire it, but nothing guarantees a replay arrives" — and
the round-4 signal listed this very correction as one it had made. It was made in the
test and missed in the production docblock, which is now the one place stating the
retirement contract too strongly. Adopt the test comment's phrasing.

### Noted, not held

- **Two findings were raised and dropped at validation, recorded so they are not
  re-litigated.** First, a claim that the stalled test cannot distinguish a rejected
  delete from a still-pending one, and so would not kill a drop-on-settle (`.finally`)
  mutant. Traced concretely: `commandTimeout` is armed at dispatch and is 5s, while the
  test sleeps `REDIS_COMMAND_TIMEOUT_MS + 1_500`, so the rejection lands 1.5s before the
  assertion and the mutant does die there. The test is sound as written. Second, a claim
  that `hold-prescriptions-expire-with-their-premise` is contradicted; it is stale in one
  status line but hedged "as of this writing", and its normative content matches what
  landed. Left alone deliberately.
- **Unbounded retention now has a second dimension nobody has bounded.** Entries are
  retained for the whole of an outage by design, and each tick re-dispatches one `DEL`
  per entry. A timed-out ioredis command is additionally never removed from
  `commandQueue`, so against a stalled server that never replies the `Command` objects
  accumulate alongside the entries. This is strictly wider than pre-diff, since entries
  no longer lapse. Being filed as its own task rather than held here — it touches the
  invariant this task just settled and deserves its own design pass.
- The `-MISCONF` premise in the drain docblock assumes RDB save points are configured; a
  Redis with no `save` directives never returns `-MISCONF` to `DEL`. Narrows the named
  shape, changes nothing about the decision. Not worth an edit on its own.
- AC1's safety under the resent-`SET` resurrection rests on an ioredis ordering guarantee
  named nowhere in the code: `readyHandler` resends `prevCommandQueue` before flushing
  `offlineQueue`, and `setStatus` emits `ready` via `process.nextTick`. Verified correct
  today. An upstream change to that order would reopen the window silently, and no test
  pins it. Recorded as residual risk, not held.
- `waitFor` is now defined identically in both ledger suites, and `isConsentOpSpent`'s
  docblock re-derives the resend rationale already given on `spentConsentOps`. Both
  below the hold line.
- Test coverage gaps recorded and not held: no server-replied error (`-MISCONF`,
  `-NOPERM`) rejection anywhere, only client-side ones; the stalled-server ORIGIN of an
  entry is still planted rather than produced (now one issue-then-stall away, with
  `stall()` in the fixture); no test that a retained entry is actually retired by a later
  successful trigger; the `redis === null` leg of the drain guard is undriven.

### Architect-owned, now closed

Scope item 4 / AC4 had reopened: the `Set` conversion left the GETDEL convention entry
prescribing the deadline model at three sites, one of which the code now proves false.
Corrected by the architect in `ac3ce047` via `/ce-compound-refresh`. **AC1, AC2 and AC3
were met in round 4 and remain met; AC4 is met again as of that commit.** The three items
above are all that stand between this task and archive.

---

## Backend re-review signal (2026-09-01, round 5, commit 4195c8f7)

All three held items landed in one commit. Text only; no behaviour change, no
test added or reshaped. Symbols named so the diff can be grepped.

**Item 1 — the failure log promised release on expiry.** The
`fresh_auth.redis_compensating_del_failed` warning in `burnConsentOpEntry` now
reads "held spent in-process until a retried delete is confirmed to have landed
or a later presentation proves the canonical copy gone". Exactly the two
release events the `spentConsentOps` docblock lists, nothing else. Observed
firing with that text in the offline-queue suite's run log, on a genuine
`MaxRetriesPerRequestError` out of `event_handler.js`.

**Item 2 — the retry-ceiling figure at two sites.** Settled on the
`spentConsentOps` docblock's already-correct wording and applied it to the
`burnConsentOpEntry` docblock and the offline-queue suite header: the queue is
flushed "on every reconnect attempt divisible by `maxRetriesPerRequest + 1`",
on the 200ms-linear curve "flushing on the fourth close", "a little over a
second". Re-derived from the installed 5.10.1 `closeHandler` rather than
copied: `retryStrategy(++retryAttempts)` then
`retryAttempts % (maxRetriesPerRequest + 1) === 0`, so closes 1 to 3 schedule
200/400/600 and close 4 flushes. A grep for "about two seconds" and "reaches
`maxRetriesPerRequest`" across `backend/src` and `backend/tests` is now empty.

**Item 3 — "SOLE sweeper".** The `drainSpentConsentOps` docblock's
stalled-server bullet now says the tick "for one narrower arm is the only
trigger that sweeps WITHOUT a further presentation of the proof", followed by
"A replay's own resolved `GETDEL` would also retire that entry, but nothing
guarantees a replay arrives", which is the tick test's phrasing in substance.
The residual paragraph beneath it was checked rather than assumed: it does not
enumerate the replay retirement, but in that sub-case the key is gone and there
is no orphan, so its worst-case framing stays true and it was left alone.

### Changed beyond the hold, and why

The hold's theme was "statements of the retired model left standing where the
rewrite did not reach", and every round of this task has found one more. So
before signalling, the whole fresh-auth surface (`fresh-auth.ts`, the three
fresh-auth suites, `redis.ts`) was swept by five independent lenses for ANY
remaining stale statement, and each candidate was put to two refuters. Two
classes survived; both are pre-existing, neither is a regression of any round:

1. **"Redis `DEL` reply count" as the burn's arbitrator, at five sites.** The
   module docblock, the `inFlightConsumes` docblock and the
   `consumeFreshAuthToken` docblock in `fresh-auth.ts`, plus the header and
   one inline comment in `fresh-auth.test.ts`, all said the Redis-side burn is
   arbitrated by a `DEL` reply count. It has always been
   `(await redis.getdel(...)) !== null`, a non-nil bulk reply, not an integer
   count, and the only `DEL` the burn issues discards its reply. Checked in
   history rather than taken from the reviewers (who disagreed on it): the
   `GETDEL` leg predates the phrase, which was written against a burn that
   already used it, so it was stale since written. All five now say "a non-nil
   Redis `GETDEL` reply". A grep for "reply count"
   across `backend/src` and `backend/tests` is now empty.
2. **The offline-queue header misdescribed the sibling's delete path.** It said
   the sibling suite's compensating delete is "queued" and "always flushes on
   the very next tick". The sibling's client is genuinely `ready`, so ioredis
   `sendCommand` takes the `writable` branch and writes that `DEL` straight to
   the socket; it never enters the offline queue. It now says the delete "is
   written straight to a live socket rather than queued". The substantive
   point (the rejection path is never reached there) was already right.

One candidate was raised and refuted, recorded so it is not re-litigated: the
drain docblock's opening "the `DEL` resolving is the one event that proves the
canonical key unreadable" reads as exclusive, but its subject is the DRAIN's
own delete and the next sentence fixes the contrast as resolved-versus-merely-
dispatched; the ledger-wide two-event model is stated where it belongs. Left
as is.

### Evidence

No mutation probes this round: nothing behavioural changed, so there is no
mutant for a text edit to kill. The verification was the sweep above
(hold-compliance, retired-model sweep of `src`, retired-model sweep of the
tests and `redis.ts`, ioredis-truth of every changed sentence against the
installed source, and project conventions on the added lines); the first,
fourth and fifth lenses returned zero findings.

Green: `npm run typecheck` (src + tests), `npm run lint` (the one
pre-existing `author-supersession.ts` warning), and 120 tests across
`fresh-auth.test.ts`, `fresh-auth-redis-unavailable-burn.test.ts`,
`fresh-auth-consent-op-burn-offline-queue.test.ts` and the stale-anchor
canary.

### Not done, by choice

The noted-not-held items stand: no server-replied error rejection in any
test, the stalled-server entry origin still planted rather than produced, no
retained-then-retired test, the `redis === null` drain leg undriven, the
`armDrainOnReady` listener-count pin, the duplicated `waitFor`, and the
`afterEach` recovery boolean. The architect has already filed the two
follow-ups from this round separately. `backend/src/lib/ipfs-upload-token.ts`
remains the one place in the tree asserting the offline-queue rationale this
task disproved, unchanged, per the standing "noted, not held".

---

## Architect re-review (2026-09-01, round 6) — HELD PENDING FIXES:

Reviewed via `/ce-code-review` on the round-5 diff (`4195c8f7`), six lenses plus an
independent per-finding validation pass. No cross-model peer was available on this
host, so the adversarial lens ran in-process.

**All three round-5 hold items verified genuinely landed**, checked in the source
rather than taken from the signal, independently by three lenses:

- **Item 1.** The `fresh_auth.redis_compensating_del_failed` warning names the two
  real release events and nothing else.
- **Item 2.** The retry-ceiling figure is settled at both previously-missed sites.
- **Item 3.** The drain docblock now carries the tick test's qualifier.

**Every ioredis claim in the new text is correct**, and for the second round running
it was re-derived independently rather than copied: four lenses read
`built/redis/event_handler.js` in the installed 5.10.1 and confirmed the
`retryAttempts % (maxRetriesPerRequest + 1) === 0` flush condition,
`REDIS_MAX_RETRIES_PER_REQUEST = 3`, the 200/400/600 curve flushing on the fourth
close a little over a second in, `getdel(...) !== null` as the arbitrator, and the
sibling suite's delete taking `sendCommand`'s writable branch to a live socket. The
project-conventions lens returned clean on all four of its checks, including the
anchor gate over every added line, the carve-out clauses, and the commit's staging.
**AC1, AC2 and AC3 remain met; AC4 remains met.**

Three items, and they are one root cause rather than three. The sweep matched the
retired phrase as a literal token, so it closed every occurrence a grep can see and
missed every shape it cannot: a semantic restatement inside a paragraph the same
commit re-emitted, a vestigial stub whose comment still asserts the old model, and
an occurrence split by a comment wrap. Item 1 below is the only one with a
consequence beyond prose; settle it first, because its fix determines what item 3's
comment should say.

### 1. Two race tests stub the wrong Redis command, so neither drives the tier it claims

`fresh-auth.test.ts`'s `memStore fallback` dual-consume variant and the
`cross-helper` variant below it both stub `redis.get` and `redis.del`, and both
carry a comment saying this leaves the in-memory tier as the only arbiter. The burn
arbitrates on `redis.getdel`, which neither test stubs. So `redisLegRan` is true on
every run, the `!redisLegRan` branch that would call the stubbed `del` is
unreachable, and the win is settled by real Redis exactly as in the Redis-up variant
above them. Both are `skipIf(!redisAvailable)`, so the only environment they ever run
in is the one where this holds.

That is not merely a stale comment. The comment on the cross-helper variant states
why it is Redis-stubbed rather than Redis-up: the mutation kill "requires forcing
both helpers onto the in-memory tier". With `GETDEL` arbitrating, dropping the
`inFlightConsumes` lock still leaves exactly one winner, so the mutant these two
tests exist to kill survives both of them. The suite header's own summary of the
consent-op concurrency coverage — Redis stubbed down, both callers reaching the
in-memory tier, the lock closing the race — is false for the runs that actually
happen, and that header sentence sits one line from text this commit edited.

Fix: spy on `redis.getdel` in both tests alongside the existing `get` stub, restoring
it in the same `finally`, so the burn's Redis leg genuinely reports nothing removed;
then re-describe `del` as the compensating delete rather than as the Redis leg of the
burn. Confirm with a mutation probe that each test now fails with `inFlightConsumes`
removed — the probe is the point of the fix, not a formality, since the current
tests pass under exactly that mutation. Per the standing convention, the probe needs
a committed baseline for the file before every `git checkout --` restore.

### 2. The burn docblock states a one-event retirement contract its own body contradicts

`burnConsentOpEntry`'s docblock says the burn "clears the record only once the delete
is confirmed". The body clears the entry on a second event as well: the `alreadySpent`
branch retires it whenever a later presentation's own `GETDEL` resolves. The
`spentConsentOps` docblock, the drain docblock, and the failure log this very commit
rewrote all state the two-event model; this sentence is now the one place stating it
as one.

The line is in this commit's own added text — the paragraph was re-emitted when the
retry-ceiling figure was corrected — which makes it the mirror image of the round-5
"SOLE sweeper" item: that one stated the retirement contract too strongly, this one
states it too narrowly, and both were left standing by a rewrite that touched the
lines around them. The hazard is the usual one: a future author who trusts this
sentence reads the `alreadySpent` early release as a bug.

Fix: adopt the two-event form already used at `spentConsentOps`.

### 3. A retired "delete-reply count" survives a comment wrap

The signal states that a grep for "reply count" across `backend/src` and
`backend/tests` is now empty. The grep is empty; the claim it is offered for is not.
A comment wrap in `fresh-auth.test.ts` splits the phrase across two lines, so a sixth
site survived the five-site sweep. A wrap-tolerant pass that collapses newline and
comment-prefix runs before matching finds it immediately.

It matters beyond tidiness because the surviving sentence is the design justification
for the test in item 1, which is itself wrong — the same two lines carry both defects.

Fix: rewrite the sentence to say a non-nil `GETDEL` reply, and re-verify the sweep
wrap-tolerantly rather than by single-line grep. A completeness claim in the next
signal should name the technique it used, not just the phrase it searched for.

### Noted, not held

- **The recurring lesson of this round is about the sweep technique, not the code.**
  Three of three findings come from a symbol-level pass over a vocabulary-level
  problem. Whether the same-day learnings entry on this exact subject should absorb
  the wrap-tolerant and semantic-restatement steps is architect-owned and was
  deliberately deferred rather than folded into this hold.
- The drain docblock's "the `DEL` resolving is the one event that proves the
  canonical key unreadable" survives on its "its delete" scoping. Once item 2 lands
  it is the last over-readable sentence in the file. Not held; worth not making
  worse.
- The operator log names both release events but not the restart that voids them,
  since the hold is process-local. Accurate as landed, and adding the clause runs
  against the project's logging-minimalism stance. Dismissed deliberately.
- Nothing pins agreement between the retirement contract as prose and as
  implemented; both release events are individually covered, which is exactly why
  item 2's drift produced no failing test. The reviewers proposed a standing canary
  over the fresh-auth surface that matches after comment wraps are collapsed. Not
  held here.
- Every corrected figure remains unpinned prose. No test asserts the retry-ceiling
  arithmetic, the log wording, or the retirement contract.
- The round-5 coverage gaps are unchanged and still not held: no server-replied
  error rejection anywhere, the stalled-server entry planted rather than produced,
  no retained-then-retired test, the `redis === null` drain leg undriven.
- `backend/src/lib/ipfs-upload-token.ts` is unchanged and still carries the
  disproved rationale, per its own pending task. Confirmed out of scope again.

### Architect-owned

Nothing outstanding. AC4's convention entry stays correct as of the round-5
correction; the possible refresh noted above is a new question, not a reopening.
