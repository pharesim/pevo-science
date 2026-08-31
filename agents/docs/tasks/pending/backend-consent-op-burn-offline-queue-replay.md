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
  refused replay cleans up after itself), or the proof's own expiry.
- The existing `memStore` cleaner also drains still-pending compensating
  deletes once Redis is reachable again. That is not what closes the hole (the
  ledger is), but it stops an orphaned canonical key from outliving the
  process-local entry guarding it.

The compensating delete is KEPT and its client-existence guard is KEPT. Gating
it on `isRedisAvailable()` would still be wrong for the reason the convention
entry gives. What changed is that it is no longer treated as the thing that
establishes single-use.

**AC2 (flap-recovery preserved)** is unchanged by construction: nothing was
added to the issue or read paths, and the ledger is only ever written at burn
time. A blip between issue and consume still resolves out of `memStore` and
returns `valid`. The new test asserts this directly on the first consume.

**Residual, stated plainly:** the ledger is process-local, so a backend restart
between the burn and Redis returning drops it. That window is not closable
without a durable store, and a restart also drops `memStore`, which is already
the point past which Redis is the sole arbiter. The drain shortens the window
to "until Redis is next reachable" rather than "the rest of the TTL". Flagged
here rather than fixed because a Postgres-backed burn ledger is a schema change
and a new hard dependency on the consent-op consume path, which is an architect
call, not a backend one.

**AC3 test:** `backend/tests/lib/fresh-auth-consent-op-burn-offline-queue.test.ts`
drives the real rejection. It stands a local TCP proxy between a
production-configured ioredis client (`maxRetriesPerRequest: 3`,
`commandTimeout`, the imported `redisRetryStrategy`) and the real Redis, then
severs it. `isRedisAvailable()` is not stubbed to a toggle: it is production's
own `status === 'ready'` predicate applied to a client whose status is driven by
a real socket, and the queue rejection is ioredis's own
`MaxRetriesPerRequestError` (confirmed in the run log). The test pins that the
canonical key is STILL PRESENT after recovery, which is the evidence that the
queued delete really was flushed unsent, and that the replay is refused anyway.

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
