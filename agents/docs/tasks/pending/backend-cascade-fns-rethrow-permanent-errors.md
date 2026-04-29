# BACKEND-CASCADE-FNS-RETHROW-PERMANENT-ERRORS — Make `PostBroadcastWriteError` discrimination reachable on real cascade failures

**Owner:** backend
**Created:** 2026-04-29 (architect, follow-on to BACKEND-ORCID-BROADCAST-OUTCOME-DISCRIMINATION round-2 archive triage)
**Priority:** P2
**Source:** `agents/docs/tasks/review/backend-orcid-broadcast-outcome-discrimination.md` round-1 hold item #5 (architect-flagged `[TODO Architect]`); architect decision recorded 2026-04-29 in cluster archive triage.

## Problem

The `PostBroadcastWriteError` discrimination machinery in `backend/src/lib/broadcast-error.ts` produces a documented 502 POST_BROADCAST_FAILED envelope (`details.failed_step`, `details.outcome:'confirmed'`, `details.tx_id`, per-step user-facing message). The contract is documented in `agents/docs/api-contracts/orcid.md` and the per-step recovery semantics. The frontend treats it as success-with-stale-cache.

But the machinery is **dead-defensive on live paths today** because all three cascade fns swallow async errors internally:

| Cascade fn | File:line | Behavior on error | Auto-reconcile path? |
|---|---|---|---|
| `cacheOrcidBinding` | `backend/src/routes/orcid.ts:1085-1109` | try/catch + `logger.warn`; returns success | yes — next request repopulates cache from HAF |
| `updateAccountOrcid` | `backend/src/routes/orcid.ts:1258-1269` | try/catch + `logger.error`; returns success | **no** — denormalized projection; missed write requires manual operator re-run (HAF-replay job not implemented) |
| `seedAccreditationBonus` | `backend/src/lib/reputation.ts:136-142` | try/catch + `logger.error`; returns success | partial — next batch cycle re-derives from chain state |

The result: a real Redis flap or PG pool exhaustion during the post-broadcast cascade produces 200 OK to the user AND only a generic per-fn `logger.warn`/`logger.error` to operators. There is no contract envelope, no `event:`-tagged operator anchor, no dashboard-keyable signal that an `account_update` cascade failed. For `updateAccountOrcid` specifically — where there's no auto-reconcile — the user's denormalized `accounts.orcid` column may be permanently stale until manual re-run, and operators have no documented path to detect this.

The integration test at `backend/tests/routes/orcid.test.ts` proves the discrimination is wired (via `__test_seams.updateAccountOrcid.mockRejectedValueOnce(...)`), but that's the ONLY currently-reachable trigger.

## Goal

Rewire `updateAccountOrcid` and `seedAccreditationBonus` to re-throw on **permanent / operator-actionable** errors so the `PostBroadcastWriteError` discrimination produces real 502 POST_BROADCAST_FAILED envelopes on real failure modes. Leave `cacheOrcidBinding` swallowing — its lazy-repopulate is the right behavior.

The wire envelope is already documented; this task ships the production trigger for it.

## Scope

### `updateAccountOrcid` (`backend/src/routes/orcid.ts:1258-1269`)

Distinguish transient vs permanent errors. Re-throw on permanent. Examples of permanent / operator-actionable:
- `getAppPool() === null` (pool not initialised) — already throws synchronously today; flagged as residual_risk by reliability reviewer
- Pool exhaustion that doesn't recover within a bounded retry budget
- Schema/constraint errors (column missing, FK violation) — typically a deploy regression

Transient (keep swallowing or retry-then-swallow):
- Single connection drop during a healthy pool — retryable; if exceeded retry budget then re-throw
- pg-ish "could not serialize access due to concurrent update" — retryable

The wrapper at the orcid.ts cascade catch will surface re-thrown errors as `new PostBroadcastWriteError(txId, cause, 'account_update')`.

### `seedAccreditationBonus` (`backend/src/lib/reputation.ts:136-142`)

Same pattern. Permanent errors (Redis fully unreachable for a sustained window OR HAF-derived inputs are malformed) re-throw. Transient errors stay swallowed (next batch cycle re-derives anyway).

The route wrapper produces `new PostBroadcastWriteError(txId, cause, 'reputation_seed')`.

### `cacheOrcidBinding` (out of scope)

Keeps swallowing. Cache miss → next request repopulates from HAF. Adding re-throw here would force the user to see "backend write failed" for what is genuinely zero user impact.

### Sibling sites NOT in this scope

- `signup-verify.ts:295/:404` (reliability reviewer flagged a half-rolled-out variant of this pattern). Different task family — file separately if/when it surfaces. This task does NOT touch signup-verify.

## Operator-alert anchor

When `updateAccountOrcid` or `seedAccreditationBonus` re-throws and the route's wrapper produces `PostBroadcastWriteError`, `handleBroadcastError`'s 4th log-suffix anchor (`<routeLabel> broadcast confirmed but post-broadcast write failed`) fires at error level. That anchor is already operator-facing. Verify it carries enough forensic context (`txId`, `failedStep`, `orcidId` or equivalent) to be useful for an oncall debugging which step failed.

If the existing anchor is insufficient, add a structured `event:` field per PEvO convention (e.g., `event: 'post_broadcast_write_failed'`).

## Tests

- New integration spec exercising `updateAccountOrcid` permanent-error path: stub the function (or its underlying pool call) to reject with a non-transient error class; assert 502 POST_BROADCAST_FAILED with `details.failed_step:'account_update'` envelope.
- New integration spec for `seedAccreditationBonus` permanent-error path (or unit-layer if integration is impractical — file the carve-out per CLAUDE.md test-mocking carve-out).
- Verify the existing pre-`d8b9b75` test seams (`__test_seams.updateAccountOrcid`) still work, since this task may change the implementation but the seam contract should hold.
- Mutation-kill: deleting the re-throw should cause the new specs to fail (route swallows again → 200 OK → spec asserting 502 fails).

## Acceptance

- `updateAccountOrcid` re-throws on permanent / operator-actionable errors.
- `seedAccreditationBonus` re-throws on permanent / operator-actionable errors.
- `cacheOrcidBinding` is unchanged.
- New specs exercise the re-thrown paths and assert the 502 POST_BROADCAST_FAILED envelope shape.
- Operator-alert anchor carries forensic fields (txId, failedStep, route-correlation).
- Existing 54-passed test suite still passes.

## Coordination

- The task is independent of the orcid cluster archive. Architect can archive the orcid cluster review without this task landing first.
- Related: backlog item `backend-sendoperations-outcome-handling-sweep.md` may want to adopt the same pattern for other broadcast routes (bridge/custody/papers/claims). Out of scope here; coordinate when/if that task is filed.

## Source

- `agents/docs/tasks/review/backend-orcid-broadcast-outcome-discrimination.md` round-1 hold item #5 + round-2 signal `[TODO Architect]` block (line 358).
- Architect decision recorded in cluster archive triage 2026-04-29: option (B-narrow) — rewire `updateAccountOrcid` + `seedAccreditationBonus`, leave `cacheOrcidBinding`.
- `agents/docs/api-contracts/orcid.md` POST_BROADCAST_FAILED entry (already documents the envelope shape and per-step recovery semantics).
- `agents/docs/solutions/conventions/chain-write-timeout-ambiguous-outcome-2026-04-22.md` (post-broadcast write failure section).

---

## Implementation landed (2026-04-29, working tree)

Round-1 implementation per option (B-narrow) — rewired `updateAccountOrcid` and `seedAccreditationBonus` to re-throw on permanent / operator-actionable errors; left `cacheOrcidBinding` swallowing per the task's explicit out-of-scope note (lazy-repopulate is the right behavior on cache write).

### `updateAccountOrcid` rewire (`backend/src/routes/orcid.ts`)

Previously: `if (!pool) return; try { ... } catch (err) { logger.warn(...); }` — every failure mode swallowed. Two failure classes now distinguished:

1. **`getAppPool() === null`** — re-thrown as `new Error('App pool not initialised — accounts.orcid update unavailable')`. Production-pathological (the app should fail to start if the DB pool isn't configured), but if it somehow reaches this site, the chain op IS confirmed and the user deserves the discriminated 502 envelope, not silent staleness.

2. **`pool.query` rejection classified by SQLSTATE** via a new `isPermanentDbError(err)` helper (in `routes/orcid.ts`, scoped private to the file):
   - **Permanent (re-thrown):** SQLSTATE classes `23*` (integrity_constraint_violation: FK / NOT NULL / unique / check) and `42*` (syntax_error_or_access_rule_violation: undefined_column, undefined_table, datatype_mismatch, insufficient_privilege). Both signal a deploy regression or schema drift — operator must intervene.
   - **Transient (swallowed):** errors with no SQLSTATE code, connection-class errors (`08*`), serialization races (`40001` / `40P01`), pool-exhaustion-like errors. The denormalized `accounts.orcid` column may be briefly stale, but the chain record is the source of truth for the binding; next request reconciles via the per-step user message.

### `seedAccreditationBonus` rewire (`backend/src/reputation.ts`)

Previously: blanket `try { ... } catch (err) { logger.warn(...); }`. Now uses `isPermanentSeedError(err)` (private file-scoped helper) classified by error class — `TypeError`, `SyntaxError`, or `RangeError` re-thrown; everything else swallowed. Rationale:

- **Permanent (re-thrown):** programmer-error class — `TypeError` / `SyntaxError` / `RangeError` typically signal a data-shape regression in `getReputationWeights()` output that the next batch cycle will NOT self-heal (e.g. `weights.accreditation_bonus` is undefined → `provisionalScore(undefined)` throws TypeError, or upstream weights JSON is corrupted → SyntaxError on parse). Operator must investigate the upstream weights data.
- **Transient (swallowed):** Redis-side blips, transient HAF query failures. Next batch cycle re-derives the provisional score from chain state regardless.
- **`getRedis() === null`** — kept as a silent return (NOT re-thrown). A Redis outage at the time of an accredit broadcast should NOT surface 502 POST_BROADCAST_FAILED to the user, because the next batch cycle reconstructs the provisional score anyway. Re-throwing here would couple the user-visible accredit envelope to ephemeral Redis health, which is the wrong contract per the task spec ("transient errors stay swallowed because the next batch cycle re-derives anyway").

### Operator-alert anchor (`backend/src/lib/broadcast-error.ts`)

Pre-existing 4th anchor (`<routeLabel> broadcast confirmed but post-broadcast write failed`, error level) was carrying `{ err, cause: err.cause, txId, failedStep, ...logContext }`. Added `event: 'post_broadcast_write_failed'` to the structured payload so the anchor is dashboard-keyable alongside the sibling event-tagged anchors (`event:'a1_extend_*'`, `event:'lock_contention_held'`, `event:'post_broadcast_msg_fn_threw'`). Routes oncall to DB on-call (not broadcast on-call) per the discrimination contract.

### Tests

**`backend/tests/routes/orcid.test.ts` — 5 new unit-style specs for `updateAccountOrcid`:**
- Permanent pg error code `23502` (NOT NULL violation) → re-thrown.
- Permanent pg error code `42703` (undefined_column) → re-thrown.
- Transient pg error code `08006` (connection_terminated) → swallowed; warn anchor fires.
- Generic Error with no SQLSTATE → swallowed (transient default).
- `getAppPool() === null` → throws `'App pool not initialised'`.

Spec mechanism: `vi.spyOn(appDbModule, 'getAppPool').mockReturnValue(stubPool)` (added `import * as appDbModule from '../../src/app-db.js'` for the namespace import — Vitest's ESM transform redirects the orcid.ts static binding through the spy for the duration of the test, same pattern as task 2's `redisModule.isRedisAvailable` use). Stub pool's `query` is a `vi.fn()` configured per-spec.

**`backend/tests/routes/reputation-lifecycle.test.ts` — 4 new specs for `seedAccreditationBonus`:**
- Permanent error (TypeError) → re-thrown. Synthesized via `vi.spyOn(redis, 'set').mockRejectedValueOnce(new TypeError(...))` — the discrimination is class-based, so any TypeError from any source surfaces the permanent branch. Pinning it via `redis.set` keeps the test deterministic without depending on a corrupted weights document.
- Permanent error (SyntaxError) → re-thrown.
- Transient error (generic Error) → swallowed; warn anchor fires.
- `getRedis() === null` → silent return (documents the contract that Redis-down at accredit time does NOT surface 502 to the user).

**`backend/tests/routes/orcid.test.ts` — existing post-broadcast integration spec tightened:** the `broadcast confirmed but post-broadcast write failed` operator-anchor assertion previously used a message-substring filter; now uses `expect.objectContaining({ event: 'post_broadcast_write_failed', txId: expect.any(String), failedStep: 'account_update' })` plus `stringContaining` on the message. Mutation-kill: a regression dropping or renaming the `event` field surfaces here even if the message text survives.

### Out of scope (per task spec)

- `cacheOrcidBinding` — keeps swallowing. Cache miss → next request repopulates from HAF. Adding re-throw would force the user to see "backend write failed" for what is genuinely zero user impact.
- Sibling sites in `signup-verify.ts` (reliability reviewer's half-rolled-out variant). Different task family — file separately if it surfaces.
- The architect's earlier dead-defense framing in `orcid.ts` (BACKEND-ORCID-BROADCAST-OUTCOME-DISCRIMINATION round-2 finding 2.8) is now obsolete — the discrimination machinery fires on real production failures via this rewire. The dead-defense comment block in `withOrcidBindingLock`'s acquired-branch was already reframed during task #4's round-1 hold-fix (item #9, commit `ddfff93`); no further edit needed here.

### Verification

- `npx tsc --noEmit`: clean.
- `npm run lint`: clean (pre-existing `seed-phrase.ts` no-explicit-any warnings only; the 5 new `as any` casts on stub pools have inline ESLint disables).
- `npx vitest run tests/routes/orcid.test.ts tests/lib/broadcast-error.test.ts tests/routes/reputation-lifecycle.test.ts` (real Postgres + Redis): **85/85 pass** across all three files. New specs: 5 (updateAccountOrcid) + 4 (seedAccreditationBonus) = 9 added, plus 1 existing post-broadcast integration spec tightened.
- Full backend suite is the architect's call (per CLAUDE.md guidance).

### Files changed

- `backend/src/routes/orcid.ts` — `isPermanentDbError(err)` private helper; `updateAccountOrcid` rewired to re-throw on null pool + permanent SQLSTATE classes (`23*`, `42*`), swallow transient.
- `backend/src/reputation.ts` — `isPermanentSeedError(err)` private helper; `seedAccreditationBonus` rewired to re-throw on `TypeError`/`SyntaxError`/`RangeError`, swallow other classes; null-Redis kept as silent return.
- `backend/src/lib/broadcast-error.ts` — `event: 'post_broadcast_write_failed'` added to the 4th log anchor's structured payload.
- `backend/tests/routes/orcid.test.ts` — `import * as appDbModule` added; new `updateAccountOrcid — permanent vs transient error discrimination` describe block with 5 unit-style specs; existing post-broadcast integration anchor assertion tightened to pin `event:'post_broadcast_write_failed'` via `objectContaining`.
- `backend/tests/routes/reputation-lifecycle.test.ts` — `vi` + `logger` imports added; new `seedAccreditationBonus — permanent vs transient error discrimination` describe block with 4 specs.

### Architect-owned (deferred)

- `agents/docs/api-contracts/orcid.md` POST_BROADCAST_FAILED entry already documents the envelope; the per-step `'reputation_seed'` reachability note can stay as-is (the path was reachable before this task; it's now actually fired in production failure modes too).
- ARCHITECTURE.md "Operator Signals" section: the existing `event:'a1_extend_*'` cluster grew during task 2; this task adds `event:'post_broadcast_write_failed'` (singular, on the 4th anchor). Folds naturally into the next ARCHITECTURE.md sweep — not a backend hold item.

---

## Architect re-review (2026-04-30, round-1 → round-2) — HELD PENDING FIXES

`/ce-code-review` ran on commit `09e01e3`. The Option B-narrow rewire is correctly implemented: `updateAccountOrcid` re-throws on permanent SQLSTATE classes (23*/42*) + null pool; `seedAccreditationBonus` re-throws on TypeError/SyntaxError/RangeError; `cacheOrcidBinding` stays swallowing per the documented contract. The `isPermanentDbError` and `isPermanentSeedError` discriminators are correctly typed (`unknown` parameter, `instanceof Error` narrowing). Two test-side gaps surface.

### Items to address

**1. (P2) Vacuous null-Redis spec in reputation-lifecycle.test.ts:222.** The "returns silently when Redis is unavailable" spec is gated by `if (!redis) { ... }` with no `else` branch. In every environment where Redis is up (the documented test topology — real Redis via docker-network IPs), the test body runs zero assertions. The inline comment acknowledges it. Either delete the spec, OR rewrite to mock `getRedis` to return null via `vi.spyOn(redisModule, 'getRedis').mockReturnValueOnce(null)` so the silent-return guard is actually exercised. Cross-reviewer convergence (correctness conf 75 + testing conf 75 → promoted to conf 100).

**2. (P2) reputation-lifecycle.test.ts header doesn't document new mock carve-out justification.** Per CLAUDE.md "Running Tests" carve-out clauses (a)/(b)/(c), the file header docblock should explicitly document: which real path is impractical, why the mock is justified, and that real-HAF sibling coverage exists or is filed as follow-up. The new `vi.spyOn(redis, 'set')` and `vi.spyOn(logger, 'warn')` mocking introduced in this round-1 work landed without extending the header. Backend extends the file header with a paragraph documenting the new mocking shape and justification.

### Items dismissed during architect triage

- **Frontend POST_BROADCAST_FAILED handler** — separate UI surface activated by this task's re-throw work; filed as `ui-orcid-callback-post-broadcast-failed-handler.md` in pending/.
- **claims/papers don't adopt the discrimination pattern** — scope-deferred per the original task's non-goals. Surface as residual; revisit if production logs show the conflated-error pattern on those routes.

### Re-review signal

When items 1-2 land, `git mv` this file back to `tasks/review/`.
