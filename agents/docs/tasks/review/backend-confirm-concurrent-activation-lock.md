# BACKEND-CONFIRM-CONCURRENT-ACTIVATION-LOCK — Serialize concurrent /confirm (and /link) activation so one auth_token cannot double-fire account creation

**Owner:** backend
**Created:** 2026-05-26 (architect, surfaced by `/ce-code-review` of the signup-binding range — adversarial P2, conf 50, pre-existing)
**Priority:** P3 (pre-existing; not introduced by the signup-binding work)

## Context

`POST /api/auth/confirm` (`backend/src/routes/signup-verify.ts`) reads the pending-signup row by `auth_token`, then activates the account (`createClaimedAccount` broadcast + pg activation). The read and the activation are not serialized: two concurrent `/confirm` requests carrying the same valid `auth_token` (+ binding cookie) can both pass the lookup and both proceed to activation, risking a double `createClaimedAccount` broadcast. `/link` has the structurally similar activation step.

Flagged as pre-existing during the signup-binding review; the binding work neither introduced nor fixed it. Low likelihood (requires two near-simultaneous requests with the same token+cookie), but the failure mode is a wasted/duplicated on-chain account-creation attempt.

## Goal

Serialize the confirm/link activation so a single `auth_token` activates at most once under concurrency. Options (implementer's call):

- Wrap the lookup + activation in a transaction with `SELECT ... FOR UPDATE` on the `accounts` row, or
- A pg advisory lock keyed on the username / auth_token for the activation critical section.

The chosen mechanism should make the second concurrent request observe the row already consumed (verify_token cleared) and return the normal "already used / invalid" path rather than re-broadcasting.

## Acceptance

- Two concurrent `/confirm` requests with the same valid `auth_token` + cookie result in exactly one activation (one 200, the other a clean rejection); `createClaimedAccount` is invoked at most once.
- Equivalent coverage for `/link` activation.
- Test exercises the concurrent case (real Postgres per the project test convention).

## Non-goals

- Reworking the binding mechanism (separate, in `backend-auth-token-session-binding`).
- Broader idempotency for unrelated routes.

---

## Architect re-review (2026-05-27, round-1 → round-2) — HELD PENDING FIXES

`/ce-code-review` ran on the implementation commit `099c1a20` (+ the `d5fde577` test repoint) as part of a signup-binding cluster pass (12 personas, ce-agent-native skipped per PEvO; cluster diff scoped to `44b26476..HEAD`). **The stated goal is achieved and verified:** `createClaimedAccount` runs inside the per-auth_token `pg_advisory_xact_lock` transaction, the second concurrent same-token request re-reads under the lock and sees `verify_token` cleared, so the single-use chain broadcast fires at most once (correctness + adversarial both confirmed the double-fire is genuinely closed; the COMMIT precedes only the post-activation accreditation broadcast, not `createClaimedAccount`). Client release on every exit path verified. Five residual items block archive; two larger concerns are filed as a separate task (see below), NOT held here.

### Items to address

**1. (P2, test) Failed-broadcast-log-shape test only exercises the BEGIN-failure path.** In `signup-verify.test.ts` the `pool.connect` stub injects the failure on the client's first query, which is `BEGIN`; `inTransaction` therefore stays `false` and the inner-catch ROLLBACK branch is never exercised. The assertions (outer-catch event + 500) are correct, but the comment implies the mid-transaction ROLLBACK path is what's tested. **Correct the comment** to scope it to the BEGIN-failure path (must); optionally add a second injection after `BEGIN` succeeds (e.g. on the advisory-lock query) to actually cover the ROLLBACK branch. Same pattern in the `/link` variant.

**2. (P2, test) `/link` concurrent test does not assert the accreditation-broadcast call count.** Both concurrent requests may legitimately return 200 (winner + stuck-resume loser); the DB single-row assertion is the load-bearing check, but nothing pins how many times the accreditation broadcast fired, so a duplicate-broadcast regression (see item 5) would pass. Add a broadcast call-count assertion consistent with item 5's corrected comment — the test mock controls the HAF probe, so set up and assert the actual best-effort behavior (do not assert a false `calledTimes(1)` if the scenario can legitimately re-broadcast).

**3. (P2, reliability) No `lock_timeout` on the advisory-lock waiter.** The app pool has no `statement_timeout` (unlike the HAF pool), so a second same-token request waiting on `pg_advisory_xact_lock` holds its own pool connection blocked for the full holder duration (the holder can be inside the ~30s chain broadcast). Add `SET LOCAL lock_timeout = '45000'` immediately after `BEGIN` (before the lock acquisition) so a stuck holder makes the waiter fail (pg `55P03` → 500) and free its connection. The 45s ceiling sits just above the expected worst-case holder, so it rarely fires in normal operation. (Interim bound — the activation redesign task below may rework the lock-hold duration and supersede it.)

**4. (P3, comment) `lockSignupActivation` docblock overclaims "distinct tokens never serialize".** `hashtext()` returns int4; a birthday collision can briefly serialize two unrelated tokens. Harmless (each re-reads its own row by its own `verify_token` and proceeds), but correct the wording (e.g. "distinct tokens almost never serialize; a rare int4 collision can briefly serialize an unrelated pair, harmless because each re-reads its own row"). Keep `hashtext` for parity with the `tryEnqueueBridgeImport` precedent; do not upgrade the hash.

**5. (P3, comment) "HAF-probe-deduped" claim overstated.** The comment frames the loser's stuck-resume re-broadcast as deduped, but the HAF probe can lag the winner's just-landed accreditation broadcast, so the loser can re-broadcast the accreditation `custom_json`. The duplicate is low-harm (idempotent: read-time `ROW_NUMBER() OVER (ORDER BY block_num DESC)` dedup + `seedAccreditationBonus` Redis SET-NX), so no new guard is needed — scope the comment to "best-effort dedup with read-time ROW_NUMBER as the backstop".

**6. (P2→clarifying comment) Document the intentional connection-hold across the chain broadcast.** The pool client is deliberately held across `createClaimedAccount` (~30s) inside the lock so the lock spans the single-use broadcast (the double-fire defense). Add a short comment at the call site noting this is intentional so it is not "optimized" out before the redesign task lands. (The pool-saturation cost itself is filed below, not held here.)

### Filed as a separate task (NOT held on this task)

The two larger concerns are facets of one root design tension (an irreversible chain op that must be deduplicated, must not pin a scarce pool connection, and must fail recoverably) and are filed together as `tasks/pending/backend-signup-activation-failure-recovery-and-pool-hold.md` (P2):
- **Pre-existing recovery gap:** if `createClaimedAccount` succeeds then `COMMIT`/`encryptKey`/the connection fails, ROLLBACK restores `verify_token` (still set) → retry hits 409 DUPLICATE; Option C recovery (`verify_token IS NULL`) does not cover it → permanent lockout + burned claim token. Verified PRE-EXISTING (the base used the same ordering in autocommit); this task's tx-wrap marginally widens it but did not introduce it.
- **New pool-saturation:** the connection held across the ~30s broadcast (pool `max=5`) means ~5 concurrent distinct-token signups exhaust the pool. New in this task. The naive "move the broadcast outside the lock" fix would reopen the double-fire, so the redesign must preserve the dedup invariant.
The advisory scaffold/`SignupRow`/`LinkRow` duplication + the load-bearing `inTransaction` flag (below PEvO's 3-site extraction threshold) is noted there as opportunistic cleanup when the activation path is reworked.

### Re-review signal

When items 1-6 land, `git mv` this file back to `tasks/review/`. Round-2 architect review scopes `/ce-code-review` to the round-2 commits only.

---

## Backend re-review signal (2026-05-27)

Round-2 hold items 1-6 landed in the commit that moves this file to `review/`.
Mapping to the hold block above:

- **Item 1 (BEGIN-failure-only log-shape test):** repointed the synthetic-failure
  injection in BOTH the `/confirm` and `/link` `*.failed log shape` tests
  (`signup-verify.test.ts`) to fail the SECOND client query — the first statement
  inside the open transaction, after `BEGIN` succeeds and `inTransaction` is set
  — so the inner-catch `if (inTransaction)` ROLLBACK branch is now genuinely
  exercised (the ROLLBACK query itself passes through). The comment is rewritten
  to describe that path accurately. **Deviation from the literal hold text,
  flagged for your call:** the item asked to (must) scope the comment to the
  BEGIN-failure path and (optionally) add ROLLBACK coverage. I instead delivered
  the optional ROLLBACK coverage by repurposing the existing test (so the
  comment honestly describes ROLLBACK), rather than keeping a BEGIN-failure-only
  test plus a second ~45-line near-duplicate per route. Net: the load-bearing
  ROLLBACK branch is covered and the comment matches reality, at zero added test
  count. If you'd rather keep an explicit BEGIN-failure-scoped test as well, hold
  and I'll add it.
- **Item 2 (/link broadcast call-count):** the `/link` concurrent test now
  asserts `broadcastJsonMock.mock.calls.length` is `>= 1` (the winner always
  broadcasts) and `<= okCount` (at most one broadcast per 200 response). This
  catches a fan-out-beyond-one-per-activation regression while tolerating the
  legitimate best-effort stuck-resume re-broadcast.
- **Item 3 (lock_timeout):** `SET LOCAL lock_timeout = '45000'` added immediately
  after `BEGIN`, before `pg_advisory_xact_lock`, in both `/confirm` and `/link`.
  A stuck waiter now fails (pg `55P03`) and frees its pool connection instead of
  blocking for the full holder duration. Commented as an interim bound the
  activation redesign may supersede.
- **Item 4 (docblock collision overclaim):** `lockSignupActivation` docblock
  corrected — "distinct tokens almost never serialize; `hashtext()` returns int4
  so a rare birthday collision can briefly serialize an unrelated pair, harmless
  because each request re-reads its own row by its own verify_token."
- **Item 5 (HAF-probe-deduped overstated):** the `/link` concurrent-test comment
  reworded to "best-effort deduped, not single-fire; the HAF probe can lag the
  winner's just-landed custom_json so a stuck-resume loser MAY re-broadcast; the
  read-time `ROW_NUMBER() OVER (ORDER BY block_num DESC)` dedup and the
  `seedAccreditationBonus` SET-NX are the backstops."
- **Item 6 (connection-hold comment):** added a comment at the
  `createClaimedAccount` call site noting the connection is intentionally held
  across the broadcast inside the lock (the double-fire defense), with a
  do-not-move-outside-the-lock warning, so it is not "optimized" out before the
  activation redesign lands.

Verification: `npm run typecheck` (src + tests) clean; `npm run lint` clean for
this change (the one residual warning is pre-existing in
`lib/author-supersession.ts`, untouched); scoped `npx vitest run` of the
signup-verify cluster (`signup-verify-concurrent-activation`, `signup-verify`,
`signup-verify-postbroadcast-severity`, `signup-verify-stuck-recovery`,
`signup-verify-session-binding`) green — 5 files / 28 tests passed against real
Postgres/Redis.

The two larger concerns (recovery gap + pool saturation) remain filed in
`tasks/pending/backend-signup-activation-failure-recovery-and-pool-hold.md` and
are NOT addressed here, per the hold block's split.
