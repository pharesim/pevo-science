# BE-CLAIM-ACCOUNT-HAF-OP-RECONCILE — Migrate counter-delta reconcile to HAF op-fingerprint reconcile + idempotency key

**Owner:** backend
**Created:** 2026-04-28 (architect filing during round-2 review of `backend-claim-account-chain-reconcile.md` to close DI-1 + DI-2 the data-integrity reviewer surfaced; aligns with `agents/docs/solutions/conventions/chain-write-timeout-ambiguous-outcome-2026-04-22.md` Option A.3)
**Priority:** P1

## Context

`backend-claim-account-chain-reconcile.md` (commit `ef56eab`) added a counter-delta reconcile after `BroadcastTimeoutError` during `claim_account` batch broadcast: read `pending_claimed_accounts` counter on `config.hiveOnboardAccount` before and after the broadcast, INSERT `clamp(post - pre, 0, batchSize)` rows into `account_creation_tokens`. Adequate for current beta operating volume but has two structural data-integrity gaps the architect re-review surfaced:

**DI-1 — No idempotency key on `account_creation_tokens`.** Schema is `(id SERIAL PK, claimed_at, used_at, used_for)`. No `claim_tx_id`/`block_num`/UNIQUE constraint that ties a row to a specific on-chain claim event. Failure modes:
- Process restart between counter reads + manual operator retry → reconcile fires twice → phantom DB rows beyond what the chain holds.
- Downstream `create_claimed_account` broadcasts against a token the chain doesn't know about → broadcast fails.
- The failed-create release path (sets `used_at = NULL`) makes the phantoms recyclable forever, perpetuating the failure.

**DI-2 — Counter delta is not exclusive to the broadcast window.** `pending_claimed_accounts` decrements on every `create_claimed_account` op. If users sign up during the 30s broadcast hang (a real production scenario as PEvO scales), postCounter is depressed by the user-onboarding consumes and reconcile under-inserts:

```
postCounter = preCounter + (claims_landed) − (consumes_during_window)
delta = (claims_landed) − (consumes_during_window) ≤ claims_landed
inserted = clamp(delta, 0, batchSize) < claims_landed
```

Tokens land on chain, never get recorded in DB. Permanent silent drift. The held task's `[TODO Architect]` (line 36-37) flagged this exact concern at task-creation time.

The right shape per `agents/docs/solutions/conventions/chain-write-timeout-ambiguous-outcome-2026-04-22.md` is **Option A.3**: poll HAF for the broadcast's actual op events by fingerprint (account + op type + block range), INSERT one DB row per real op with an idempotency key derived from the on-chain identity. Closes both DI-1 (idempotency) and DI-2 (op-query is exclusive to the broadcast window, immune to parallel decrements).

This task does **not** block the held `backend-claim-account-chain-reconcile.md` task's archive. The incremental fixes (log severity, untested branches, code comment, log-outcome enum) can land first under counter-delta. This task migrates the core reconcile logic to the more robust shape.

## Goal

Replace the counter-delta reconcile with a HAF op-fingerprint reconcile that:

1. Captures pre-broadcast block height (or block_num timestamp boundary).
2. Captures post-broadcast block height after the timeout fires.
3. Queries HAF for `claim_account` ops where the signer/creator is `config.hiveOnboardAccount` and `block_num` is in `[pre_block, post_block]` (with a small grace window for HAF indexing lag — see Option A.3 in the convention doc).
4. INSERTs one row per op into `account_creation_tokens` with `ON CONFLICT (claim_tx_id, claim_op_index) DO NOTHING` so re-running the reconcile is a no-op.

## Acceptance

### 1. Schema migration

Add `claim_tx_id TEXT` and `claim_op_index SMALLINT` columns to `account_creation_tokens`. Create a partial UNIQUE index `ON account_creation_tokens (claim_tx_id, claim_op_index) WHERE claim_tx_id IS NOT NULL` so existing rows (NULL tx_id) don't conflict and new rows enforce uniqueness.

Migration must be backwards compatible: existing rows stay valid until their `used_at` lifecycle completes. New reconciles populate the new columns; ad-hoc/manual INSERTs may leave them NULL during the transition window.

### 2. HAF query for `claim_account` ops

The HAF schema exposes `hive.operations` (or equivalent — verify against the existing `T.*` aliases in `backend/src/hafsql.ts`). Query shape:

```sql
SELECT op.trx_id, op.op_in_trx, op.block_num, op.body
FROM <claim_account_ops_view> op
WHERE op.creator = $1            -- config.hiveOnboardAccount
  AND op.block_num BETWEEN $2 AND $3
ORDER BY op.block_num, op.op_in_trx
```

If `T.*` doesn't already expose a claim_account-typed view, add one to the convention's CTE helpers — coordinate with Mahdi (HAF maintainer per memory `reference_mahdi_haf`) if the HAF schema needs a new view.

The pre/post block boundaries: capture `pool.query('SELECT MAX(block_num) FROM hive.blocks')` (or equivalent) before broadcast, after broadcast. Include a small grace window (~10-15 blocks ≈ 30-45s) on the post side to account for HAF indexing lag — verify the lag against a test against the `pevo_app_test` HAF.

### 3. Reconcile logic

Replace `reconcileClaimTimeout` with a HAF op-query path:

```ts
async function reconcileClaimTimeout(
  pool: Pool,
  err: BroadcastTimeoutError,
  preBlock: number,
  batchSize: number,
): Promise<number> {
  // 1. Wait for HAF lag window (or poll)
  // 2. Query HAF for claim_account ops by hiveOnboardAccount in [preBlock, +grace]
  // 3. For each op: INSERT INTO account_creation_tokens (claim_tx_id, claim_op_index, ...) ON CONFLICT DO NOTHING
  // 4. Log structured outcome with reconcile_outcome enum
  // 5. Return rows_inserted
}
```

`preCounter` becomes `preBlock`; `postCounter` is no longer needed (the HAF query bounds the window).

### 4. Test coverage

Three categories:
- **Unit tests** mocking the HAF op-query response: full landing, partial landing (HAF returns fewer ops than batchSize because some failed on chain), zero landing, op-query failure (HAF unavailable), INSERT-conflict (idempotency key collision — verify ON CONFLICT path doesn't error).
- **Integration tests** against `pevo_app_test` HAF: simulate a broadcast that times out, verify reconcile finds the actual on-chain ops and inserts them with correct idempotency keys.
- **Idempotency test:** invoke reconcile twice for the same broadcast, assert second invocation inserts 0 rows (ON CONFLICT triggers).

### 5. Startup health check

Add a startup gauge that compares `chain.pending_claimed_accounts` (Hive API) against `COUNT(*) FROM account_creation_tokens WHERE used_at IS NULL` (DB). Log at warn if drift exceeds a small threshold (e.g., 5 tokens). Operators can investigate without the failure being silent.

### 6. Backfill or accept

Existing rows have NULL `claim_tx_id`. Two paths:
- **Best-effort backfill:** scan past `claim_account` ops by `hiveOnboardAccount`, match by approximate timestamp + counter delta, populate the columns. Risky if past data is already drifted.
- **Accept the NULL legacy:** new rows enforce uniqueness; old rows stay as-is until consumed via `used_at`. The partial UNIQUE index supports this. Recommended.

Document the decision in the implementation notes.

## Non-goals

- Adding a persistent task queue. The reconcile remains in-process, single-shot per timeout.
- Changing the broadcast timeout value (30s) or the wrapping helper (`broadcastSendOperationsWithTimeout`).
- Reconciling `create_claimed_account` timeouts (separate concern — those create real Hive accounts; the failure mode is different).
- Per-op transaction boundaries beyond ON CONFLICT idempotency.

## Dependencies

- HAF schema must expose a `claim_account` op view (or join `hive.operations` with op-type filter). Verify before starting.
- The held `backend-claim-account-chain-reconcile.md` task should land its incremental fixes first (log severity, untested branches, etc.) so this task can branch from a clean baseline.

## Cross-references

- `agents/docs/solutions/conventions/chain-write-timeout-ambiguous-outcome-2026-04-22.md` — the convention this task follows (Option A.3).
- `backend-claim-account-chain-reconcile.md` (held in `tasks/pending/`) — the counter-delta predecessor; this task migrates from it.
- `backend/src/hafsql.ts` — where the HAF op-query helper lives, parallel to existing CTE helpers.
- `agents/docs/ARCHITECTURE.md` — the claim flow's data-flow may need a sentence noting the reconcile path.
