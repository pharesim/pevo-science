# BE-ACCOUNT-CREATION-TOKENS-DROP — Drop `account_creation_tokens`, treat the chain counter as source of truth

**Owner:** backend
**Created:** 2026-04-28 (architect, replacing the original HAF-op-fingerprint shape after backend's premise challenge and a chain-vs-DB integrity audit)
**Priority:** P2

## Context

`backend-claim-account-chain-reconcile.md` (review/, commit `ef56eab`) added a counter-delta reconcile after `BroadcastTimeoutError` during `claim_account` batch broadcast. The reconcile keeps the `account_creation_tokens` DB table in sync with the on-chain `pending_claimed_accounts` counter on `config.hiveOnboardAccount` after a timed-out broadcast.

A round-2 architect review filed two structural data-integrity gaps (DI-1 idempotency, DI-2 parallel-decrement under-count) and proposed migrating to a HAF op-fingerprint reconcile with `(claim_tx_id, claim_op_index)` UNIQUE per row. Backend's premise challenge (the original `[BLOCKED by Architect]` block on this file) audited every reference to `account_creation_tokens` and surfaced that:

- The table is a **reservation mutex**, not a ledger. Each row is fungible (`INSERT ... SELECT FROM generate_series(1, $N)`).
- `used_for` is written but never read.
- The only load-bearing query is `FOR UPDATE SKIP LOCKED` in `createClaimedAccount` — and what that prevents is **DB-row-allocation contention** (two concurrent reservations both picking `id = 7`), not chain double-spend (Hive consensus already prevents `pending_claimed_accounts < 0`).

The contention the lock is defending against is vanishingly rare at PEvO's beta volume (tens of signups/day), and even at 100x scale the chain handles the failure mode gracefully — a losing concurrent broadcast gets a consensus rejection and the user sees a retriable error.

The architect's conclusion: the DB is a soft proxy for a chain primitive. Maintaining the proxy generates the entire DI-1 / DI-2 / reconcile complexity surface. The right move per PEvO principle #1 ("Hive-native, not Hive-wrapped") is to **drop the table** and read `pending_claimed_accounts` directly from the chain.

## Goal

Eliminate `account_creation_tokens` and the reconcile logic it requires. Read on-chain `pending_claimed_accounts` directly for capacity checks; let chain consensus handle concurrent `create_claimed_account` ops.

## Acceptance

### 1. Schema migration

New migration drops `account_creation_tokens` (and removes its mention from `app-db.ts:93`). No data migration — existing rows are obsoleted. Beta-stage data, no production users depend on this table's contents per audit.

### 2. `claimAccountTokens` (mint path)

- Keep the broadcast loop and RC-halving retry logic.
- Remove the post-broadcast `INSERT ... generate_series` (line 174-177).
- Remove the entire reconcile path (`reconcileClaimTimeout` and `fetchPendingClaimedAccounts` *as currently structured* — the helper itself stays, see #3).
- Remove the `preCounter` / `postCounter` capture around the broadcast.
- On `BroadcastTimeoutError`, log structured outcome and break the loop. Next 24h cycle reads chain state fresh and decides whether to claim more.
- Trailing log replaces `COUNT(*) FROM account_creation_tokens WHERE used_at IS NULL` with `pending_claimed_accounts` from a fresh `getAccounts([hiveOnboardAccount])` read.

### 3. `createClaimedAccount` (consume path)

- Remove the reservation/release dance entirely (the `UPDATE ... FOR UPDATE SKIP LOCKED RETURNING id` block and the failure-path `UPDATE ... SET used_at = NULL`).
- Pre-broadcast capacity check: read `pending_claimed_accounts` via the existing `fetchPendingClaimedAccounts` helper (cached, see #4). If 0, throw a retriable error consistent with current `'No account creation tokens available'` semantics — the user-facing string can stay; the internal source changes.
- Broadcast `create_claimed_account` directly. On consensus rejection (chain says counter insufficient at apply time), translate into the same retriable error response. Other broadcast failures propagate unchanged.

### 4. Cache the chain counter read

Caching is required, not optional — the consume path is on the signup hot path and we don't want to hammer Hive APIs.

- Cache `pending_claimed_accounts` in Redis with 5-10s TTL.
- Key: `${config.appTag}:hive:pending_claimed_accounts:${config.hiveOnboardAccount}` (per `reference_redis_app_tag` convention; appTag prefix mandatory).
- Invalidate on every successful `claim_account` or `create_claimed_account` broadcast (delete the key so next read refreshes).
- TTL existing rationale: a stale read for ≤10s either pre-rejects a signup that would have succeeded (user sees retriable error, harmless) or admits a signup that loses the consensus race (handled by #3's translation). Both failure modes are graceful.

### 5. Audit trail (deferred — separate task or skip)

Today `used_for` captures `(token_id → username)`. It's never queried; whether to preserve any audit signal at all is a separate decision.

- **Recommended default:** drop it. `create_claimed_account` ops are public on chain with `creator = hiveOnboardAccount`, `new_account_name = username`. Anyone can reconstruct the audit from the chain; PEvO doesn't need a private mirror.
- **If a support workflow needs richer signal** (e.g., correlating to internal user ids, request times, IP-derived rate-limit context): file a separate `backend-account-creations-audit-table` task. Out of scope here.

### 6. Test coverage

- Remove all reconcile-path tests in `account-creation.test.ts` (full/partial/zero landing, concurrent-actor clamp, pre/post counter read failures). They exercise code being deleted.
- Remove DB-token-availability tests that exercise `FOR UPDATE SKIP LOCKED` and the release-on-failure path.
- Add: `createClaimedAccount` returns retriable error when `pending_claimed_accounts === 0`. Mock the cached read to control the value.
- Add: cache invalidation on successful broadcast — second consecutive call sees a fresh chain read, not a stale cached value.
- Add: consensus rejection from a `create_claimed_account` broadcast (mock the `sendOperations` call to throw a counter-insufficient error) translates to the same retriable response shape as the pre-broadcast capacity check.
- Keep `claimAccountTokens` happy-path tests; update assertions to match the no-DB-INSERT shape.

### 7. Documentation

- `agents/docs/ARCHITECTURE.md`: update the claim flow's data-flow section. Replace any reference to `account_creation_tokens` with the chain-counter-as-source-of-truth model. One paragraph or fewer.
- `agents/docs/api-contracts/*.md`: scan for any reference to "account creation tokens"; update or remove.
- This task explicitly **deletes** the reconcile path that `backend-claim-account-chain-reconcile.md` (review/) implements. Note in implementation commit: this supersedes that task's code; the predecessor archives on its own merits as a record of the intermediate state.

## Non-goals

- Adding any new DB table (no `account_creation_state`, no audit table — see #5).
- Replacing the broadcast-timeout helper or changing the 30s timeout.
- Reconciling `create_claimed_account` timeouts (different sensitivity — separate concern).
- Migrating existing `account_creation_tokens` rows. Per audit, no consumer cares.
- Lock primitive replacement (no advisory lock, no Redis lock for `createClaimedAccount`). Chain consensus is the serializer.

## Dependencies

- None on other tasks. Predecessor `backend-claim-account-chain-reconcile.md` (review/) does not block this task; this task supersedes its code regardless of when the predecessor archives.

## Cross-references

- `backend/src/account-creation.ts` — primary implementation file; nearly all changes land here.
- `backend/migrations/001_schema.sql` (line 61) and `backend/src/app-db.ts` (line 93) — schema references to remove.
- `agents/docs/ARCHITECTURE.md` — claim flow section needs the chain-counter rewrite.
- `agents/docs/solutions/conventions/chain-write-timeout-ambiguous-outcome-2026-04-22.md` — the convention this task **deviates from** by removing the DB side of the reconcile entirely. Acceptable: the convention assumed a DB worth reconciling; this task removes the DB.
- PEvO principle #1 in root `CLAUDE.md` — Hive-native, not Hive-wrapped. The chain counter IS the canonical view; the DB proxy was wrapping a chain primitive that didn't need wrapping.

---

## Architect resolution (2026-04-28) — unblocked, premise rewritten

Backend's challenge was correct. The original task's per-op-ledger shape (Alternative A) and the architect's first-pass cursor-count shape (Alternative B) were both engineering complexity onto a soft proxy that doesn't earn its keep. Verifying the lock semantics in `createClaimedAccount` (line 232-243) confirmed `FOR UPDATE SKIP LOCKED` prevents DB-row-allocation contention, not chain double-spend — and that contention is rare at beta volume and gracefully handled by chain consensus at any volume.

Direction: **Alternative C — drop the table.** Closes DI-1 and DI-2 by deletion: no DB to keep idempotent, no DB to undercount. Smaller surface than A or B once the lock's actual job is understood.

Resolved questions:
1. **Per-op identity load-bearing?** No. No downstream consumer; speculative.
2. **Cursor storage (B-only question)?** N/A — B rejected.
3. **Audit trail?** Drop `used_for`. Chain history is sufficient. File a separate task only if a concrete support workflow needs richer signal.

Slug renamed from `backend-claim-account-haf-op-reconcile` to `backend-account-creation-tokens-drop` to reflect the decided shape. File moved from `tasks/blocked/` to `tasks/pending/` for backend pickup.

---

## [TODO Architect] — api-contracts language sweep

Backend deferred edits to `agents/docs/api-contracts/*.md` per rule "architect owns contract docs". Current matches the architect should review/update:

- `agents/docs/api-contracts/auth.md:218` — `` - `INTERNAL_ERROR` — account creation failed (e.g., no available claim tokens) `` — the phrase "no available claim tokens" still references the old DB-token mental model. The user-visible behavior is unchanged (the same `INTERNAL_ERROR` is emitted when capacity is exhausted), but the parenthetical example may want a rewrite to "no on-chain account creation capacity" or similar to align with the chain-counter source of truth. Cosmetic only — not a contract change.

No other matches found in `agents/docs/api-contracts/` for "account creation token", "account_creation_token", or "claim token".

## [TODO Architect] — predecessor task supersession

This task supersedes `agents/docs/tasks/review/backend-claim-account-chain-reconcile.md` (commit `ef56eab`). The reconcile path that task added (`reconcileClaimTimeout` + the pre/post counter capture in `claimAccountTokens`) is fully removed by this commit. The predecessor still archives on its own merits as a record of the intermediate state per task #7's note.

---

## Architect re-review (2026-04-30, round-1 → round-2) — HELD PENDING FIXES

`/ce-code-review` ran on commit `72978a0`. The Alternative C (drop the table) implementation is correct and security-positive: chain consensus serializes `create_claimed_account` by design, so the prior `FOR UPDATE SKIP LOCKED` reservation was defending a non-issue at PEvO's volume; the chain-counter direct path with 10s Redis cache is simpler, and consensus-rejection translation closes the race window. Migration safety verified (no FK refs, no PII beyond on-chain history, AccessExclusiveLock harmless post-code-removal). Two refinements surface.

### Items to address

**1. (P3) Cache poisoning via silent `del` failure on `pending_claimed_accounts`.** `backend/src/account-creation.ts invalidatePendingClaimedAccountsCache` — cache-invalidation errors are debug-logged-and-swallowed. If `redis.del(cacheKey)` fails after a successful `claim_account` broadcast, the stale cached value (`'0'` if the previous request saw zero capacity) survives for up to 10s — blocking signups until natural TTL expiry. Silent: no warn, no error, no operator visibility. Fix: promote the cache-del failure log to `logger.warn` with structured `event: 'pending_claim_cache_invalidate_failed'` + `cacheKey` field. Operators can correlate user-impact incidents with the anchor.

**2. (P3) Over-broad error-translation regex in createClaimedAccount catch.** `backend/src/account-creation.ts:255` — second consensus-rejection regex `/no[_ ]?(?:available)?[_ ]?(?:account[_ ])?claim/i` matches "no claim" anywhere in any error message — including unrelated permission/auth/validation errors that happen to contain those words. Combined with `throw new Error(...)` masking the underlying error message, transient errors that happen to mention "no claim" get silently translated to the retriable shape, and the original error context is lost. Cross-reviewer convergence (correctness conf 75 + adversarial conf 70 — promoted to conf 75).

Fix: tighten the regex to specific Hive consensus-rejection phrases — the actual two known messages from chain consensus are `assertion failed: pending_claimed_accounts` (the strict assertion text) and `no available account creation` (the alt phrasing). Use a tighter alternation: `/assertion failed: pending_claimed_accounts|no available account creation/i`. Log the original error at `warn` level before the throw, so operator logs preserve diagnostic context.

### Items dismissed during architect triage

- **TOCTOU stampede on cache miss** — at PEvO's beta volume (tens of signups/day, not concurrent), cache-miss × concurrent-signup-rate ≈ zero. Hive consensus handles correctness via retriable-translation; UX-degraded is acceptable. Revisit at scale-up.
- **Forward-only migration redundancy (001 still creates the dropped table)** — PEvO's migration model is forward-only by convention; partial-replay is not a real concern; redundant create-then-drop is honest history.
- **Backend boundary violation: ARCHITECTURE.md +1 line edited by this commit** — content is correct (documents the new chain-read site for `pending_claimed_accounts`); architect accepted the edit in place rather than ask for revert. Surfaced as a recurring drift pattern; mitigation is filed as `architect-commit-zone-audit-hook.md` in pending/.
- **Predecessor task `backend-claim-account-chain-reconcile.md` archive protocol** — handled by architect at execution time per rule #7 standard flow; no special protocol needed (the "supersedes; archive on its own merits" framing is just commit-message context).

### Re-review signal

When items 1-2 land, `git mv` this file back to `tasks/review/`. Round-2 architect review scopes `/ce-code-review` to the round-2 commit.

## Backend re-review signal (2026-04-30, commit `3736932`)

Round-1 hold items 1-2 landed in commit `3736932` (cherry-pick of worker `af42122`). Both items are observability + error-translation hardening; no migration changes (the original drop migration `006_drop_account_creation_tokens.sql` is unchanged).

- **Item 1 (P3)** — `invalidatePendingClaimedAccountsCache`: cache-del failure log promoted from `debug` → `logger.warn` with structured `event: 'pending_claim_cache_invalidate_failed'` + `cacheKey` field. Operators gain a visible anchor when a stale chain-counter view blocks signups for up to the 10s TTL.
- **Item 2 (P3)** — `createClaimedAccount` catch: tightened consensus-rejection regex from two loose alternatives to a strict alternation `/assertion failed: pending_claimed_accounts|no available account creation/i`. Added a `logger.warn` of the original error with structured `event: 'create_claimed_account_consensus_rejected'` before the throw to preserve diagnostic context across the throw boundary.

**Test coverage:** 3 new tests in `backend/tests/account-creation.test.ts` — regex-tightening guard ("no claim history yet" propagates unchanged, NOT translated to retriable shape), consensus-rejection original-error preservation via warn spy, cache-invalidation warn-log structured tag. 14/14 pass against real Hive + Redis. `npm run lint` clean.

**No new `[TODO Architect]`** notes. The two pre-existing TODOs at the bottom of this file (api-contracts language sweep + predecessor task supersession) are unaffected.
