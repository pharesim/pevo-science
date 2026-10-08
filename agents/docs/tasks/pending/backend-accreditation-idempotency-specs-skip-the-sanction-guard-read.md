# The accreditation idempotency specs do not queue the sanction guard's HAF read, so six fail and five pass through the lookup-failure catch

**Owner:** backend
**Created:** 2026-10-06
**Priority:** low

Filed at the user's request after a root-cause pass on 2026-10-06. Each of the seven backend files
that fail when run alone on clean main was diagnosed by one agent and re-checked by a second; the
failing spec sets were identical at 342f2820 and 74488ad5. The second agent's runs for this file
were at 985fe90b, and the backend tree is unchanged from there to b38c93fe (`git diff --stat`).
Priority low: the production behavior these specs protect was measured intact, and the
revoke→re-accredit spec, the one that pins a security gate, kept asserting the fresh broadcast
throughout; only its HAF call count fails.

## Why

Inside its `if (hafPool)` branch, `POST /api/accreditation/verify`
(`backend/src/routes/accreditation.ts`) makes three HAF reads before the cap claim
(`incrementBroadcastAttempts`), in this order:

1. the existing-accreditation gate, `findExistingAccreditation` (`backend/src/lib/idempotency.ts`);
2. the ever-sanctioned guard, `hasUnliftedSanction(pending.hive_username)`
   (`backend/src/accreditation.ts`);
3. the per-token lookup, `lookupAccreditationBroadcastIdempotency`, which calls
   `findAccreditationBroadcastByIdempotencyKey` unless a cached hit exists.

All three query the pool from `getPool()` in `db.js` (the handler passes it to the gate and the per-token lookup; `hasUnliftedSanction` calls `getPool()` itself), which `backend/tests/routes/accreditation-idempotency.test.ts`
mocks as `{ query: hafQueryMock }`. The specs feed results in FIFO order with
`mockResolvedValueOnce` and queue only two: gate, then per-token. The guard call came in with
9effff27 "backend(accreditation): address revoke-sanction hold-block (P1 self-service sanction
guard + P2/P3 fixes)" (`git log -S 'hasUnliftedSanction(pending.hive_username)'`), which did not
touch this file. The file is byte-identical from 9effff27^ to HEAD. Measured: 19/19 at 9effff27^;
6 failed and 13 passed at 9effff27 and at 985fe90b, the same six specs.

What happens now (from the code; an instrumented copy recorded the call order gate, guard,
per-token):

- The guard takes the second queued result, the one meant for the per-token lookup. A hit row
  `{ trx_id, block_num }` has no `sanction_block`, so the guard compares NaN to NaN and answers
  "not sanctioned". `{ rows: [] }` also answers "not sanctioned". A rejection makes it fail closed
  (true).
- The per-token lookup then gets `undefined`: after `mockReset`, an unqueued `hafQueryMock` call
  resolves to `undefined`; it does not reject. `findAccreditationBroadcastByIdempotencyKey` throws
  a TypeError reading `.rows`, and the handler's `catch (lookupErr)` logs
  `accreditation.verify.idempotency_lookup_failed` and goes on to the cap claim and a fresh
  broadcast.

Failing specs and what they get at HEAD (measured):

| Spec | Got |
|---|---|
| 'HAF hit returns existing tx_id with outcome:already_landed, skips broadcast, seeds bonus, no cap slot consumed' | fresh broadcast, `tx_id` 'fresh-accred-tx-id', no `outcome` |
| 'idempotency hit returns 200 even when broadcast-attempts counter is at cap (probe-before-INCR ordering)' | 502 `BROADCAST_ATTEMPT_LIMIT_EXCEEDED`; the counter was pre-seeded at cap |
| 'HAF lookup throw degrades gracefully ...' | 403 `ACCREDITATION_SANCTIONED`: the rejection meant for the per-token lookup reaches the guard |
| 'token cleanup failure on hit ...' | fresh broadcast |
| 'revoke→re-accredit flow: latest action is revoke ...' | status, `tx_id`, `outcome` and broadcast count pass; `toHaveBeenCalledTimes(2)` gets 3 |
| 'retried /verify after per-token idempotency-hit returns cached 200 envelope, broadcast not invoked' | the first flight broadcasts fresh |

Five green specs reach their fresh broadcast through the same catch, not through a per-token miss
(measured: one unqueued HAF call in each). Their 200, fresh `tx_id`, no `outcome` and
one-broadcast assertions hold, but none of them feeds the per-token lookup a miss:

- 'HAF miss broadcasts and embeds idempotency_key into accredit custom_json payload'
- 'seedAccreditationBonus throws → 502 POST_BROADCAST_OPERATOR_REQUIRED ...'
- 'retried /verify on the same token returns the identical 200 envelope after broadcast success'
- 'grace-period record carries the broadcast tx_id, not the gate-hit tx_id'
- 'pipeline rejection in recordAccreditationCompletion → 200 envelope; ...'

**The production behavior holds (measured).** The second agent drove the handler with a
`hafQueryMock` that dispatches on SQL text, so queue order played no part:

- An unsanctioned account with a per-token hit gets 200 `already_landed` and no broadcast, also
  with the counter at cap: the per-token probe still runs before the pre-INCR.
- A per-token lookup that throws logs the warn and broadcasts.
- A sanctioned account with a per-token hit gets 403 with no broadcast, no bonus seed, the token
  kept and no cap INCR. A guard query that throws gets the same 403. A lifted sanction proceeds to
  `already_landed`.
- A latest `revoke` makes the gate miss and the route broadcasts. A gate hit short-circuits before
  the guard. A gate throw answers 503 `ACCREDITATION_GATE_UNAVAILABLE`.

The intent of 9effff27 (a self-service `/verify` must not lift a sanction, and refuses before the
cap claim) fits every spec's assertions. The specs only need to model the third read.

## Scope

Test-only. No change under `backend/src`.

1. In each of the 11 sequences that pass the gate, queue the guard's result between the gate
   result and the per-token result (or the per-token rejection):

   ```ts
   hafQueryMock.mockResolvedValueOnce({ rows: [{ sanction_block: null, auth_block: null }] });
   ```

   That is the guard query's real answer for an account with no ops: its outer SELECT has no FROM
   (two scalar subqueries over the `acct_ops` CTE), so it always returns one row (from the code).
   The 11 are the six failing specs (in the grace-period one, before the first flight; in the
   revoke spec, after the revoke gate row) and the five green specs above. Where an adjacent
   comment lists the queued results, add the guard to it.
2. Revoke spec: `toHaveBeenCalledTimes(2)` becomes 3, and its "Both layers ran" comment names the
   three reads.
3. Header docblock, the "Two-layer HAF call ordering" paragraph: it says `/verify` performs TWO
   sequential HAF queries and that per-token specs chain one `{rows: []}` preamble. Narrow it to
   the three reads in order. Leave the mock-posture paragraph and the "Carve-out clause (c)
   follow-up" paragraph as they are. The one fileless citation that
   `backend/tests/eslint/no-unresolvable-carve-out-companion-citation.test.ts` ledgers for this
   file is the "Clause (c) real-path companion" comment in the pipeline-rejection spec, which this
   task also leaves as is.
4. Three comments say an unqueued `hafQueryMock` call would reject ("no-more-mocks fallback",
   "no-more-mocks rejection"): in 'gate hit returns outcome:already_accredited, skips per-token
   check + broadcast, consumes zero cap slots', 'gate HAF throw returns 503
   ACCREDITATION_GATE_UNAVAILABLE ...' and 'retried /verify after existing-accreditation gate-hit
   returns cached 200 envelope, broadcast not invoked'. The call resolves to `undefined`. Those
   specs stay sound through their `toHaveBeenCalledTimes(1)` and `hafCallsBefore` assertions.
   Delete or narrow the rejection claim; do not add an explanation of the mock in its place.

## Acceptance criteria

1. The file passes 19/19 run alone, judged by exit code 0 and no Errors line.
2. Mutation check in a scratch copy, with the fixed test file: make the per-token
   `catch (lookupErr)` block in the `/verify` handler rethrow. Exactly one spec fails, 'HAF lookup
   throw degrades gracefully ...'. Against a copy where only the six failing specs were fixed, the
   same mutation also fails the five green specs named in Why. Both halves are expected from the
   code and from the second agent's run of the full fix, which counted no unqueued call in any
   spec; the implementer confirms them and reports both in the signal block.
3. No assertion changes other than the revoke spec's call count. No file under `backend/src`
   changes.
4. Typecheck and lint are clean. `backend/tests/eslint/no-unresolvable-carve-out-companion-citation.test.ts`
   is green without a ledger edit for this file. Changed comments follow root `CLAUDE.md`
   "Comment anchors", and the pre-commit anchor gate passes without `anchor-allow`.

## Notes

- Overlap. No open task targets this file; these touch the same `/verify` handler:
  - `backend-verify-gate-treats-wot-enrollee-as-accredited` (high, pending) changes the gate's
    predicate and keeps the guard and the `already_landed` branch. Its acceptance specs (a `wot`
    enrollee, a sanctioned enrollee) need the three-read queue if they go into this file. Take
    this task first or in the same pass.
  - `backend-latest-op-haf-lookups-walk-the-blocks-index` (high, pending) rewrites the SQL of the
    gate and of `findAccreditationBroadcastByIdempotencyKey`. From its scope, the number and order
    of the reads do not change. This file mocks the pool, so it pins route glue, not those
    queries' results.
  - `backend-accreditation-release-op` (high, pending) makes `hasUnliftedSanction` compare
    `(block_num, op id)`. If that changes the guard query's result columns, the guard row queued
    here changes in the same commit.
  - `backend-mailbox-binding-registry` (high, pending) adds a claim after the gate and the guard,
    on the app database (`app-db.ts`), which this file does not mock.
  - `blocked/backend-accreditation-verify-requires-the-account-session` (high) puts
    `verifyHiveSignature` on `/verify`. Every request here then needs auth, and the header's
    "verifyHiveSignature is NOT mocked here" sentence becomes false. No conflict: this fix can land
    first.
  - `backend-accreditation-limiters-refund-work-already-done` (high, pending) keeps 503 refunded on
    `/verify`, so '503 ACCREDITATION_GATE_UNAVAILABLE refunds the per-IP limiter slot
    (skipFailedRequests canary)' stays valid, though its title names the option that task removes.
  - `backend-state-g-unverified-row-lifecycle` lists this file in the clean-main red bar of its
    signal block. Nothing to change there.
- Residuals, not proposed:
  - The `mockResolvedValueOnce` queue is order-coupled. Any HAF read added between the gate and
    the broadcast shifts it, and the lookup catch hides the shift. A `mockImplementation` that
    dispatches on SQL text would not shift. Optional hardening, not part of this fix.
  - After this fix, the guard's place in `/verify` (after the gate, before the per-token lookup
    and the cap claim) is pinned here only by queue order.
    `backend/tests/routes/accreditation-verify-sanctioned.test.ts` mocks `hasUnliftedSanction` to
    true and asserts 403 and no broadcast; it does not check the cap counter. The second agent's
    probes confirmed the placement. No new spec proposed.
  - Found while filing, from the code: the header of
    `backend/tests/routes/accreditation-verify-sanctioned.test.ts` says the `hasUnliftedSanction`
    SQL "is covered against real Postgres in `accreditation-membership-cte.test.ts`". That file
    imports only `buildWith`, `activeAccreditationsCteBody` and `firstAccreditedAnchorCteBody`
    from `hafsql.ts`, and no test under `backend/tests` references the guard's `sanction_block`
    column. For triage.
- No doc follow-up: the change is test-only and no contract moves.

## Backend note (2026-10-09): the guard is now `readSanctionState`

From `backend-failed-sanction-read-is-not-a-sanction` (commits 4ccf730e, 74c796e8). The guard's query
and the queued row `{ sanction_block: null, auth_block: null }` are unchanged, but a rejected guard query
now answers 503 `SERVICE_UNAVAILABLE`, not a 403. 'HAF lookup throw degrades gracefully ...' therefore
gets a 503 where the Why table says 403; the same six specs fail. The file also gained 'sanction read
throws → retriable 503 SERVICE_UNAVAILABLE, ...' (gate row, then a rejection), and its HAF-unconfigured
spec now expects a 503; both pass. The residual about the `accreditation-verify-sanctioned.test.ts`
header is resolved: it now cites `sanction-read-real-postgres.test.ts`.
