---
title: Real-path companion dismissal — when reasoned dismissal satisfies carve-out clause (c)
date: 2026-05-11
category: conventions
module: backend/tests
problem_type: convention
component: testing_framework
severity: medium
applies_when:
  - "Auditing a logger-spy or observability-spy test that mocks a shared helper (`getRedis()`, `getPool()`, etc.) and clause (c) compliance is in question"
  - "Evaluating whether a real-path companion test would catch a meaningfully different mutation class than the mocked test already does"
  - "The underlying failure source is non-deterministic third-party state (Hive consensus, network rejection) or shared-helper infrastructure (Redis, Postgres pools)"
  - "A follow-up task was filed for clause (c) compliance and the implementer is deciding between authoring a real-path test or dismissing with rationale"
tags:
  - test-mocks
  - carve-out
  - real-path
  - risk-class
  - dismissal
  - logger-spy
  - account-creation
  - hive-consensus
related_components:
  - authentication
  - database
---

# Real-path companion dismissal — when reasoned dismissal satisfies carve-out clause (c)

## Context

Root `CLAUDE.md` "Running Tests" carve-out clause (c) requires that any mocked test be backed by either a real-path companion that catches the same risk class, OR a follow-up task filed to add such coverage. The follow-up task is a deferral, not a guarantee — once filed, the implementer must still decide whether to author the real-path test or close the task with a reasoned dismissal.

`agents/docs/solutions/conventions/test-mock-carve-out-clause-c-2026-05-04.md` settles the literal-mirror-vs-risk-class question (risk-class wins) and lists carve-out-eligible mock targets (shared helpers, third-party libs, observability surfaces). It does not address the dismissal half of the alternative. Two warn-log emissions added during `backend-account-creation-tokens-drop` round-2/3 (`account_creation.cache.invalidate_failed` and `account_creation.broadcast.consensus_rejected` in `backend/src/account-creation.ts`) surfaced the gap: their follow-up task (`backend-account-creation-logger-spy-real-path-companion`) audited whether real-path companions were warranted and concluded both should be dismissed. This doc captures the criteria so future audits reach consistent conclusions instead of re-deriving the analysis or defaulting to "always add the real-path test" out of conservatism.

## Guidance

A reasoned dismissal satisfies clause (c) when **both** of these are true for the specific risk class under audit:

1. **The mocked test already mutation-kills the risk class.** Field-shape, log-level, ordering, and event-slug-literal mutations are caught by `expect.objectContaining({ ... })` on a `vi.spyOn(logger, 'warn')` call. The "function doesn't crash on observability-emit failure" property is implicitly killed by the surrounding caller's `await` resolving normally.

2. **A real-path companion would add only marginal mutation-class coverage AND the marginal value does not justify the test-infrastructure cost.** The two recurring marginal-value patterns:

   - **Shared-helper-error-shape drift** (e.g., "real ioredis closed-client rejection produces an `Error` instance"). The mocked matcher already pins `err: expect.any(Error)`, so the real-path catches only ioredis-specific subclass shape — not load-bearing at PEvO's beta scale.
   - **Non-deterministic third-party state** (e.g., Hive consensus rejection requires `pending_claimed_accounts == 0` which cannot be pinned per-test on a real Hive node). The chain-side string contract is encoded in the regex; production behavior under `startAccountClaimer` against the real chain provides implicit live coverage; chain-side drift surfaces as a missing log entry (graceful, catch-all `throw err` is equally graceful) rather than a behavioral failure.

When dismissing, the dismissal note must:

- Cite the specific risk class(es) being dismissed by name.
- Enumerate the mutation classes the existing mocked test kills (field shape, log level, slug literal, ordering).
- Explain which marginal mutation class a real-path companion would uniquely catch.
- Argue why that marginal coverage does not justify the infrastructure cost (per-test fixture overhead, file-level mock bypass complexity, deterministic-state-pinning difficulty).
- Cross-reference the carve-out's definitional doc and the originating task file so the audit trail is reconstructable.

Dismissal lives in `agents/docs/solutions/conventions/` (this category), filed via `/ce-compound`. The task file then `git mv`s from `pending/` to `review/` with a backend re-review signal block citing the dismissal doc.

## Why This Matters

The carve-out's intent is "prevent silent mock-by-default drift," not "force real-path tests for every mocked surface regardless of yield." The strict reading — every mocked test must have a real-path companion that asserts something — was already dismissed by the clause (c) doc as relitigation. The complementary strict reading — when a follow-up task is filed, the implementer must author a real-path test rather than dismiss — would create the same drift in a different direction: real-path tests authored from obligation rather than risk-class delta accumulate as test-suite overhead without catching new mutations.

A reasoned dismissal preserves the audit signal three ways:

1. **The originating task file** transitions through review → archive with the dismissal cited as the deliverable. Future archive readers see "this carve-out gap was evaluated and dismissed for cause X" rather than "this gap was never closed."
2. **This solutions doc** indexes the dismissal under `applies_when` conditions that future implementers will hit when auditing similar mocked-spy tests.
3. **The mocked test's file header** can reference the dismissal doc when it invokes the carve-out framework, so a reviewer running `/ce-code-review` on the test file sees the closure inline.

Without explicit dismissal criteria, every future logger-spy test reopens the audit from scratch, and reviewers (human and persona) default to "file a follow-up task" → "add a real-path test" → marginal real-path coverage accumulates indefinitely.

## When to Apply

- After implementing a logger-spy or observability-spy test under the carve-out framework, when the architect's hold-block or `/ce-code-review` finding flags a clause (c) gap and requests a follow-up task.
- When that follow-up task surfaces for implementation, and the audit concludes that the real-path companion would only marginally extend mutation-kill coverage.
- When reviewing a mocked-spy test for clause (c) compliance and asking "is the existing mocked test sufficient, or does a real-path test catch something it can't?"

Do NOT apply when:

- The mocked test does NOT fully mutation-kill the field shape, log level, slug literal, or ordering — fix the mocked test before considering dismissal.
- The risk class involves a behavioral failure mode (cross-layer interaction, callback chain, error-strategy alignment) rather than an observability emission — those need integration tests with real infrastructure, not dismissal.
- A real-path companion is straightforward (e.g., the carve-out-eligible mock target is bypassable per-test via `vi.doMock` and the underlying infrastructure is already running for the suite). Cost-of-real-path is a load-bearing dismissal criterion; when the cost is low, real-path wins.

## Examples

**Dismissed (BE-ACCOUNT-CREATION-TOKENS-DROP round-2/3 warn-logs):**

`backend/src/account-creation.ts` emits two warn-logs added during round-2 hold-fix (commit `3736932`) and slug-renamed in round-3:

- `account_creation.cache.invalidate_failed` — fires from `invalidatePendingClaimedAccountsCache` catch when `redis.del` rejects. The helper is called from both `claimAccountTokens` (post-claim) and `createClaimedAccount` (post-consume); both call-site stale-cache failure modes are documented in the source-level comment.
- `account_creation.broadcast.consensus_rejected` — fires from `createClaimedAccount` catch immediately before translating a chain consensus rejection (matched by `/assertion failed: pending_claimed_accounts|no available account creation/i`) into the retriable `'No account creation tokens available'` shape.

Existing mocked-spy coverage in `backend/tests/account-creation.test.ts` pins:

- `cacheKey` literal, `event` slug literal, `err: expect.any(Error)`, `warn` log level (cache-del site).
- `event` slug literal, `err: consensusErr` original reference, `warn` log level, `warn`-BEFORE-`throw` ordering pinned by spy-was-called assertion (a mutation moving `warn` after the subsequent `throw` would suppress the call entirely, failing the spy check; no explicit `mock.invocationCallOrder` assertion is required), both regex arms positively covered for the throw-translation behavior with the warn-log assertion landing on arm 1 (source structure places `warn` outside any arm-specific branch, so a single positive assertion plus the negative-pin guard kills the slug+level+err mutations on both arms), negative-pin guard against the over-broad pre-tightening regex (consensus-rejection site).

Real-path companion analysis:

- **Cache-del real path:** the file-level `vi.mock('../src/redis.js')` mock would need bypass via a sibling test file with real ioredis lifecycle management (connect → close → call invalidate → assert warn-log → reconnect). Marginal mutation class caught: real-ioredis closed-client `Error` subclass shape. The mocked matcher already pins `err: expect.any(Error)`; the subclass differential is not load-bearing at PEvO's single-instance beta scale. The "function doesn't crash on del failure" property is killed implicitly by the existing mocked test (the consume-path `await createClaimedAccount(...)` must resolve normally for the test to pass).
- **Consensus-rejection real path:** real Hive consensus rejection requires `pending_claimed_accounts == 0` on a test node, which is non-deterministic — testnet state cannot be pinned per-test. Production `startAccountClaimer` running against real chain provides implicit live coverage; if the chain ever rejects with an unexpected error-string shape, operator logs will show the un-translated error and the regex can be updated. The catch-all `throw err` path is just as graceful as the translated retriable shape, so a missing log entry is the only behavioral consequence of chain-side drift.

Both dismissed; criteria above are satisfied.

**Not dismissable (hypothetical):**

A logger-spy test pinning `event: 'rate_limit.exceeded'` on `vi.spyOn(logger, 'warn')` where the real-path companion would exercise `EVAL` script execution against real Redis. The script-execution branch has behavioral mutations (e.g., `EVALSHA` cache-miss fallback, atomic-increment semantics under contention) that the mocked test cannot catch. Real-path companion is not just shape-drift — it covers a different mutation class. Author it; do not dismiss.

## Related

- `agents/docs/solutions/conventions/test-mock-carve-out-clause-c-2026-05-04.md` — definitional doc for clause (c) risk-class equivalence; lists carve-out-eligible mock targets. This doc complements that one by documenting the dismissal half of the "real-path OR follow-up task" alternative.
- `agents/docs/solutions/conventions/mock-guard-assertion-must-verify-call-shape-2026-04-21.md` — when the mocked test under audit uses a `mockImplementation` predicate guard, the in-mock assertion shape must hold up under the fallback path; verify before considering dismissal.
- `agents/docs/solutions/conventions/auth-structured-log-shape-2026-04-29.md` — structured log shape conventions used by the warn-logs that triggered this dismissal (event-slug naming, field set, log-level discipline).
- `agents/docs/tasks-archive.md` under `BACKEND-ACCOUNT-CREATION-LOGGER-SPY-REAL-PATH-COMPANION` (archived 2026-05-15 by this dismissal) — the originating task. Per `CLAUDE.md` rule #7 the per-task file is `git rm`'d at archive and only the archive entry survives; the 250-line trim will eventually evict the entry, after which git history (commits up to and including the dismissal commit) is the audit-trail of record.
- Parent task `BACKEND-ACCOUNT-CREATION-TOKENS-DROP` — round-2/3 hold-fixes at commit `3736932` (slug-renamed in round-3) added the two warn-logs and triggered the clause (c) gap audit. Currently in `agents/docs/tasks/review/`; will archive separately.
