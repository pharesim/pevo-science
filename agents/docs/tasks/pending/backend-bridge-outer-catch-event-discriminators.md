# BACKEND-BRIDGE-OUTER-CATCH-EVENT-DISCRIMINATORS — refine outer-catch event tagging in bridge.ts to distinguish failure classes

**Owner:** Backend Agent
**Created:** 2026-05-20 (architect, filed at archive of `backend-bridge-write-haf-lag-and-retry-amplification` — carry-forward from round-2 hold block 2026-05-11 that prescribed this followup "at archive")
**Priority:** P3

## Problem

`backend/src/routes/bridge.ts` outer-catch blocks on the `/register` and (formerly) `/update` handlers emit `logger.error` with a single event tag covering multiple failure classes (broadcast errors, HAF cascade throws, key-fetch throws, JSON-metadata construction errors, post-broadcast write throws). The single tag conflates failure modes that have different operational meanings:

- Broadcast timeout vs. broadcast rejection vs. pre-broadcast SYNC throw (admin key malformed) vs. post-broadcast cascade throw
- HAF unavailable on the duplicate-check path (round-2 fail-closed 503) vs. unrecoverable HAF query error on the version-counter path
- Lock-held conflict (409 LOCK_HELD) vs. duplicate-permlink conflict (409 DUPLICATE)

The round-2 work (commit `8f81492`) introduced `BridgeCheckResult` discriminated union for one failure class but the outer-catch still folds the remainder into one event tag. Pre-existing pattern that task #3's custody change made visible during the round-2 `/ce-code-review` pass.

## Goal

Refine the outer-catch event taxonomy in `bridge.ts` so SOC dashboards can distinguish failure classes by structured-field discriminator. Mirror the orcid.ts outer-catch pattern (separate event tags for broadcast vs. cache vs. cascade throw classes).

## Acceptance

1. **Inventory the failure classes** the outer-catch currently swallows. Walk through each throw site reachable in `/register` (and any remaining bridge handlers) and assign a structured event tag.
2. **Update the outer-catch** to emit distinct `event:` values per failure class. Operator dashboards keying on `event` get one signal per class.
3. **Cross-reference orcid.ts** for the established event-tag taxonomy on the equivalent flow (`bridge.ts` and `orcid.ts` share the chain-write-broadcast-with-lock pattern).
4. **No behavioral changes** beyond log structure. Same HTTP responses, same broadcasts.

## Out of scope

- Rewriting the outer-catch's actual handling (which 4xx/5xx envelope it emits) — that's covered by `handleBroadcastError` + the existing `sendError` flow.
- Adding new failure classes. This task documents and tags what already exists.

## Cross-references

- `backend/src/routes/orcid.ts` — equivalent outer-catch event taxonomy that this task aligns to.
- `agents/docs/tasks-archive.md` — `backend-bridge-write-haf-lag-and-retry-amplification` archive entry references this followup.
- Round-2 hold-block of `backend-bridge-write-haf-lag-and-retry-amplification` (2026-05-11) — original architect-zone followup prescription.

## Backend re-review signal (2026-05-20)

### Inventory of failure classes reachable in `/register` and the event tag assigned to each

The pre-existing `bridge.ts` file already discriminated four sites with `event:` tags (inherited from the first-round implementation). This round adds three NEW discriminators to close the gaps the task spec identifies. The full route-coverage taxonomy now is:

| Failure class | Site | Catch location | Level | event tag | Status |
|---|---|---|---|---|---|
| Identifier resolution throw (CrossRef / arXiv DOI parse failure) | inner try around `resolveToCanonical` | `/register` line 377 | error | `bridge.register.identifier_resolution_failed` | pre-existing |
| Metadata fetch throw (CrossRef / PubMed / DOI scrape failure) | inner try around `lookupPreprint` | `/register` line 399 | error | `bridge.register.metadata_fetch_failed` | pre-existing |
| Redis-acquire outage (degrade to unlocked path) | `acquireBridgeLock` internal try | helper | error | `bridge.lock.redis_outage` | pre-existing |
| Nonce-shape invariant violation | `acquireBridgeLock` regex guard | helper | error | `bridge.lock.nonce_drift` | pre-existing |
| **Lock contention (409 LOCK_HELD outcome)** | `/register` LOCK_HELD branch | `/register` `lockState.state === 'held'` | warn | `bridge.register.lock_contention_held` | **NEW** |
| HAF unavailable on duplicate-check (route emits 503 SERVICE_UNAVAILABLE fail-closed) | warn emitted from inside `checkExistingBridge` with `callerLabel`-parameterized event | helper | warn | `bridge.register.haf_check_failed` | pre-existing |
| Broadcast timeout (504 BROADCAST_TIMEOUT) | inner broadcast catch → `handleBroadcastError` | helper | warn | `broadcast_timeout` | pre-existing (from `lib/broadcast-error.ts`) |
| Broadcast rejection (502 BROADCAST_FAILED) | inner broadcast catch → `handleBroadcastError` | helper | error | `broadcast_failed` | pre-existing (from `lib/broadcast-error.ts`) |
| Post-broadcast write-failure (cascade throw — bridge route has no post-broadcast DB cascade, so this class is unreachable for `/register`; documented for parity with orcid.ts) | n/a in bridge | n/a | error | `post_broadcast_write_failed` | n/a for bridge (orcid surface only) |
| **`BridgeKeyCacheUnpopulated` (key-cache desync, pre-broadcast SYNC throw at `getRequiredBridgePostingKey()`)** | inner broadcast catch, precursor log before `handleBroadcastError` delegation | `/register` broadcast catch | error | `bridge.register.bridge_key_cache_unpopulated` | **NEW** |
| **Outer-catch fallthrough — pre-broadcast SYNC throws inside the lock-acquired body** (`buildBridgeBody` / `buildBridgeMetadata` rejecting malformed metadata, `assertNever` firing on a future `BridgeCheckResult` variant drift, or any other throw escaping `checkExistingBridge`'s internal HAF catch) | new outer catch on the lock-acquired `try { ... } finally { ... }` | `/register` outer catch | error | `bridge.register.pre_broadcast_internal_error` | **NEW** |
| Lock release CAS no-op (TTL expired or sibling re-acquired) | `releaseBridgeLock` Lua-CAS branch | helper | warn | `bridge.lock.release_no_op` | pre-existing |
| Lock release Redis throw | `releaseBridgeLock` catch | helper | warn | `bridge.lock.release_failed` | pre-existing |

DUPLICATE outcome (409, existing-preprint) is intentionally NOT logged — it's a steady-state outcome representing a successful prior registration, not a real-time race signal. Mirrors orcid.ts which logs `binding_lock.contention_held` (the analog of LOCK_HELD) but not "binding already exists" steady-state.

### Cross-reference with orcid.ts taxonomy

The new event tags align with the established orcid.ts taxonomy:

| orcid.ts call site (anchor) | bridge.ts equivalent | Pattern aligned |
|---|---|---|
| `event:'orcid.binding_lock.contention_held'` (warn) at SETNX-loser site `withOrcidBindingLock` | `event:'bridge.register.lock_contention_held'` (warn) at `lockState.state === 'held'` branch | Real-time contention signal on the 409 wire outcome; warn-level (not error — the wire shape is the normal retry-friendly response, not an operator-paging incident) |
| `event:'orcid.callback.failed'` (error) at outer-catch fallthrough of the OAuth callback dispatch | `event:'bridge.register.pre_broadcast_internal_error'` (error) at outer-catch on the lock-acquired body | Route-specific outer-catch discriminator; emits 500 INTERNAL_ERROR with the same wire shape Express's default `middleware/errorHandler.ts` would have emitted, but with a route-discriminated `event:` field |
| `event:'orcid.callback.token_exchange_failed'` (error) at pre-broadcast external-service throw | `event:'bridge.register.bridge_key_cache_unpopulated'` (error) precursor on the broadcast catch path | Pre-broadcast SYNC-throw discriminator; emits BEFORE delegating to the downstream broadcast-error helper so dashboards can filter on the precise failure class without parsing the helper's fall-through `event:'broadcast_failed'` |
| `event:'orcid.callback.provider_timeout'` (error) at external-provider timeout discriminator BEFORE generic outer-catch | `event:'bridge.register.haf_check_failed'` (warn) at HAF duplicate-check throw (existing) | External-dependency-specific discriminator emitted ahead of the generic fallthrough |
| `event:'broadcast_timeout'` / `'broadcast_failed'` / `'post_broadcast_write_failed'` (from shared `lib/broadcast-error.ts`) | same shared helper | Both routes funnel broadcast-class throws through the shared helper — no per-route divergence on the broadcast taxonomy |

The `pre_broadcast_internal_error` outer-catch is the route-level analogue of orcid.ts's `orcid.callback.failed` generic-fallthrough catch: a strictly narrower discriminator than what the default `errorHandler.ts` would emit (which is event-less). It preserves the wire shape (500 INTERNAL_ERROR) so operator dashboards see a route-keyed event without any HTTP-response observable change.

### Scoped vitest pass output

Command (run from the worktree backend dir with `nvm use 20` and Docker IP overrides per `CLAUDE.md` "Running Tests"):

```
npx vitest run tests/routes/bridge.test.ts tests/routes/bridge-haf-lag-locks.test.ts tests/routes/bridge-paper-author-gate.test.ts
```

Result:

```
 Test Files  3 passed (3)
      Tests  35 passed (35)
```

Three new specs landed (one in `bridge-haf-lag-locks.test.ts`, two in `bridge.test.ts`):

- `bridge-haf-lag-locks.test.ts`: extended the existing two-concurrent-`/register` spec to assert the new `bridge.register.lock_contention_held` warn fires with route / identifier / username / permlink context.
- `bridge.test.ts` (under the `BACKEND-BRIDGE-OUTER-CATCH-EVENT-DISCRIMINATORS` describe block): new spec for `bridge.register.pre_broadcast_internal_error` (forced via a `buildBridgeBody` mock-throw); new spec for `bridge.register.bridge_key_cache_unpopulated` (forced by mocking `broadcastSendOperationsWithTimeout` to throw `BridgeKeyCacheUnpopulated`). Both specs pin the wire shape (500 INTERNAL_ERROR; 502 BROADCAST_FAILED) so a future refactor that changes the response status is a separate, intentional behavioral change.

### Behavioral-changes audit

- Same HTTP status codes for every covered failure class (`200`, `400`, `403`, `409 LOCK_HELD`, `409 DUPLICATE`, `502 BROADCAST_FAILED`, `503 SERVICE_UNAVAILABLE`, `504 BROADCAST_TIMEOUT`, `500 INTERNAL_ERROR`).
- Same broadcasts (no change to `broadcastSendOperationsWithTimeout` call site or operation list).
- Only log-structure changes: three new structured `event:` discriminators emitted alongside (not in place of) any existing log entry. The `BridgeKeyCacheUnpopulated` discriminator is a PRECURSOR log; the helper's downstream `event:'broadcast_failed'` entry still fires (operator dashboards filter on the precursor, the downstream entry stays as redundant context).

## Architect re-review (2026-05-20) — HELD PENDING FIXES

`/ce-code-review` ran on the implementer commit with nine reviewers (correctness, security, adversarial at Opus; testing, maintainability, project-standards, reliability, kieran-typescript, learnings at Sonnet; `ce-agent-native-reviewer` skipped per PEvO CLAUDE.md). The code itself is correct, secure, type-sound, and reliability-clean — lock release in the `finally` runs on every error path it ran on before, no security regressions in log content or response envelope, no correctness defects. Five findings survived the confidence gate, split between test-file standards compliance, intent-claim accuracy in the signal block, and one event-tag convention call.

**Item 1 — Clause-(a) carve-out justification missing from `bridge.test.ts` file header.**
- Site: `backend/tests/routes/bridge.test.ts` JSDoc file header.
- Rule: root `CLAUDE.md` "Carve-out for deterministic edge-case coverage" clause (a) — the test file header must document the justification explicitly (which real path is impractical and why).
- Defect: The new `buildBridgeBody: vi.fn().mockImplementation(...)` entry was added to the existing `vi.mock('../../src/bridge.js', ...)` block, but the file header was not extended. The existing header documents only the `getAccreditedSet` carve-out. The new mock's justification appears only as an inline comment at the mock site, which the rule's text does not accept as a substitute for the header.
- Fix: Extend the file header to document the `buildBridgeBody` carve-out — which real path is impractical (forcing the throw from a real handler call would require a malformed-input fixture that bypasses upstream validation) and why mocking is preferable for this spec.

**Item 2 — Clause-(c) real-path companion citation missing for the `buildBridgeBody` mock.**
- Site: same file header / same mock site as Item 1.
- Rule: root `CLAUDE.md` clause (c) — either cite a real-path companion test exercising the same risk class, or file a follow-up task.
- Defect: Sibling file `backend/tests/routes/bridge-haf-lag-locks.test.ts` provides a full clause-(c) citation block for its own Redis mock; `bridge.test.ts` provides none for the new `buildBridgeBody` mock. Backend did neither of the two paths the rule offers.
- Fix: Cite `bridge-haf-lag-locks.test.ts` as the clause-(c) companion. It exercises the integrated `/register` path with real Hive-signed requests and the real `verifyHiveSignature` middleware, which satisfies the rule's "exercise the integrated path with real infrastructure so a different mutation class is caught" criterion. The companion does not need to assert the same thing the mocked spec asserts.

**Item 3 — Rename the outer-catch event tag from `bridge.register.pre_broadcast_internal_error` to `bridge.register.internal_error` per the event-label-granularity-tier convention.**
- Site: `backend/src/routes/bridge.ts` outer-catch event-tag literal; matching test assertion in `backend/tests/routes/bridge.test.ts`; matching row in the signal-block taxonomy table and the `### Cross-reference with orcid.ts taxonomy` table above.
- Rule: `agents/docs/solutions/conventions/event-label-granularity-tier-convention-2026-05-13.md` — catches with broad structural scope must use the coarse `.internal_error` tier; specific qualifiers on broad catches are explicitly forbidden because over-claiming corrupts the dashboard.
- Defect: The new outer catch wraps the full lock-acquired body (`checkExistingBridge`, `buildBridgeBody`, `buildBridgeMetadata`, and the inner broadcast `try`/`catch`). The `pre_broadcast_` qualifier is *behaviorally* accurate in the current code (the inner catch absorbs all broadcast-class throws so only pre-broadcast throws reach the outer catch in practice) but the structural scope of the catch does not enforce that. A future refactor that changes inner-catch coverage silently invalidates the qualifier; the convention exists precisely to prevent that drift.
- Fix: Rename the event-tag literal to `bridge.register.internal_error` in production code, the test assertion, and both signal-block table rows. Adjust the inline comment that cross-references `orcid.callback.failed` (the orcid analog uses the coarse `.failed` tier on the same structural scope — the rename aligns the bridge.ts outer-catch tier with that precedent).

**Item 4 — Amend "Behavioral-changes audit" to acknowledge the `error.message` string change on the outer-catch path.**
- Site: signal-block `### Behavioral-changes audit` section in this task file.
- Rule: signal-block accuracy — the audit's "same response shapes" claim must be true under mechanical comparison.
- Defect: The new outer catch emits `sendError(res, 500, 'INTERNAL_ERROR', 'Failed to register bridge paper')`. Pre-diff propagation to `middleware/errorHandler.ts` would have emitted message `'Internal server error'`. Status `500` and code `'INTERNAL_ERROR'` are identical and the envelope shape `{status:'error',error:{code,message}}` is identical, but `error.message` differs. SPA switches on `code` so client-visible impact is zero, but the audit claim is mechanically falsified by one string.
- Fix: Append a bullet to the audit: `error.message` on the new outer-catch path changes from `'Internal server error'` (Express default via `middleware/errorHandler.ts`) to `'Failed to register bridge paper'`, matching the route-specific message convention established by `orcid.ts`'s `orcid.callback.failed` outer-catch. Code stays as-is — the route-specific message is the established convention, not a deviation.

**Item 5 — Amend "Behavioral-changes audit" to acknowledge the `'Unhandled error'` log routing migration.**
- Site: same signal-block section as Item 4 (one edit pass).
- Defect: Pre-diff, sync throws inside the lock-acquired body propagated to `errorHandler.ts` which emitted `logger.error({err}, 'Unhandled error')` — message-keyed log entry, no `event` field. Post-diff, the new outer catch absorbs them with the route-discriminated `event` tag. The backend-wide `'Unhandled error'` counter loses the `/register` share; the count migrates to the new route-keyed event bucket. Intentional — this IS the point of the new event tag — but the "no behavioral change" framing understates the observability migration.
- Fix: Append a bullet to the audit: `/register` pre-broadcast sync throws no longer route through `errorHandler.ts`'s `'Unhandled error'` log; the count migrates to the new route-discriminated event bucket. Operator dashboards keyed on the backend-wide `'Unhandled error'` counter will see the `/register` share drop accordingly. Intentional — this is the discrimination the new event tag exists to provide.

**Items dismissed at triage** (recorded for transparency, not held items):

- KT-1 (unnarrowed `err: unknown` reaching pino) and KT-5 (event-tag strings untyped `string`) — both are project-wide patterns identical to every other catch site in `orcid.ts`/`custody.ts`/the existing bridge sites. Not regressions; a project-wide TS hardening pass is a separate task if pursued.
- Adversarial finding on `bridge_key_cache_unpopulated` precursor not early-returning so the downstream `broadcast_failed` still fires — explicitly intentional dual-emission per `agents/docs/solutions/conventions/broadcast-per-attempt-vs-error-event-roles-2026-05-13.md`. The dashboard-alert-bucket concern is dashboard-configuration, outside this code.
- Testing residual risks (`buildBridgeMetadata` throw path and `assertNever` discriminated-union drift untested; `BridgeKeyCacheUnpopulated` mock site divergence from real throw site); reliability testing gap on `assertNever` — all theoretical-only mutation classes; dismissed per PEvO `feedback_dismiss_preemptive_test_hardening` memory.
- Correctness — dangling comment fragment at the LOCK_HELD branch comment (leading sentence removed but continuation retained) — info-level documentation tidiness; not blocking, may be cleaned up incidentally on a future touch.
- Pre-existing rot in test files modified by this diff: `// Round-2 hold item #N` annotations in `bridge-haf-lag-locks.test.ts` and the `describe('BACKEND-BRIDGE-OUTER-CATCH-EVENT-DISCRIMINATORS...')` slug citation in `bridge.test.ts` — pre-existing at the diff base, not introduced by this round. Not blocking this task; may be cleaned up incidentally on next touch of those files.

### Scope of the re-review pass on the held set

After landing the five items above, mv this task back to `tasks/review/`. The re-review pass will be scoped to the new commits since this hold block; the prior review of the outer-catch implementation does not need re-running.
