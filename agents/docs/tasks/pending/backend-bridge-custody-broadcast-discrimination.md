# BE-BRIDGE-CUSTODY-BROADCAST-DISCRIMINATION — Migrate `bridge.ts` + `custody.ts` `broadcastSendOperationsWithTimeout` catch blocks to the 504/502 pattern

**Owner:** backend
**Created:** 2026-04-22 (surfaced by BE-ORCID-BROADCAST-ABORT-TIMEOUT round-2 review)
**Priority:** P2

## Context

`BE-ORCID-BROADCAST-ABORT-TIMEOUT` round-1 migrated 7 HTTP surfaces using `broadcastJsonWithTimeout` to the 504 `BROADCAST_TIMEOUT` / 502 `BROADCAST_FAILED` / 500 `INTERNAL_ERROR` discrimination pattern. `bridge.ts` (`/register`, `/update`) and `custody.ts` (`/broadcast`) use a different helper — `broadcastSendOperationsWithTimeout` (landed in `BE-BROADCAST-SENDOPERATIONS-WRAP`, currently pending merge) — and their catch blocks still emit a single HTTP 500 `BROADCAST_FAILED` for all error shapes. `BroadcastTimeoutError` is not discriminated.

Maintainability MAINT-002 (0.85) + kieran-typescript KT-R2-2 (0.85) + KT-R2-3 (0.82) in the round-2 review:

- `backend/src/routes/bridge.ts:266,388` and `backend/src/routes/custody.ts:143` catch blocks use `(err as any)` with no `instanceof BroadcastTimeoutError` guard. A timeout returns 500 with no `retriable` flag — inconsistent with the 7 migrated routes.
- `bridge.ts` interpolates `err.message` / `jse_shortmsg` into the response body (`"Hive broadcast failed: ${detail}"`), leaking chain-internal error text to callers. This is a defense-in-depth issue: response messages should be static; chain internals go to server logs only.
- Secondary: 7 `(err as Error).message` casts in `bridge.ts` (non-broadcast error logging) pass a string to pino's `err` key, defeating pino's error serializer. Pre-existing pattern in a touched file.

AC-009 (0.85) from api-contract review: `BROADCAST_FAILED` now returns TWO different HTTP statuses (500 on bridge/custody, 502 on the 7 migrated routes) — an API-surface inconsistency.

## Goal

1. Migrate the 3 call sites to the 504/502 discrimination pattern. If `backend-handle-broadcast-error-helper.md` has landed, use the helper; otherwise inline the pattern.
2. Remove `err.message` / `jse_shortmsg` interpolation from `bridge.ts` response bodies — use a static string per branch and log the full error object for operators.
3. Normalize the 7 pre-existing `(err as Error).message` sites in `bridge.ts` to pass the full error object to pino: `logger.error({err, ...context}, ...)`.
4. Update `agents/docs/api-contracts/bridge.md` and `custody.md` errors sections with the new 502/504 entries (architect-owned fix-in-place at review time).

## Non-goals

- Changing the rate-limit or auth behavior on these endpoints.
- Extending the discrimination to `anonymousReview.ts` — separate assessment; that path uses raw `hiveClient.broadcast.sendOperations` (not the timeout helper) per round-1 residual risk.
- Introducing a new `BROADCAST_CHAIN_ERROR` code separate from `BROADCAST_FAILED` — maintain the single-code contract.

## Acceptance

- `bridge.ts` `/register` + `/update` and `custody.ts` `/broadcast` emit 504 `BROADCAST_TIMEOUT` on `BroadcastTimeoutError` and 502 `BROADCAST_FAILED` on other errors, envelope shape per `agents/docs/api-contracts/common.md`.
- Response messages are static strings; no `err.message` or `jse_shortmsg` interpolation.
- Logger calls use `{err, ...context}` (full object to pino); no `(err as Error).message` casts.
- Per-route timeout specs landed (mirror `orcid.test.ts` / `claims.test.ts` pattern).
- `npx tsc --noEmit` clean; full backend vitest passes.
- `[TODO Architect]` note on the re-review signal for `bridge.md` and `custody.md` contract updates.

## Coordination

- Prefer landing AFTER `backend-handle-broadcast-error-helper.md` so the migration is a 5-line change per site rather than 16. Not a hard dependency.
- The pending merge of `BE-BROADCAST-SENDOPERATIONS-WRAP` must land first (that's the commit that introduced `broadcastSendOperationsWithTimeout`). Backend agent is already handling that merge as of 2026-04-22.

## [TODO Architect]

On re-review, architect applies contract-file updates in `agents/docs/api-contracts/` (implementer did NOT touch the contract files):

- `bridge.md` — on `POST /register` and `POST /update`, replace the prior 500 `BROADCAST_FAILED` with:
  - 504 `BROADCAST_TIMEOUT`, details `{retriable:false, outcome:"uncertain", verify_before_retry:true, timeout_ms}` (no `verify_location`, not an orcid surface).
  - 502 `BROADCAST_FAILED`, details `{retriable:false}`.
  - Static response messages per branch:
    - register 504: `"Broadcasting bridge paper registration timed out"`
    - register 502: `"Failed to broadcast bridge paper registration to Hive"`
    - update 504: `"Broadcasting bridge paper update timed out"`
    - update 502: `"Failed to broadcast bridge paper update to Hive"`
- `custody.md` — on `POST /broadcast`, add the same 504/502 entries. Note the handler still emits 500 `INTERNAL_ERROR` for non-chain errors (db / decrypt / key parse) via the outer catch; only broadcast-path errors flow through 502/504.
  - 504: `"Broadcasting signed operation timed out"`
  - 502: `"Failed to broadcast signed operation to Hive"`

Implementer note (BE-BRIDGE-CUSTODY-BROADCAST-DISCRIMINATION, 2026-04-22): the 3 call sites were migrated via `handleBroadcastError` (landed in `0c95115`). Contract files are architect-owned and were deliberately not touched.

---

## Architect re-review (2026-05-04) — HELD PENDING FIXES

`/ce-code-review` ran on the actual implementer commit `27cc588` (the signal block above mis-cites `0c95115`, which is the helper-extraction prerequisite — corrected at archive). 10 personas dispatched (correctness, testing, maintainability, project-standards, learnings, security, reliability, api-contract, adversarial, kieran-typescript; ce-agent-native skipped per root CLAUDE.md). Migration is structurally correct: 504/502 envelope shape matches `common.md` Option A.2, static response strings exact per the [TODO Architect] block, no `err.message` interpolation in response body, `verifyHiveSignature` middleware unchanged, custody inner-try correctly scoped. Findings cluster around: log-side leak surface (operator-log plane vs response plane), test fixtures that pass by construction, retry-amplification on custody, and operator-log signal quality.

### Items to address

**1. (P1) Test mock instanceof chain structurally fragile re: `vi.mock` module-load order.** `tests/routes/bridge.test.ts:55-84` and `tests/routes/custody.test.ts:34-58`. Both files mock `'../../src/hive.js'` to replace `BroadcastTimeoutError`. `broadcast-error.ts` imports the same module. Vitest's `vi.mock` runs before imports — so the mock substitution + helper instanceof check resolve to the same class TODAY. If a future top-level import preempts `vi.hoisted` (or a refactor introduces a re-export barrel), the real class loads first; the mock substitution races; `instanceof` returns false; every 504 timeout-discrimination test silently passes against the wrong branch. Mutation: collapses to 502; no failing test signal.

Fix:
- (a) Extract a shared mock module at `backend/tests/support/broadcast-mocks.ts` exporting the hoisted `MockBroadcastTimeoutError` class. Both `bridge.test.ts` and `custody.test.ts` import from there. Eliminates the 9-line per-file duplication and centralizes the mock identity.
- (b) Add a top-of-`describe` structural identity assertion in EACH test file that is also load-bearing: `expect(BroadcastTimeoutError).toBe(MockBroadcastTimeoutError)` (or equivalent — verify the helper's imported reference IS the mock substitution). Mutation-kills the regression class: any future change that breaks the substitution chain fails this single assertion before any other test runs.

This also closes maintainability M-RR-01 (duplicate-stub residual).

**2. (P1) Custody outer-catch behavior change `BROADCAST_FAILED` → `INTERNAL_ERROR` untested.** `tests/routes/custody.test.ts`. The diff renames the 500 code on the outer catch (covers db / decrypt / `PrivateKey.fromString` errors) but no test exercises the outer-catch path. A mutation that reverts the code back to `BROADCAST_FAILED` (or alters the log message) is undetected.

Fix: add a spec that mocks `decryptKey` (or `pool.query`, or `PrivateKey.fromString`) to throw, asserts response is 500 `INTERNAL_ERROR` with the new static message, and asserts the structured log carries the appropriate non-broadcast event discriminator. One per failure source is sufficient (the routing is the same for all three).

**3. (P1) Test fixtures use `new Error(CHAIN_INTERNAL)` so leak-assertion passes by construction; VError/`jse_shortmsg` shape never exercised.** `tests/routes/bridge.test.ts:296` and `tests/routes/custody.test.ts:639-647`. The `JSON.stringify(res.body).not.toContain(CHAIN_INTERNAL)` assertion is the load-bearing defense-in-depth check, but it's tested against a plain `Error` object whose body is now a static string regardless. The pre-migration code preferred `err.jse_shortmsg` over `err.message` — a regression that interpolates `jse_shortmsg` back into the body would NOT fail this test.

Fix: extend the test fixtures to also stage rejections shaped like real dhive errors — at least one spec per route should reject with an object carrying `jse_shortmsg`, `jse_cause`, `info`, and `cause` properties (matching VError/RPCError's shape). The leak-assertion then has actual surface to catch a regression.

**4. (P1) Always-log custody broadcast attempts (close audit-log blind spot).** `routes/custody.ts:logCustodyBroadcast` fires only on success. Combined with no idempotency on `/broadcast` (a fresh tx is constructed per call), a timeout+retry can produce duplicate ops on chain (duplicate vote / duplicate `comment` / duplicate `custom_json`) and the audit log shows only the second. Operators have no signal for retry amplification.

Fix: rename / refactor `logCustodyBroadcast` (or wire a sibling logger call) so EVERY attempt is recorded with `outcome: 'success' | 'failure' | 'timeout'` + `attempt_n` + the standard structured event discriminator. The full idempotency design (Option A.4 from `chain-write-timeout-ambiguous-outcome-2026-04-22.md`) is filed as `backend-broadcast-idempotency-cluster-followup.md`; this hold-fix item is the audit-log half only.

**5. (P2) Operator-log signal quality — `opTypes` shape + custody outer-catch context loss.**
- `routes/custody.ts:141` builds `opTypes = operations.map(op => op[0]).join(',')` for the structured log. For multi-op transactions, a chain rejection at `op[1]` cannot be correlated with the bundle from logs alone. Fix: emit `op_types: string[]` + `op_count: number` as separate structured fields (not a comma-joined string).
- `routes/custody.ts:160-163` outer catch logs `{ err, username }` but not `opTypes`. If `decryptKey` or `PrivateKey.fromString` throws, operators lose the operation context. Fix: hoist `opTypes` (and the structured fields above) to the outer scope so both the inner and outer catch reference the same context object.

**6. (P2) `logContext` typed `Record<string, unknown>` in `lib/broadcast-error.ts:84`.** Call sites pass structured fields (`author`, `permlink`, `username`, `opTypes`, `newVersion`, `sourceIdentifier`, `identifier`). A typo in a field name (e.g., `permink`) compiles silently because the type accepts any string key. Fix: introduce a narrowed `LogContext` interface with the field names that actually appear at call sites, or per-site literal types. Compile-time protection on the operator-log shape.

### Items dismissed during architect triage

- **Missing `Co-Authored-By:` trailer on `27cc588`.** Pushed history; force-rewriting public history is not worth a cosmetic trailer; subsequent agent commits comply. Future-proof: an analogous hook check could prevent recurrence (filed as a hypothetical for a separate session).
- **Bridge admin RC drain via accreditation + 504-encouraged retries.** Accept-and-document — separate concern (rate-limit-by-RC-budget); not introduced by this migration.
- **Race conditions in bridge writes (R-1 /register HAF-lag race, R-2 /update version-counter race).** Pre-existing patterns the migration touched but didn't introduce. Filed as `backend-bridge-write-haf-lag-and-retry-amplification.md` (P2 reliability follow-up).
- **`PrivateKey.fromString(config.pevoBridgePostingKey)` inside the broadcast try-catch.** Two concerns at the same line: (a) classification — invalid WIF mis-classified as 502 BROADCAST_FAILED instead of 500/503; (b) log-side leak — `AssertionError.actual`/`.expected` carry buffer slices DERIVED from the WIF, pino's default err serializer expands them. Both addressed by the new task `backend-bridge-key-startup-validation-and-pino-redact.md` (P1 — startup WIF validation eliminates branch (a) preemptively; project-wide pino `err` redact policy closes (b) AND the parallel ioredis `err.command.args` leak in δ-sec-1 in one cohesive change).

### Architect followups (land at archive, do NOT block backend re-submit)

- **A1.** Correct the implementer note's commit cite from `0c95115` (the helper-extraction prerequisite) to `27cc588` (the actual migration). One-line edit + parenthetical clarification.
- **A2.** `bridge.md` and `custody.md` document `timeout_ms` as required in the 504 details envelope; `common.md` says optional (present only on the timer-fire path; absent on `forceAmbiguousOutcome` paths). For these routes every 504 is timer-fired so the docs are de-facto accurate, but the imprecision will mislead a future caller adding `forceAmbiguousOutcome`. Architect adds `(present; these routes always use the timer-fire path)` qualifier when the contract docs are touched at archive.

### Re-review signal

When items 1-6 land, `git mv` this file back to `tasks/review/`. The architect's next review pass scopes `/ce-code-review` to the round-2 commit and archives on clean. Expected round-2 commit is small (test additions + one structural assertion + log-shape refactor + one new shared module).

---

## Backend re-review signal (2026-05-04, commit 706db7c)

Round-2 hold-fix items 1-6 all landed in commit `706db7c` (cherry-pick of worker `5974687`).

**Item 1 (P1) — Shared mock identity.** Extracted `MockBroadcastTimeoutError` + `makeDhiveLikeError` to new `backend/tests/support/broadcast-mocks.ts`. Both `tests/routes/bridge.test.ts` and `tests/routes/custody.test.ts` import from there. Each file mounts a top-of-`describe` structural assertion `expect(BroadcastTimeoutError).toBe(MockBroadcastTimeoutError)` that mutation-kills future substitution-chain regressions (re-export barrel, hoist preempt, ordering change). Closes M-RR-01 duplicate-stub residual.

**Item 2 (P1) — Custody outer-catch INTERNAL_ERROR coverage.** New spec mocks `decryptKey` to throw, asserts response is 500 `INTERNAL_ERROR` with the static `'Failed to broadcast transaction'` message and the new `event:'custody_broadcast_internal_error'` discriminator. Mutation reverting the rename to `BROADCAST_FAILED` would now fail.

**Item 3 (P1) — VError-shape leak surface.** `makeDhiveLikeError` builds an RPCError-shaped object with `jse_shortmsg`/`jse_cause`/`info`/`cause`. One spec per route (`/register`, `/update`, `/broadcast`) rejects with this shape so the `JSON.stringify(res.body).not.toContain(CHAIN_INTERNAL)` leak-assertion has actual surface.

**Item 4 (P1) — Always-log custody attempts.** New `logBroadcastAttempt` helper fires on EVERY broadcast attempt with `outcome: 'success' | 'failure' | 'timeout'` + `attempt_n` + structured `event:'custody_broadcast_attempt'`. Three specs cover all three outcomes. Closes the audit-log blind spot. Full idempotency design remains filed as `backend-broadcast-idempotency-cluster-followup.md`.

**Item 5 (P2) — `op_types` shape + outer-catch context.** Hoisted `op_types: string[]` and `op_count: number` to outer try-scope; outer catch now logs them with the new event discriminator. Multi-op transactions can now be correlated from logs alone.

**Item 6 (P2) — `LogContext` interface.** Replaced `Record<string, unknown>` in `lib/broadcast-error.ts:84` with a narrowed `LogContext` interface covering all 18 fields used across orcid/bridge/custody/claims/papers/accreditation call sites. `event:` deliberately omitted so helper's spread-after-literal write still wins. Compile-time protection on operator-log shape.

### Verification

- Targeted vitest: `tests/routes/bridge.test.ts` 13/13, `tests/routes/custody.test.ts` 11/11, `tests/lib/broadcast-error.test.ts` 19/19. All green.
- `npx tsc --noEmit`: clean.
- `npm run lint`: clean (pre-existing `seed-phrase.ts` `any` warnings only).

### [TODO Architect]

The pre-existing round-1 architect followup A2 (qualifying `timeout_ms` semantics in `bridge.md`/`custody.md`) carries forward unchanged. No NEW architect TODOs from this round.

