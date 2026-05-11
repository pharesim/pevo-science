# BE-ACCOUNT-CREATION-LOGGER-SPY-REAL-PATH-COMPANION — Real-path companion test for the two `account-creation` warn-log assertions

**Owner:** backend
**Created:** 2026-05-11 (architect, filed during round-2 re-review of `backend-account-creation-tokens-drop` to satisfy the mock-test carve-out's criterion (c) for two new logger-spy tests)
**Priority:** P3

## Context

Round-2 of `backend-account-creation-tokens-drop` (commit `3736932`) added two `logger.warn` calls in `backend/src/account-creation.ts`:

- `pending_claim_cache_invalidate_failed` — emitted from `invalidatePendingClaimedAccountsCache` catch when `redis.del` rejects.
- `create_claimed_account_consensus_rejected` — emitted from `createClaimedAccount` catch when the chain-consensus-rejection regex matches.

Each warn-log is exercised by a dedicated unit test using `vi.spyOn(logger, 'warn')` with `redisGetMock` / `sendOperationsMock` / `redisDelMock` mocks. The mocks are necessary for deterministic error injection — the carve-out's criterion (a) (test file header documents the justification) is satisfied for these tests under the existing header in `backend/tests/account-creation.test.ts`.

Project-standards review of round-2 (PSR-001, conf 75) flagged that the carve-out's **criterion (c)** is unmet for these two specific risk classes:

> "The same risk class is covered by a real-path test elsewhere, OR a follow-up task is filed to add such coverage."

For the consensus-rejection warn assertion, the risk class is "diagnostic context lost at the consensus-rejection throw boundary." For the cache-del warn assertion, the risk class is "cache-invalidation failure log missing structured tag." Neither has a real-infrastructure companion (the sibling "translates a consensus-rejection error" test in the same file uses the same mocked infrastructure, not real infra).

The carve-out explicitly allows filing a follow-up task as the alternative to authoring a real-path companion test inline. This task is that filing. **Filing this task itself satisfies clause (c) for round-2.** The work itself can be deferred or dismissed on its own merits once we have a clearer picture of how to stage the real paths.

## Goal

Add real-infrastructure companion tests for the two new warn-log risk classes, OR formally dismiss the gap with a documented rationale.

## Acceptance

### 1. Real-path companion for `pending_claim_cache_invalidate_failed`

Add a test in `backend/tests/account-creation.test.ts` (or a sibling file) that uses real Redis and triggers a `redis.del` failure naturally — e.g., by closing the Redis connection before invoking `invalidatePendingClaimedAccountsCache` (or via a real network partition simulation if the test harness supports it), then asserts that:

- The warn-log fires with the documented structured shape (`event` field matches the renamed slug per item #4 in the round-2 hold; `cacheKey` field present; `err` field carries an Error instance).
- The caller (whichever test triggers this path) does NOT crash or block — the warn-log is observability-only and the surrounding flow continues to its return.

If staging a real Redis-del-failure is impractical (the harness only supports happy-path Redis), the alternative is acceptance #3.

### 2. Real-path companion for `create_claimed_account_consensus_rejected`

Add a test that exercises a real `sendOperations` consensus rejection — typically by submitting a `create_claimed_account` op against a Hive testnet/local node where `pending_claimed_accounts` is genuinely zero, OR by configuring the test harness to issue a real broadcast against a known-rejecting node fixture.

Assert:

- The warn-log fires with the documented structured shape (`event` matches the renamed slug; `err` carries the real chain RPCError).
- The caller surfaces the retriable `'No account creation tokens available'` translation, identical to the mocked-path coverage.

If real Hive consensus rejection cannot be staged deterministically per test (most likely — Hive testnet state is hard to pin), the alternative is acceptance #3.

### 3. Dismissal alternative (if real-path is impractical)

If the implementer's audit concludes that neither warn-log risk class can be exercised through real infrastructure within reasonable test-harness complexity, document the dismissal in `agents/docs/solutions/conventions/` via `/ce-compound`. The dismissal note should:

- Cite the two risk classes by name.
- Explain why real-path coverage is impractical (e.g., "Hive testnet rejection states are non-deterministic"; "Redis del-failure simulation requires harness changes that exceed the value of pinning these specific log emissions").
- Argue that the mocked tests' mutation-kill coverage is sufficient for these specific risk classes (the mutations they would catch — drops `err`, drops `event`, drops `cacheKey`, swaps log level — are caught by the existing spy assertions plus the round-3 fixes from the parent task).
- Be cross-referenced from this task file's archive entry so the carve-out audit trail is intact.

This is a legitimate outcome. The carve-out's intent is to prevent silent mock-by-default drift; an explicit, reasoned dismissal preserves the audit signal.

## Non-goals

- Replacing the mocked tests. They mutation-kill the log-shape contract at the call site and should stay.
- Restructuring `account-creation.ts` to make the log-emission paths easier to test in isolation. The warn-logs are operator observability — they should remain where they are.
- Extending the real-path investigation to other logger-spy tests in the codebase. This task is scoped to the two warn-logs added in round-2 of `backend-account-creation-tokens-drop`. A broader audit is a separate task if it becomes warranted.

## Dependencies

- Round-3 of `backend-account-creation-tokens-drop` must land first — the event slugs are being renamed in that round (`pending_claim_cache_invalidate_failed` → `account_creation.cache.invalidate_failed`; `create_claimed_account_consensus_rejected` → `account_creation.broadcast.consensus_rejected`). Real-path tests added before round-3 lands would assert against the old slugs and need a rewrite when round-3 commits.

## Cross-references

- `agents/docs/tasks/pending/backend-account-creation-tokens-drop.md` — parent task; round-2 hold block (items 1-4) lands the events that this follow-up validates.
- `/home/micha/workspace/pevo/CLAUDE.md` "Running Tests" section, carve-out clauses (a)-(c) — the standard this task closes.
- `backend/tests/account-creation.test.ts` — file header documents criterion (a) for the existing mocked tests; this task addresses criterion (c).
