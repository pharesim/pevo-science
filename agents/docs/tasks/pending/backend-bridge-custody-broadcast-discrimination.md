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

---

## Architect re-review (2026-05-11, round-2 → round-3) — HELD PENDING FIXES

`/ce-code-review` ran on round-2 main-tree SHA `706db7c` with 10 reviewer personas (correctness, security, adversarial at opus; testing, maintainability, project-standards, learnings, reliability, kieran-typescript, api-contract at sonnet; `ce-agent-native-reviewer` skipped per project CLAUDE.md). Round-2's 6 hold items (mock-substitution chain, outer-catch INTERNAL_ERROR spec, dhive-shaped fixtures, audit log helper, hoisted op-context, typed `LogContext`) all landed structurally. Re-review surfaced 9 small items clustered on the new `logBroadcastAttempt` helper, the `LogContext` interface, the dhive fixture, and a few test/log polish items. None are blocking; all are bundled into a focused round-3 to converge.

Several cross-task findings (bridge.ts outer-catch missing `event:` discriminators, the `logBroadcastAttempt` closure duplication, the SPA 409 UX gap) are filed as new follow-up tasks rather than bundled here — they have a different ownership shape than this task's narrow contract.

### Items to address (bundle into one round-3 commit)

**1. (P1, anchor 75, adversarial adv-1) `attempt_n: 1` hardcoded gives no retry-amplification signal.** `backend/src/routes/custody.ts` (logBroadcastAttempt helper). The hold-block claimed retry-amplification visibility, but every request collapses to `attempt_n=1` because the helper has no idempotency state. Operator dashboards keyed on `attempt_n` for retry-spike detection are silent. Worse: a constant `attempt_n=1` is harder to fix later than absent-field once dashboards key on it.

   Fix: remove the `attempt_n` field from the helper's log payload entirely until `backend-broadcast-idempotency-cluster-followup.md` lands. Alternative (architect dispreferred but acceptable): keep the field with a load-bearing inline comment naming the idempotency-cluster follow-up as the populator. Architect strongly prefers removal — leaves the dashboard-key-on slot empty rather than misleading.

**2. (P1 anchor 85, cross-reviewer maintainability M-1 + kieran-typescript KTS-2) `LogContext` interface declares 5 fields with no live call sites.** `backend/src/lib/broadcast-error.ts:98`. Fields `newVersion`, `sourceIdentifier`, `identifier`, `cycle_id`, `attempt_n` have no callers passing them through `handleBroadcastError`. The interface's stated purpose — typo detection — only works for fields with live callers. Dead fields broaden the accepted surface and mask future typos that resemble dead names.

   Fix: remove the 5 dead fields from the `LogContext` interface declaration. `newVersion` + `sourceIdentifier` were likely live before `/update` was retired (`e647abb`); the others may never have had callers. Verify with `git grep -n 'logContext: {'` over `backend/src` before removing. Coordinate with item 1: if `attempt_n` is removed per item 1, it leaves this interface entry dead too.

**3. (P2, anchor 100, adversarial adv-2) `makeDhiveLikeError` shared-sentinel weakness.** `backend/tests/support/broadcast-mocks.ts`. The helper sets `err.message === err.jse_shortmsg === opts.shortmsg` (single value reused). The leak-assertion `not.toContain(SHORT)` can't distinguish which field leaked when failing, AND a regression that leaks only one of the two fields while the other is correctly stripped passes spuriously because both share the value. Same shared-value issue for `cause.message` vs `jse_cause`.

   Fix: take distinct per-field sentinels in `makeDhiveLikeError` options (e.g., `messageMarker`, `jseShortMsgMarker`, `causeMarker`, `jseCauseMarker`), or auto-generate per-field unique markers when not provided. Test assertions verify each field's leak path independently. The fixture changes propagate to the 3 dhive-leak specs across bridge.test.ts and custody.test.ts.

**4. (P2, anchor 75, testing T-2) Outer-catch INTERNAL_ERROR spec event-not-equal assertion is circular.** `backend/tests/routes/custody.test.ts` (the outer-catch describe, around lines 248-278 / 718-748 in the original diff view). The spec uses `find(call => ctx?.event === 'custody.broadcast.internal_error')` to locate the matching log call, then asserts `expect(ctx.event).not.toBe('custody.broadcast.attempt')` on that same filtered call — trivially true because the filter already excluded the attempt event. A regression where the inner-catch helper ALSO fires the outer-catch event (or vice versa) would pass this test silently.

   Fix: rewrite the assertion to verify NO call across `errorSpy.mock.calls` (and `infoSpy.mock.calls` for the attempt-side) carries the WRONG event during this test. Pattern:
   ```js
   const attemptCalls = infoSpy.mock.calls.filter(c => c[0]?.event === 'custody.broadcast.attempt');
   expect(attemptCalls).toHaveLength(0);
   ```
   Plus the existing internal-error matching assertion. Architect-suggested shape; final form is implementer's choice as long as the dual-emit mutation is mutation-killed.

**5. (P2, anchor 75, kieran-typescript KTS-1) `LogContext & { cause?: unknown }` widening cast partially defeats protection.** `backend/src/lib/broadcast-error.ts:263` (the cause-strip block). The widening cast at the strip site IS the mechanism by which `cause` re-enters the type system at that scope. A future maintainer adding `cause` directly to `LogContext` would silently make the strip a no-op, removing the runtime protection with no compiler signal.

   Fix (lighter): add a load-bearing comment block at the `LogContext` interface definition explicitly stating `cause` is deliberately omitted, pointing to the strip site at `:263`, and naming the round-2 cause-leak rationale that motivated the strip. Comment-only, about 5 lines. Architect prefers this over a heavier type-split refactor; the type-split (introducing `BroadcastLogContextInput` + `SanitizedBroadcastLogContext`) is acceptable but adds machinery for a defense-in-depth case.

**6. (P3, anchor 75, kieran-typescript KTS-3) `DhiveLikeError.cause: Error` (required) is stricter than base `Error.cause?: unknown` — `as DhiveLikeError` cast is unsound.** `backend/tests/support/broadcast-mocks.ts:62`. The factory does `new Error(...) as DhiveLikeError`, but the interface declares `cause: Error` (required, non-optional). TS accepts the cast — but a future refactor that removed the runtime `err.cause = new Error(opts.cause)` assignment would leave the return type claiming `cause` is present, and callers accessing `dhiveErr.cause.message` would crash at runtime with no compile-time warning.

   Fix: change `cause: Error` to `cause?: Error` on the `DhiveLikeError` interface to match the base. Callers updating to use `?.message` where needed. Alternative (heavier): refactor `makeDhiveLikeError` to construct via object-spread so the post-cast assignment is mechanically tied to the type. Architect prefers the optional-field fix — minimal and matches the base type.

**7. (P3, anchor 75, reliability R-RR2-03) Outer-catch `sendError` missing `return`.** `backend/src/routes/custody.ts:580`. The outer-catch calls `sendError(res, 500, 'INTERNAL_ERROR', ...)` without a `return`. Every other `sendError` call in this handler uses `return sendError(...)`. Currently safe (no code after the outer try/catch), but the asymmetry is a fragility pre-emptive guard. Future code added after the outer try/catch would produce a silent `headers-already-sent` warning.

   Fix: add `return` keyword at line 580. Literally one character.

**8. (P3, anchor 80, maintainability M-3) Test section comments cite stale underscore-form event names.** `backend/tests/routes/custody.test.ts:240` and `:284` (the block comments above the audit-log + outer-catch describes). Comments use underscore-form (`custody_broadcast_internal_error`, `custody_broadcast_attempt`); actual code in custody.ts emits dot-form (`custody.broadcast.internal_error`, `custody.broadcast.attempt`); test assertions correctly use the dot-form. The comment/code mismatch makes the section headers unreliable.

   Fix: update the 2 block comments to use dot-form, aligning with the code emission and the assertions below them. About 4 lines.

**9. (P3, anchor 100, adversarial adv-6) Outer-catch test only exercises `decryptKey` throw, not the 3 documented paths.** `backend/tests/routes/custody.test.ts:248-278`. The spec mocks `decryptKey` to throw. The outer catch is also reached by `pool.query` throw (DB unavailable) and `PrivateKey.fromString` throw (malformed WIF). The spec comment claims "routing is the same for all three" — but only `decryptKey` is exercised. A regression that special-cases `PrivateKey.fromString` or `pool.query` would be undetected.

   Fix: add 2 additional specs in the outer-catch describe block exercising the other paths. Mirror the `decryptKey`-throw spec shape (~20 lines each):
   - `pool.query` throw → assert 500 INTERNAL_ERROR + `event:'custody.broadcast.internal_error'` + `route:'custody.broadcast'`.
   - `PrivateKey.fromString` throw (drive via mocking `decryptKey` to return a malformed WIF) → same assertions.

   Each spec also asserts `logCustodyBroadcastMock` was NOT called (DB-side audit should not fire on pre-broadcast failure).

### Re-review signal

When items 1-9 land in a single round-3 commit, `git mv` this file back to `tasks/review/`. Architect's round-3 review scopes `/ce-code-review` to the round-3 commit only. The 9 items are localized to 4 files (custody.ts, broadcast-error.ts, broadcast-mocks.ts, custody.test.ts); diff size should be moderate (~80-120 LOC) given items 3 + 9 are the larger ones.

### Architect-zone items (NOT for the implementer)

The following follow-ups are architect-owned and land at archive of this task, not as round-3 hold items:
- New task `backend-bridge-outer-catch-event-discriminators.md` for the 7 bridge.ts outer-catch logger.error sites lacking `event:` discriminators (api-contract AC-2, P2 — pre-existing pattern this task's custody change made visible).
- New task `backend-broadcast-attempt-helper-extraction.md` for extracting `logBroadcastAttempt` closure from custody.ts + bridge.ts into a shared factory (maintainability M-2, P2 moderate refactor).

---

## Backend re-review signal (2026-05-11, round-3 hold-fixes — commit `e08bf72` on `main`, originally `47528c7` on `worktree-agent-a52dae09697aab9a8`)

Round-3 hold items 1-9 all landed in commit `e08bf72` on `main` (originally `47528c7` on worktree branch `worktree-agent-a52dae09697aab9a8`; 5 files changed, +271/-25 LOC). Item-by-item summary:

1. (P1, adv-1) Removed `attempt_n: 1` from `logBroadcastAttempt` in `backend/src/routes/custody.ts`. Field is now intentionally absent until the idempotency-cluster follow-up lands the real per-key counter. Test assertion at the success-path spec updated to pin the absence (`expect(ctx.attempt_n).toBeUndefined()`).
2. (P1, M-1 + KTS-2) Dropped 5 dead fields (`newVersion`, `sourceIdentifier`, `identifier`, `cycle_id`, `attempt_n`) from the `LogContext` interface in `backend/src/lib/broadcast-error.ts`. Verified via `git grep -n 'logContext: {' backend/src` — no live call sites passed any of them. `tsc --noEmit` clean.
3. (P2, adv-2) Per-field unique sentinels in `makeDhiveLikeError` at `backend/tests/support/broadcast-mocks.ts` — each of `err.message`, `err.jse_shortmsg`, `err.cause.message`, `err.jse_cause` carries a distinct auto-generated marker (or caller-pinned override). Returned object exposes the markers via `messageMarker`/`jseShortMsgMarker`/`causeMarker`/`jseCauseMarker` so the 2 dhive-leak specs (bridge.test.ts:341, custody.test.ts:213) assert `not.toContain(...)` against each field's own marker independently. The original `SHORT`/`CAUSE`/`INFO_KEY` assertions are retained as a belt-and-braces guard.
4. (P2, T-2) Rewrote the outer-catch INTERNAL_ERROR event assertion in `backend/tests/routes/custody.test.ts` to a no-emit check across `infoSpy`/`warnSpy`/`errorSpy`: `custody.broadcast.attempt` and `broadcast_failed`/`broadcast_timeout` events MUST NOT fire on the outer-catch path. Mutation-kills the dual-emit regression class.
5. (P2, KTS-1) Added a load-bearing comment block at the `LogContext` interface in `backend/src/lib/broadcast-error.ts` (~12 lines) stating that `cause` is deliberately omitted, pointing to the strip site at `:263`, and naming the round-2 cause-leak rationale.
6. (P3, KTS-3) Changed `DhiveLikeError.cause: Error` to `cause?: Error` in `backend/tests/support/broadcast-mocks.ts` to match the base `Error.cause?: unknown`. No callers currently access `.cause.message` so no `?.` propagation needed in callers; the type now matches the runtime semantic.
7. (P3, R-RR2-03) Added `return` keyword to the outer-catch `sendError` call at `backend/src/routes/custody.ts:582` — one-character fix, symmetric with every other `sendError` in this handler.
8. (P3, M-3) Updated 2 stale block comments in `backend/tests/routes/custody.test.ts` from underscore-form (`custody_broadcast_internal_error`, `custody_broadcast_attempt`) to dot-form (`custody.broadcast.internal_error`, `custody.broadcast.attempt`) matching the code emission and the assertions below them.
9. (P3, adv-6) Added 2 new specs in the outer-catch describe block in `backend/tests/routes/custody.test.ts`: one exercising `pool.query` throw (via `appQueryMock.mockImplementation` scoped with save/restore in `finally`), one exercising `PrivateKey.fromString` throw (via `decryptKeyMock.mockReturnValueOnce('not-a-valid-wif-blob')`). Each asserts 500 INTERNAL_ERROR + `event:'custody.broadcast.internal_error'` + `route:'custody.broadcast'` + `logCustodyBroadcastMock` NOT called + no broadcast-attempt event fired.

Non-trivial decisions / surprises:

- **Per-field sentinel scheme** (item 3): chose auto-generated `${shortmsg}::message` / `${shortmsg}::jse_shortmsg` / `${cause}::cause_message` / `${cause}::jse_cause` defaults with explicit override hooks (`messageMarker`/`jseShortMsgMarker`/`causeMarker`/`jseCauseMarker`). Surfaced the chosen markers on the returned `DhiveLikeError & DhiveLikeErrorMarkers` object so test sites don't have to re-derive marker strings. Keeps the 2-marker (`shortmsg`/`cause`) test ergonomics and the architect's suggested 4-marker shape compatible.
- **Outer-catch pool.query test** (item 9): `appQueryMock.mockImplementationOnce` is racy because the middleware ALSO hits `appQueryMock` first (`sessions_invalidated_at` lookup) — a once-impl would consume on the middleware call. Instead saved `getMockImplementation()` and restored it in `finally`, so the throw-by-SQL-shape impl is scoped to this test only without leaking to siblings (since `beforeEach` only does `mockClear`, not `mockReset`).
- **PrivateKey.fromString driver** (item 9): used `decryptKeyMock.mockReturnValueOnce('not-a-valid-wif-blob')` to drive the dhive parser into a real throw at `PrivateKey.fromString`. Confirmed in the test run that the outer catch fires with `event:'custody.broadcast.internal_error'` and the DB-side audit log mock was not called.
- **Test assertion for item 1**: the success-path attempt spec previously asserted `expect(ctx.attempt_n).toBe(1)`. Replaced with `expect(ctx.attempt_n).toBeUndefined()` so the round-3 absence is itself a load-bearing assertion — a future regression re-adding `attempt_n: 1` to the helper fails this spec.
- **Worktree fan-out drift**: this worktree branch (`worktree-agent-a52dae09697aab9a8`) was 221 commits behind `main` at intake. Rebased onto `main` before starting the fixes so the task file (with the round-3 hold block, added in main commit `3f5468b`) was visible. The rebase was clean (no conflicts).

---

## Architect re-review (2026-05-12, round-3 → round-4) — HELD PENDING FIXES

`/ce-code-review` ran on round-3 main-tree SHA `e08bf72` with 10 reviewer personas (correctness + security + adversarial at opus; testing, maintainability, project-standards, learnings, reliability, api-contract, kieran-typescript at sonnet; `ce-agent-native-reviewer` skipped per project CLAUDE.md). Round-3's 9 hold items all landed structurally and against their stated intent — the round-3 review pass converged. Re-review surfaced 6 small follow-up items; 2 dismissed at triage; the remaining 4 are bundled into this round-4 hold for backend-zone polish (all comment-and-test-only edits). No correctness, security, api-contract, project-standards, or reliability findings.

### Items to address (bundle into one round-4 commit)

**1. (P2, anchor 75, maintainability M-2) `attempt_n` absence rationale comments cite the now-archived `backend-broadcast-idempotency-cluster-followup.md` as the pending populator.** `backend/src/routes/custody.ts:461` and `:506-513`. That task archived 2026-05-12 in commit `c715db1` (same calendar day as e08bf72) and the archived arc did NOT add a per-key counter for `attempt_n` — items 1-5 of that arc landed `idempotency_key` + HAF pre-broadcast lookup + Redis tracking + `PostBroadcastWriteError` discrimination, but no per-attempt counter. The two comment sites now mislead on two counts: (a) they point at a closed task, (b) they imply that closing it would have populated `attempt_n` (it didn't).

   Fix: rewrite both comment sites to reflect reality — the idempotency layer landed (so `embedIdempotencyKey` + `lookupCustodyBroadcastIdempotency` are live), but a per-attempt counter mechanism was intentionally NOT added in that arc and remains future work. The `attempt_n` field is still deliberately absent from `logBroadcastAttempt`'s log payload until a per-key counter mechanism exists. ~5 lines per site.

**2. (P3, anchor 100, maintainability M-1 + correctness residual) Stale `:263` line reference in the LogContext comment block.** `backend/src/lib/broadcast-error.ts:182` (inside the round-3 Item 5 block). The comment cites `:263` for the strip site; the actual destructure is at `:382` (~200 lines off). Round-3's hold-block text named `:263` and the implementer copied it verbatim without re-checking against the current file layout (the file reflowed during round-3 work). Two reviewers flagged this.

   Fix: replace `:263` with a function-name reference rather than a new line number — e.g., "see the `sanitizeLogContext` destructure below" or similar drift-resistant wording. Line numbers in comments rot; the function/identifier name doesn't.

**3. (P3, anchor 100, maintainability M-3) Stale underscore-form `custody_broadcast_failure` in production-source comment.** `backend/src/routes/custody.ts:127`. The comment cites `event:'custody_broadcast_failure'` for operator visibility — no such event exists anywhere in the codebase. Actual events are `custody.broadcast.internal_error` (outer catch, added round-3) and `broadcast_failed` / `broadcast_timeout` (chain-rejection, emitted via `handleBroadcastError`). Round-3 Item 8 fixed similar underscore-form drift in test-file block comments but missed this sibling site in production source.

   Fix: replace the underscore-form name with the correct dot-form event name(s) the surrounding code path actually emits. Pick by reading the comment's local context; if the comment is generic to the helper, list both `custody.broadcast.attempt` (success/failure/timeout outcomes via the helper) and `broadcast_failed` / `broadcast_timeout` (chain-rejection via handleBroadcastError) and `custody.broadcast.internal_error` (outer catch).

**4. (P3, anchor 75, testing + correctness + adversarial) `if (savedImpl)` guard on the appQueryMock save/restore silently no-ops if `mockClear` switches to `mockReset`.** `backend/tests/routes/custody.test.ts:387` (within the new outer-catch specs' `finally` blocks). `getMockImplementation()` returns `undefined` if the module-load impl has been wiped (which `mockReset` does, but the current `beforeEach mockClear` does not). The guard silently skips the restore in that case, letting the throw-impl leak into sibling specs. Three reviewers flagged this independently.

   Fix: drop the `if (savedImpl)` guard and make the restore deterministic — either by re-installing the module-load impl explicitly in the `else` branch (so the test file's `beforeEach` discipline is independent of whether the module-load impl survived), or by capturing the explicit impl at the spec's start (e.g. assigning the test's intended fallback locally) and restoring unconditionally. The simplest concrete shape: at module scope, hoist a reference to the original impl declaration; `finally` restores from that reference unconditionally. Either way, no `if (savedImpl)` silent-skip path.

### Items dismissed during architect triage

- **Duplicate cause-omission comment blocks** (maintainability M-4, `broadcast-error.ts:180-193` + `:357-381`). Item 5 was specifically asked for as a load-bearing comment block AT THE LogContext DECLARATION SITE — the architectural premise of round-3 Item 5 was that a short cross-reference would get skipped by readers adding fields to LogContext. Compressing the verbose block into a one-sentence pointer re-opens the very failure mode Item 5 was designed to close. The drift risk between the two blocks is real but lower-severity than the typo-defense the verbose block provides at the type definition. Revisit if drift becomes observable (e.g., the strip mechanism moves and the LogContext-side block goes stale).
- **Per-field marker fields leak via pino's err serializer** (maintainability M-7, `broadcast-mocks.ts:139`). Forward-compat concern only; no live consumer is affected today. Current leak-assertions are on the response body (`JSON.stringify(res.body).not.toContain(...)`), not on the err-slot serialization. If a future task adds log-side leak-assertions against the err-slot payload and the marker noise becomes a real obstacle, the refactor (returning markers as a sibling tuple rather than stamping them as own-properties) lands then with clear motivation. Speculative refactor cost against hypothetical future need; deferred.

### Architect followups (land at archive, do NOT block backend re-submit)

- **A1.** `/ce-compound-refresh` on `agents/docs/solutions/conventions/pino-spy-serializer-ordering-trap-2026-05-06.md` to fold in "use distinct per-field markers when fields may leak independently" — round-3 Item 3 surfaced the gap in the existing test-fixture-discipline section. Per the learnings researcher.
- **A2.** `/ce-compound-refresh` on `agents/docs/solutions/conventions/vi-spyon-mockimplementation-bypasses-function-under-test-2026-05-12.md` to add a "save/restore vs `mockImplementationOnce` when the mock is shared with sibling middleware/helpers" subsection — round-3 Item 9's load-bearing design choice. Per the learnings researcher.
- **A3.** Round-2 architect followup A2 still carries forward: `bridge.md` / `custody.md` document `timeout_ms` as required in the 504 details envelope while `common.md` says optional. For these routes every 504 is timer-fired so the docs are de-facto accurate, but the imprecision will mislead a future caller adding `forceAmbiguousOutcome`. Architect adds `(present; these routes always use the timer-fire path)` qualifier at archive.

### Re-review signal

When items 1-4 land in a single round-4 commit, `git mv` this file back to `tasks/review/`. Architect's round-4 review scopes `/ce-code-review` to the round-4 commit only. The 4 items are localized to 2 production-source files + 1 test file (`backend/src/lib/broadcast-error.ts`, `backend/src/routes/custody.ts`, `backend/tests/routes/custody.test.ts`); diff size should be small (~10-20 LOC, mostly comment edits + the savedImpl guard removal). Expect convergence at round-4.