---
title: "Before reconciling a DB table that proxies a chain primitive, ask if it earns its keep"
date: 2026-04-28
category: conventions
module: backend
problem_type: convention
component: database
severity: high
applies_when:
  - Designing a new DB table that mirrors, aggregates, or counts on-chain operations
  - Reviewing a reconcile, idempotency, or drift-fix task on a DB table that wraps a chain primitive
  - Triaging data-integrity findings (DI-N gaps) on a table whose semantics overlap with chain state
  - Auditing existing tables for refactor opportunities under PEvO principle #1 (Hive-native, not Hive-wrapped)
tags:
  - chain-primitive
  - soft-proxy
  - hive-native
  - reconciliation
  - table-design
  - drift
  - consensus
  - db-design
---

# Before reconciling a DB table that proxies a chain primitive, ask if it earns its keep

## Context

Architect filed `backend-claim-account-haf-op-reconcile.md` to close two data-integrity gaps on `account_creation_tokens`: DI-1 (no idempotency key — duplicate reconcile inserts phantom rows) and DI-2 (counter delta is not exclusive to the broadcast window — parallel `create_claimed_account` decrements during a 30s broadcast hang cause under-counting). The proposed shape was a HAF op-fingerprint reconcile with `(claim_tx_id, claim_op_index)` UNIQUE per row — Alternative A in the task body. A first-pass architect refinement narrowed to Alternative B (cursor + count) on the assumption that smaller diff is better.

Backend's premise challenge audited every reference to `account_creation_tokens` (`grep -rn` across `backend/src/` and `backend/migrations/`) and surfaced that the table is **not what either Alternative assumed it was**:

- `INSERT ... SELECT FROM generate_series(1, $N)` — N fungible rows per claim batch. Row 7 has no relationship to "the 7th `claim_account` op."
- `SELECT COUNT(*) WHERE used_at IS NULL` — soft availability counter.
- `UPDATE ... WHERE id = (SELECT id FROM account_creation_tokens WHERE used_at IS NULL ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING id` — reservation mutex.
- `used_for` is written but never read in any query.
- No code path joins to a `trx_id` or asks "did claim op X land?"

Re-reading `createClaimedAccount` (`backend/src/account-creation.ts:232-243`) revealed what the lock actually defends: **DB-row-allocation contention** (without `SKIP LOCKED`, two concurrent reservations both read `id = 7` as "lowest unused" — one blocks, the second returns zero rows even though row 8 was free, surfacing a spurious "no tokens available" error). It does NOT defend against chain double-spend. Hive consensus already prevents that — `pending_claimed_accounts` cannot decrement below 0.

That contention is rare at PEvO's beta volume (tens of signups/day) and gracefully handled at any scale by chain consensus rejection. The DB lock is solving a soft-counter throughput problem, not a chain-correctness problem.

This reframed the right answer. The DI-1 / DI-2 / reconcile complexity was paying off a table that the chain rendered redundant. Adopted **Alternative C**: drop the table, read `pending_claimed_accounts` directly from the chain (cached). DI-1 and DI-2 vanish by deletion. Resolution committed in `4b97935`; implementation task at `agents/docs/tasks/pending/backend-account-creation-tokens-drop.md`.

## Guidance

**Rule: when a DB table mirrors, aggregates, or counts on-chain operations, run a five-step audit before designing any reconciliation, idempotency, or drift-fix logic for it. If steps 3 and 4 show the chain already handles the failure mode the table was meant to defend against, the table itself is the problem — drop it instead of fixing it.**

The audit:

1. **List every reference.** `grep -rn` the table name across `backend/src/`, `backend/migrations/`, and tests. Note every read, write, lock, and join. Distinguish queries from raw fields.
2. **Identify the load-bearing query.** Of those references, which one is the table actually justifying its existence by? Most chain-mirror tables have exactly one — a count, a lookup, or a lock. The rest are bookkeeping around that one query.
3. **Ask what failure mode the load-bearing query defends against.** State it concretely: "two simultaneous X without this lock would Y." "Without this counter, we would broadcast Z when the chain has none." Not "data integrity" — be specific about the bad outcome.
4. **Compare to chain consensus guarantees.** Hive's consensus rules already prevent a defined set of bad states: counters can't go negative, accounts can't be created twice, votes can't exceed weight, etc. If the failure mode in step 3 is one Hive consensus already rejects, the DB defense is redundant; the chain will reject the bad write at apply time and the caller can translate that rejection into a retriable error.
5. **Decide.** If the chain handles step 3, drop the table; read the chain primitive directly (cached) on the read path, and let consensus serialize the write path. If the chain does NOT handle step 3, the table earns its keep — proceed with reconcile/idempotency design.

The audit is cheap. The reconcile-design rabbit hole it avoids is not — DI gaps, idempotency keys, cursors, schema migrations, HAF op-query helpers, backfill questions. Each is a fix for the proxy, not a feature.

### What "drop the table" looks like

Concrete shape varies by table, but the substitutions follow a pattern:

| Mirror-table use | Replace with |
|---|---|
| Pre-broadcast capacity check (`SELECT COUNT(*) ...`) | Cached read of the chain primitive (`getAccounts([account]).pending_claimed_accounts`, etc.) |
| Refill threshold trigger | Same cached read |
| Concurrency safety (mutex / SKIP LOCKED) | Chain consensus rejection translated to retriable error response |
| Audit of who-did-what | Chain history (public, indexed by HAF) — drop the private mirror unless a concrete support workflow needs richer signal |

Cache the chain read with a short TTL (5-10s) on hot paths. Invalidate on every successful broadcast that mutates the primitive. Stale reads in either direction are graceful: a stale-low read pre-rejects a signup that would have succeeded (user retries), a stale-high read admits a signup that loses the consensus race (handled by the rejection-translation path).

### When NOT to drop

The audit pattern says drop when the chain handles the failure mode. It does NOT say drop every chain-mirror table. Tables earn their keep when:

- The chain primitive is **expensive to query** (slow consensus reads, high RPC cost) and a denormalized mirror is the cache.
- The mirror **adds dimensions** the chain doesn't have (request timestamps, IP-derived rate-limit context, internal user IDs not on chain).
- The mirror **bridges off-chain context** that consensus can't see (jurisdiction-scoped policy, internal moderation queue).

Each is a load-bearing reason that survives step 3-4 of the audit. The `account_creation_tokens` table had none — the chain primitive (`pending_claimed_accounts`) is fast, single-dimension, and the bookkeeping was internal-only with no consumer.

## Why This Matters

Soft proxies of chain state compound complexity. Each drift-fix is a fix for the proxy, not the system:

- Reconcile path → idempotency keys → cursors → schema migrations → backfill decisions → HAF helper functions → observability for the reconcile path itself. Every step is engineering against the gap between the proxy and the chain.
- Drift is permanent if any reconcile step fails silently. A counter-delta reconcile that under-counts during a parallel-decrement window doesn't recover on the next cycle — the lost rows are gone.
- Each reconcile is a **new place** the system can be wrong. The chain primitive cannot be wrong (it's the canonical view); the proxy can drift, and every fix adds branches that can themselves drift.

PEvO principle #1 ("Hive-native, not Hive-wrapped") is the abstract version of this rule. The audit is the concrete operationalization: how to recognize when a table is wrapping a primitive instead of using it. Without the audit, "Hive-native" is a slogan — easy to violate at design time when the natural reflex is to add a DB table for any tracked thing, and the table is then defended forever because deleting it after the fact requires unwinding all the bookkeeping built on top.

The architect's first-pass refinement to Alternative B in this task is the cautionary case. B closed both DI gaps with a smaller diff than A — locally rational. The audit revealed B was still solving the wrong problem; the table itself was the problem. Without the audit, B ships, the DB stays, drift complexity stays, and the next data-integrity round finds DI-3 / DI-4 on the same table.

## When to Apply

1. **Designing any new DB table that mirrors, sums, counts, or tracks on-chain operations.** Run the audit on the proposed schema before committing the migration. If steps 3-4 show consensus already handles the failure mode, design without the table.
2. **Reviewing reconcile or idempotency tasks** on existing chain-mirror tables. Before approving the implementation, run the audit. If the table doesn't earn its keep, the right task is `drop-table-X`, not `reconcile-table-X`.
3. **Triaging data-integrity findings** (DI-N gaps) on chain-mirror tables. DI gaps are signals that the proxy is drifting from the chain; they often surface tables that should be dropped rather than tightened.
4. **Auditing existing tables** under PEvO principle #1 reviews. Run the audit on each chain-mirror table; document which earn their keep and which are candidates for deletion in a future PR.
5. **Specifically NOT applicable** to: tables with off-chain dimensions (rate-limit state, request-context audit, jurisdiction-scoped policy), caches of expensive chain reads where the cache is the load-bearing reason, or tables that bridge external systems (ORCID linkages indexed for HAF-lag tolerance).

## Examples

### `account_creation_tokens` audit (the case this convention came from)

**Step 1 — references:** schema (`migrations/001_schema.sql:61`, `app-db.ts:93`), insert (`account-creation.ts:100,175`), availability check (`account-creation.ts:200`), reservation (`account-creation.ts:232-243`), release (`account-creation.ts:280`), `used_for` field (written, never read).

**Step 2 — load-bearing query:** the reservation `UPDATE ... FOR UPDATE SKIP LOCKED RETURNING id`. Everything else is bookkeeping around that lock.

**Step 3 — failure mode the lock defends against:** two concurrent `create_claimed_account` reservations both reading `id = 7` as "lowest unused row." Without `SKIP LOCKED`, one blocks; when it unblocks, row 7 is taken so it returns zero rows; user sees "no tokens available" even though row 8 was free. **DB-row-allocation contention.**

**Step 4 — chain consensus comparison:** chain consensus prevents `pending_claimed_accounts < 0`. Two simultaneous `create_claimed_account` ops against a counter of 1 → first lands, decrements to 0; second is rejected at apply time with a counter-insufficient error. **The chain prevents the chain-correctness failure. The DB lock prevents only the spurious "no tokens available" UX, which is rare at beta volume and gracefully handled at scale by translating the consensus rejection into a retriable error.**

**Step 5 — decision:** drop. The chain primitive is fast (single `getAccounts` call), single-dimension (one counter), and `used_for` was never queried so there's no audit value to preserve. Implementation task: `agents/docs/tasks/pending/backend-account-creation-tokens-drop.md`.

### Counter-example — when the table earns its keep

A hypothetical `paper_publish_quotas` table tracking per-user weekly publication limits would NOT pass the audit toward deletion: the limit is off-chain policy (PEvO-defined, not Hive-defined), the chain has no equivalent counter, and consensus does not reject excess publications. Step 3 would name a failure mode (user exceeds weekly quota); step 4 would show the chain doesn't defend against it; step 5 keeps the table. Reconcile / idempotency design would then proceed normally on the table.

The audit is fast precisely because step 3-4 produce a yes/no answer most of the time. Tables that mirror existing chain primitives almost always fail step 4; tables that hold off-chain dimensions almost always pass it.

## Related

- `agents/docs/solutions/conventions/chain-write-timeout-ambiguous-outcome-2026-04-22.md` — **scope-adjacent.** That doc covers response-semantics when a broadcast times out (504 envelope, retriable flag, lock interaction). It presumes a DB write worth coordinating with the broadcast. This doc covers the prior question: does the DB write need to happen at all? When this doc's audit returns "drop the table," that doc's reconcile-design options (A.1-A.4) become moot for that path.
- `CLAUDE.md` (root) — PEvO principle #1: "Hive-native, not Hive-wrapped." This convention is the operational form of that principle for DB schema decisions.
- `agents/docs/tasks/pending/backend-account-creation-tokens-drop.md` — the implementation task that operationalizes the audit's result for `account_creation_tokens`.
- `agents/docs/tasks/review/backend-claim-account-chain-reconcile.md` — the predecessor task whose counter-delta reconcile will be deleted by the drop-table task. A record of the intermediate state where the audit had not yet been run.
- `backend/src/account-creation.ts` — the file the audit walked through; reference example of what "every reference" looks like in practice.
