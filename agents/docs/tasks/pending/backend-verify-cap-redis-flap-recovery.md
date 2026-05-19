# BACKEND-VERIFY-CAP-REDIS-FLAP-RECOVERY — Auto-recovery design + operator manual-reset runbook

**Owner:** Backend Agent
**Created:** 2026-05-04 (architect, surfaced by δ `/ce-code-review` cluster B)
**Priority:** P2 (reliability)

## Why now

δ round-3 added the broadcast-attempts cap on `/api/accreditation/verify` (item 11 = pre-INCR 503; item 10 = Redis-unavailable warn during DECR). Cluster-B `/ce-code-review` surfaced a residual reliability gap that round-3 deliberately scoped out:

### Counter inflated for 24h on Redis flap with no auto-recovery (R-1 + ADV-1, conf 75)

When Redis is OK at pre-INCR (claim slot) but flaps before DECR-on-timeout, the round-3 hold #10 warn fires correctly. However, the counter STAYS INFLATED at its pre-DECR value until the key's Redis TTL expires (up to 24h). There is:
- No retry of the failed DECR.
- No scheduled cleanup.
- No re-decrement when Redis recovers.
- No documented manual-reset runbook for operators.

Worst case: cap = 3, all 3 slots are consumed by flap-inflated counters → token is soft-blocked for 24h even though no broadcast ever fired. Operator has the warn signal (`accred_verify_broadcast_decrement_redis_unavailable`) but no lever.

Three transient flaps over a token's life can exhaust the cap (each flap fires the warn, doesn't decrement, counter inflates monotonically). Soft-block keeps the token alive but the user sees `BROADCAST_ATTEMPT_LIMIT_EXCEEDED` indefinitely; the only recovery is waiting out the 24h counter TTL or burning a fresh `/request` slot (which is itself rate-limited at 3/24h).

## Goal

Add auto-recovery of inflated counters when Redis returns to a healthy state, OR document a clear manual-reset runbook for operators if auto-recovery is rejected as too complex.

## Acceptance

### 1. Auto-recovery design (preferred path)

Pick ONE of:

**(a) Pending-decrement queue.** When DECR fails (Redis unavailable mid-request), append `(token, attempt_id)` to an in-process queue. A background process drains the queue periodically (e.g., every 30s), retrying DECR on Redis when available. Queue persists in-process only — process restart loses pending decrements (fail-open: counter stays inflated until 24h TTL).

**(b) Per-token expected-vs-actual reconciliation.** Track per-token `claimed_attempts` (incremented on pre-INCR) AND `confirmed_attempts` (incremented only on broadcast success/definitive failure). On `/verify` request: if `claimed > confirmed + cap`, reject; otherwise allow + claim. Reconciliation loop trims stale `claimed`. Trade-off: heavier accounting; cap semantics shift from "concurrent slots" to "outstanding claims."

**(c) Redis-side TTL-aware self-healing.** Lua script that checks counter age + decrements automatically if older than a heuristic threshold. Heuristic-based; brittle.

Recommended: (a). Bounded blast radius (queue is in-process, process restart is fail-open — counter inflates but recovers via 24h TTL). Cleanest abstraction. Test surface is mockable.

### 2. Operator manual-reset runbook

Independent of auto-recovery, add a `/api/admin/accreditation/reset-broadcast-counter` endpoint (auth: admin Hive signature) that DELs the counter key for a given token. Use cases:
- Operator confirms via Redis logs that a counter is inflated due to a flap they investigated.
- User reports persistent `BROADCAST_ATTEMPT_LIMIT_EXCEEDED` on a verified accreditation token.

Document the endpoint + intended use in `agents/backend/CLAUDE.md` operator runbook section (or wherever ops procedures live).

### 3. Tests

- `accred_verify_broadcast_decrement_redis_unavailable` warn fires + (a) auto-recovery queue records the pending DECR; (b) on next Redis-recovers tick, queue drains; counter is decremented.
- Counter persists if process restarts mid-flap (fail-open verified).
- Admin reset endpoint requires valid admin signature; rejects unauthorized; succeeds on valid request; structured log records the manual reset.

### 4. Convention update

Update or extend `agents/docs/solutions/conventions/chain-write-timeout-ambiguous-outcome-2026-04-22.md` (or a new sibling): "Counter-side state in `/verify`: pre-INCR + decrement-on-timeout. Failure modes: Redis-flap inflates the counter; auto-recovery via in-process pending-decrement queue; manual reset via admin endpoint."

Architect-owned; backend leaves [TODO Architect] markers.

## Out of scope

- Redis Cluster / Sentinel deployment hardening. PEvO is single-Redis today; flap recovery is about transient connection loss, not cluster topology.
- Cross-process pending-decrement persistence (e.g., write the queue to disk). In-process is sufficient; process restart is acceptable fail-open behavior.
- Replacing the broadcast-attempts cap entirely (e.g., switch to a different rate-limit primitive). The cap design is sound; this task is about its failure-mode coverage.
- Project-wide Redis-flap handling for OTHER counters / locks / caches. Per-feature handling for the verify cap; survey other features in a separate audit task if needed.

## Coordination

- **δ's hold-block:** δ round-4 lands the unified Redis-flap COVERAGE block (item 11 + item 10 + Reliability-R2 tests). After δ archives, this task adds the RECOVERY (not just the warn signal).
- **Architect must approve** the auto-recovery design choice before backend implements.

## Source

- δ `/ce-code-review` (cluster B, 2026-05-04): reliability R-1 + adversarial ADV-1 cross-corroborated.

## Cross-references

- `agents/docs/solutions/conventions/chain-write-timeout-ambiguous-outcome-2026-04-22.md` — parent convention.
- `backend/src/lib/redis-scripts.ts` — Lua INCR_AND_EXPIRE script (added in δ round-3).
- `backend/src/routes/accreditation.ts` — current decrement implementation.

---

## [BLOCKED by Architect] (backend startup triage 2026-05-04)

Coordination explicit: "Architect must approve the auto-recovery design choice before backend implements." The acceptance enumerates three substantively different designs:
- (a) In-process pending-decrement queue (recommended in the task body).
- (b) Per-token expected-vs-actual reconciliation (`claimed_attempts` vs `confirmed_attempts`).
- (c) Redis-side TTL-aware self-healing Lua script.

These have distinct semantics — (a) is fail-open on process restart with in-process queue, (b) shifts cap meaning from "concurrent slots" to "outstanding claims" and changes counter accounting, (c) is heuristic. Backend cannot pick one unilaterally without architect alignment, since (b) in particular changes the user-visible cap semantics described in `accreditation.md`.

What backend needs from architect to unblock:
1. Pick (a), (b), or (c) — or rule out auto-recovery entirely and proceed with manual-reset endpoint only.
2. Confirm the admin-reset endpoint path (`/api/admin/accreditation/reset-broadcast-counter`) and auth shape (admin Hive signature) — this surfaces a new admin route that needs `accreditation.md` contract entry + `common.md` error-code review.
3. Decide where the operator runbook lives (`agents/backend/CLAUDE.md` operator section vs a new ops doc).

Independent of recovery design, the manual-reset endpoint pieces are largely self-contained backend work and could ship first — but architect should confirm before backend implements.

---

## Architect decision (2026-05-04) — UNBLOCKED, returning to `pending/`

**Decision 1: Auto-recovery design = (a) in-process pending-decrement queue.**

Bounded blast radius (in-process state, fail-open on restart absorbs into the 24h TTL). PEvO is single-Node-process per backend container, so the cross-process limitation of (a) doesn't bite. (b) shifts user-visible cap semantics from "concurrent slots" to "outstanding claims" and changes the contract — too invasive for a reliability follow-up. (c) is heuristic and brittle.

Implementation hints:
- Drain interval: 30s default, configurable via env var (`VERIFY_DECREMENT_QUEUE_DRAIN_MS`).
- Queue is a plain in-memory `Map<string, { token, attemptId, queuedAt }>` keyed on `attemptId` so duplicate enqueues are idempotent.
- On drain, attempt DECR; on success, remove from queue; on Redis still-unavailable, leave it; emit a structured `accred_verify_decrement_queue_drain` log line per drain cycle with queue depth.
- Process restart loses pending decrements (acceptable; counter recovers via 24h TTL). Document this fail-open behavior explicitly.
- Cap queue depth (e.g. 1000 entries) with overflow log to bound memory; in practice queue should rarely exceed single digits.

**Decision 2: Admin endpoint shape confirmed.**

- Path: `/api/admin/accreditation/reset-broadcast-counter`
- Auth: admin Hive signature against `config.hiveAdminAccount` (singular per `project_admin_is_singular.md`).
- Request body: `{ token: string }` — the verification token whose counter to reset.
- Response: standard success/error envelope per `agents/docs/api-contracts/common.md`.
- Structured log line on every reset (operator audit trail): admin account, target token, timestamp, prior counter value if known.

Backend leaves `[TODO Architect]` markers for `agents/docs/api-contracts/accreditation.md` (architect-owned zone); architect lands the contract entry on review pass.

**Decision 3: Runbook location = extend the existing convention doc.**

Extend `agents/docs/solutions/conventions/chain-write-timeout-ambiguous-outcome-2026-04-22.md` with a "Manual reset runbook" section covering: when to use the endpoint (operator confirmed via Redis logs that a counter is inflated due to a flap; user reports persistent `BROADCAST_ATTEMPT_LIMIT_EXCEEDED` despite no actual broadcast), how to call it, what to log. No new ops doc — would violate rule #9 (no spec file sprawl).

Backend leaves `[TODO Architect]` marker; architect lands the convention update.

**Sequencing:**

The manual-reset endpoint (Decision 2) is largely self-contained and can ship first, independent of the queue work (Decision 1). Either order is fine; backend picks. A single PR covering both is also acceptable if scope is manageable.

This task returns to `tasks/pending/` for backend pickup.

---

## Backend implementation (2026-05-05)

Single bundle covering both Decision 1 (queue) and Decision 2 (admin endpoint).

### Files

- `backend/src/lib/pending-decrement-queue.ts` (new): `Map<attemptId, {token, attemptId, queuedAt, key}>` with `enqueueDecrement`, `drainQueue`, `startDecrementQueueDrainer`/`stopDecrementQueueDrainer`. Drain interval = `config.verifyDecrementQueueDrainMs` (env `VERIFY_DECREMENT_QUEUE_DRAIN_MS`, default 30000ms). Cap at 1000 entries with single overflow warn (`accred_verify_decrement_queue_overflow`). Per-cycle `accred_verify_decrement_queue_drain` info-level log with `queue_depth`, `drained`, `initial_depth`. Per-entry retry failure during drain emits `accred_verify_decrement_queue_retry_failed` warn and stops the cycle (remaining entries deferred to the next tick).
- `backend/src/config.ts`: new `verifyDecrementQueueDrainMs` field.
- `backend/src/routes/accreditation.ts`: `decrementBroadcastAttempts(token, attemptId?)`; on `isRedisAvailable() === false` and on `redis.decr` rejection, the helper enqueues `(token, attemptId, key)` before warning / re-throwing. Route generates a per-request `attemptId = crypto.randomBytes(8).toString('hex')` and passes it through. The existing `accred_verify_broadcast_decrement_redis_unavailable` warn and the route-level `accred_verify_broadcast_decrement_failed` warn shapes are preserved (queue is additive, not a replacement).
- `backend/src/index.ts`: `startDecrementQueueDrainer()` after `startArgon2AbortReporter()`; `stopDecrementQueueDrainer()` in graceful shutdown.
- `backend/src/routes/admin.ts` (new): `POST /api/admin/accreditation/reset-broadcast-counter`. Auth: `verifyHiveSignature` + caller-must-equal-`config.hiveAdminAccount`. Body validated with the existing `accreditationVerifySchema` (token: string, 1-128 chars). Response data shape: `{ token_hash, prior_value }`. Audit log on success: `event: 'admin_reset_broadcast_counter'` with `admin_username`, `token_hash`, `prior_value`. Forbidden-attempt log: `event: 'admin_reset_broadcast_counter_forbidden'` with `attempted_by`, `token_hash` (no raw token to operator logs). 503 path when Redis unavailable preserves the counter for retry.
- `backend/src/app.ts`: mount `adminRouter` at `/api/admin`.

### Tests

- `backend/tests/lib/pending-decrement-queue.test.ts` (new, 8 specs): enqueue, idempotent enqueue, drain success, race-recovery DEL on `after < 0`, drain skip when Redis unavailable, drain log shape, per-entry failure stops drain, overflow at 1000 entries, env-var wired through to config.
- `backend/tests/routes/accreditation.test.ts` (3 new specs at the bottom of the BE-VERIFY-BROADCAST-ATTEMPTS-CAP describe): `isRedisAvailable() === false` + attemptId enqueues, `redis.decr` rejection + attemptId enqueues then re-throws, drain end-to-end (enqueue via route helper, then drain decrements the real counter).
- `backend/tests/routes/admin.test.ts` (new, 6 specs): 401 without auth, 400 missing token, 403 non-admin (audit log + no raw token leak), 200 happy path with prior_value=3, 200 with prior_value=null when key absent, 503 when Redis unavailable.

### Operator-facing log discriminators (new)

- `accred_verify_decrement_queue_drain` (info, every drain cycle when there's anything queued)
- `accred_verify_decrement_queue_retry_failed` (warn, per-entry on drain)
- `accred_verify_decrement_queue_overflow` (warn, fires once per overflow streak)
- `accred_verify_decrement_queue_drain_threw` (error, drain cycle threw — should never fire in practice)
- `admin_reset_broadcast_counter` (info, audit trail)
- `admin_reset_broadcast_counter_forbidden` (warn)
- `admin_reset_broadcast_counter_redis_unavailable` (warn)
- `admin_reset_broadcast_counter_failed` (error)

## [TODO Architect] — `agents/docs/api-contracts/accreditation.md` admin endpoint contract row

Add a new endpoint section for `POST /api/admin/accreditation/reset-broadcast-counter`. Suggested content (architect to phrase per `common.md` conventions):

- **Path.** `POST /api/admin/accreditation/reset-broadcast-counter`
- **Auth.** `verifyHiveSignature`; caller MUST equal `config.hiveAdminAccount` (singular per `project_admin_is_singular` memory). Non-admin callers get 403 `FORBIDDEN`.
- **Request body.**

  ```json
  { "token": "<verification token>" }
  ```

  Validated with the existing `accreditationVerifySchema` (string, 1-128 chars). Missing or invalid → 400 `BAD_REQUEST`.
- **Response (200).**

  ```json
  {
    "status": "ok",
    "data": {
      "token_hash": "<12-hex sha256 prefix>",
      "prior_value": 3
    }
  }
  ```

  `prior_value` is the integer counter value before reset, or `null` if the key was absent. The response intentionally returns the hashed token, not the plaintext, so audit consumers can correlate against the operator log without surfacing replay-grade material in transit.
- **503.** When Redis is unavailable. Envelope per `common.md` 503 shape: `{ retriable: true }`. Counter is unchanged; operator can retry once Redis recovers, or wait the 24h TTL.
- **403.** When caller is authenticated but not the admin account. Envelope per `common.md` 403 shape.
- **Use case.** Manual-reset lever for the `/api/accreditation/verify` broadcast-attempts cap when a Redis flap left the counter inflated and the auto-recovery queue (in-process, fail-open on restart) cannot resolve it. See the `chain-write-timeout-ambiguous-outcome` convention's "Manual reset runbook" section for when to invoke.

## [TODO Architect] — `agents/docs/solutions/conventions/chain-write-timeout-ambiguous-outcome-2026-04-22.md` runbook + recovery section

Extend the existing convention doc with two additions:

### Auto-recovery: in-process pending-decrement queue

Counter-side state in `/api/accreditation/verify` is shaped as pre-INCR + decrement-on-timeout. The decrement can fail in two flap modes:

1. `isRedisAvailable() === false` mid-request (the increment landed via the live client, the decrement found `status !== 'ready'`).
2. `redis.decr` throws (Redis evicted to read-only, ioredis-side connection drop, OOM).

Both modes enqueue `(token, attemptId, key)` into an in-process pending-decrement queue (`backend/src/lib/pending-decrement-queue.ts`). A periodic drainer (`config.verifyDecrementQueueDrainMs`, default 30s) retries DECR when Redis is available. Bounded blast radius: in-process state, fail-open on restart (counter recovers via 24h Redis TTL), 1000-entry depth cap with overflow log.

The queue is keyed on a per-request `attemptId` so duplicate enqueues (same in-flight request) overwrite the prior entry rather than double-counting. The `key` is captured at enqueue time so the drainer doesn't re-derive it.

### Manual reset runbook

Use `POST /api/admin/accreditation/reset-broadcast-counter` to manually clear an inflated counter. When to invoke:

- Operator confirmed via Redis logs that a counter is inflated due to a flap (the auto-recovery queue did not converge — process restart between flap and drain, or flap exceeded 24h, or queue overflowed).
- A user reported persistent `BROADCAST_ATTEMPT_LIMIT_EXCEEDED` on `/api/accreditation/verify` despite no actual broadcast having fired.

How to call:

- Sign a Hive request as `config.hiveAdminAccount` (singular). The route accepts the standard request-bound signed message: `{APP_TAG}-auth|v1|POST|/api/admin/accreditation/reset-broadcast-counter|sha256(body)|<timestamp>`.
- Body: `{ "token": "<the affected verification token>" }`.
- Response includes `prior_value` so the operator can record the pre-reset state in the incident log.

What to log: every reset emits a structured `event: 'admin_reset_broadcast_counter'` info line with `admin_username`, `token_hash`, `prior_value`. Forbidden attempts emit `event: 'admin_reset_broadcast_counter_forbidden'`. Redis-unavailable resets emit `event: 'admin_reset_broadcast_counter_redis_unavailable'`. The plaintext token is NEVER logged — the route is the SOLE credential for `/verify`, so any operator-log retention window would otherwise be a replay grace period.

---

## Architect re-review (2026-05-18, round-1 → round-2) — HELD PENDING FIXES

`/ce-code-review` on the round-1 implementation commit (10 reviewers — correctness + security + adversarial on Opus; testing/reliability/api-contract/maintainability/project-standards/kieran-typescript/learnings-researcher on Sonnet; `ce-agent-native-reviewer` skipped per PEvO CLAUDE.md). Both architect-decided designs land in intent: the in-process pending-decrement queue + drainer recover the broadcast-attempts counter on Redis flap, and the admin reset endpoint provides the manual-reset operator runbook lever. Reviewers verified the queue's `attemptId` insulation, the per-cycle drain log, the overflow warn, and the admin-equality 403 audit log with no raw-token leak.

Seven items held — three are substantial code-shape issues (key-string duplication, log event naming inconsistency, atomicity gap on the admin reset GET+DEL), one is a substantial cross-reviewer task-slug citation cluster, two are test-coverage gaps (500-branch + clause-(a)/(c) carve-out shortfall), and one is a contract-consistency follow-on (`Retry-After: 30` header on 503). Plus the comment-anchor cleanup which subsumes the slug citations from #7.

### Items held (must fix before archive)

**1. (P1, conf 100, maintainability + api-contract residual) `broadcastAttemptsKey` duplicated verbatim across `backend/src/routes/admin.ts` and `backend/src/routes/accreditation.ts`.** Both files define a private `broadcastAttemptsKey(token)` function whose body is the same template literal. A key-schema change in `accreditation.ts` (rename, suffix, hash) would leave `admin.ts` silently operating on a stale key — the admin reset endpoint would `GET` and `DEL` a key that no longer exists in the accreditation route's namespace, returning `prior_value: null` and "succeeding" without clearing the actual inflated counter. The drift hazard is invisible to typechecking and to existing tests.

  Suggested fix: export `broadcastAttemptsKey` from `accreditation.ts`, import it in `admin.ts`. One source of truth. Test-helper duplications of the same template literal in `pending-decrement-queue.test.ts` and `admin.test.ts` are lower priority — defer to opportunistic cleanup when next touching those files.

**2. (P1, conf 95, maintainability) Log event naming inconsistency between existing accreditation events (dotted-path form) and the 8 new events introduced by this commit (flat-underscore form).** All existing `accreditation.verify.*` log events use the canonical dotted-path shape per `auth-structured-log-shape-2026-04-29.md` (`event: '<module>.<handler>.<sub_event>'`, snake_case). This commit introduces 8 new events in flat-underscore form: `accred_verify_decrement_queue_drain`, `accred_verify_decrement_queue_retry_failed`, `accred_verify_decrement_queue_overflow`, `accred_verify_decrement_queue_drain_threw`, `admin_reset_broadcast_counter`, `admin_reset_broadcast_counter_forbidden`, `admin_reset_broadcast_counter_redis_unavailable`, `admin_reset_broadcast_counter_failed`. Operator dashboard filters keyed on `accreditation.*` miss all 8 new events.

  Suggested fix: rename to dotted-path form. Queue events → `accreditation.verify.decrement_queue_drain`, `...decrement_queue_retry_failed`, `...decrement_queue_overflow`, `...decrement_queue_drain_threw`. Admin events → `accreditation.admin.reset_broadcast_counter`, `accreditation.admin.reset_broadcast_counter_forbidden`, `accreditation.admin.reset_broadcast_counter_redis_unavailable`, `accreditation.admin.reset_broadcast_counter_failed`. Update any test assertions that match exact event strings (the test for item 4 below extends this — pin the renamed `accreditation.admin.reset_broadcast_counter_failed` discriminator).

**3. (P1, conf 100, project-standards × 6 sites + maintainability) Task-slug citations and one round-number reference introduced in 6+ sites across new production and test source.**

  Sites (all `+` lines in this commit):
  - `backend/src/lib/pending-decrement-queue.ts` file header docblock: cites the task slug + `agents/docs/tasks/.../backend-verify-cap-redis-flap-recovery.md`.
  - `backend/src/config.ts` near the queue-drain config field: contains a `// See lib/pending-decrement-queue.ts and BE-VERIFY-CAP-REDIS-FLAP-RECOVERY.` comment.
  - `backend/src/routes/accreditation.ts` three new comment blocks (catch block, Redis-unavailable branch, attemptId declaration): each cites `BE-VERIFY-CAP-REDIS-FLAP-RECOVERY`.
  - `backend/src/routes/admin.ts` file header comment: `// Manual-reset runbook lever for BE-VERIFY-CAP-REDIS-FLAP-RECOVERY.`
  - `backend/tests/lib/pending-decrement-queue.test.ts` header: `// Coverage for ... the in-process pending-decrement queue introduced by BE-VERIFY-CAP-REDIS-FLAP-RECOVERY.`
  - `backend/tests/routes/accreditation.test.ts` new describe-block header: `// BE-VERIFY-CAP-REDIS-FLAP-RECOVERY — queue-enqueue + auto-recovery` + `// Round-3 hold #10 added the Redis-unavailable warn at the DECR site` (round-number reference too).
  - `backend/tests/routes/admin.test.ts` file header docblock: task-slug citation.

  Suggested fix: rewrite all sites to behavioral anchors. Examples — the queue file header: "In-process queue for retrying `/api/accreditation/verify` broadcast-attempt counter DECRs after a Redis flap. Drainer runs at `config.verifyDecrementQueueDrainMs` (default 30s)." The `config.ts` comment: "See `startDecrementQueueDrainer` in `lib/pending-decrement-queue.ts`." The `accreditation.ts` catch-block comment: "DECR threw during Redis flap — enqueue for periodic retry to prevent counter inflation until 24h TTL." The `admin.ts` file header: "Operator manual-reset lever: clears an inflated broadcast-attempts counter when the in-process pending-decrement queue cannot converge (process restart, 24h TTL expiry, or queue overflow)." The `accreditation.test.ts` describe-block: "queue-enqueue + auto-recovery against /verify broadcast-attempt counter on Redis flap." Drop the "Round-3 hold #10" round-number reference; replace with a description of the invariant being tested.

  Per `convention-enforcing-fix-must-audit-its-own-new-code-2026-05-17.md`, the rewrite prose must not reintroduce task-slug citations, round-N markers, line-number anchors, or SHA references.

**4. (P2, conf 88, testing T1) 500 branch in `backend/src/routes/admin.ts` (`redis.get` or `redis.del` throws under `isRedisAvailable() === true`) has no test in `backend/tests/routes/admin.test.ts`.** The catch block emits a distinct log discriminator and returns 500 `INTERNAL_ERROR`. Six other paths are tested (401 no auth, 400 missing token, 403 non-admin, 200 happy path, 200 `prior_value: null`, 503 Redis unavailable); the 500 path is the only branch without a regression pin. Reachable in production via ioredis reconnect during the operation window.

  Suggested fix: add one spec that stubs `redis.get` (or `redis.del`) to reject mid-reset, asserts the 500 + `INTERNAL_ERROR` envelope, and asserts the log discriminator fires. Pin the renamed event per item 2 (after the rename, the discriminator is `accreditation.admin.reset_broadcast_counter_failed`).

**5. (P2, conf 75, project-standards × 2) MOCK_VERIFY_SIGNATURE carve-out clauses (a) and (c) shortfall in `backend/tests/routes/admin.test.ts`.** Per the "Running Tests" carve-out (root `CLAUDE.md`), clause (a) requires the test file header to explicitly state cryptographic verification is bypassed AND why the focus permits it. The current header documents the mock's purpose but does not contain the required explicit statement. Clause (c) requires a real-path companion OR a follow-up task for the same risk class; the companion exists at `backend/tests/middleware/verifyHiveSignature-authmethod.test.ts` (exercises both `verifyHiveSignature` branches with real signed requests) but the `admin.test.ts` header does not name it.

  Suggested fix: extend the header to read approximately: "Cryptographic signature verification is bypassed by `MOCK_VERIFY_SIGNATURE`; only the header-presence gate and username-extraction are exercised by the mock. The test focus is the admin equality check, counter-reset logic, and Redis-state handling, not the Hive signature algorithm. The clause (c) real-path companion lives at `backend/tests/middleware/verifyHiveSignature-authmethod.test.ts`, which exercises the middleware's both branches with genuine Hive-signed requests."

**6. (low, conf 75, reliability) Non-atomic `redis.get(key)` + `redis.del(key)` pair in the admin reset route returns potentially stale `prior_value`.** If a concurrent write to the counter key lands between the `GET` and `DEL` commands (e.g., a parallel `/verify` request increments the counter), the `prior_value` returned to the operator does not match what was actually deleted. For the runbook use case — operator recording pre-reset state in an incident log — a stale `prior_value` is an audit-trail inaccuracy.

  Suggested fix: replace the `GET` + `DEL` pair with `redis.getdel(key)` (ioredis exposes this for Redis 6.2+). One atomic command. If the Redis version cannot be assumed, use a 2-line Lua script: `local v = redis.call('GET', KEYS[1]); redis.call('DEL', KEYS[1]); return v`. PEvO's deployment uses a modern Redis; `redis.getdel` should work directly.

**7. (low, conf 75, api-contract AC-1) 503 path of `POST /api/admin/accreditation/reset-broadcast-counter` omits `Retry-After: 30` header.** Per `agents/docs/api-contracts/common.md` and the sibling 503 paths on `POST /api/accreditation/verify` (both `ACCREDITATION_GATE_UNAVAILABLE` and `SERVICE_UNAVAILABLE` branches), retriable-503 emissions pair `details.retriable: true` with a `Retry-After: 30` header. The admin endpoint emits only the body signal. Any SPA code that reads `retryAfterSeconds` from the header on a retriable 503 gets `undefined` on this path, silently skipping the backoff floor.

  Suggested fix: add `res.set('Retry-After', '30');` immediately before the `sendError` call on the 503 branch. Assert `res.headers['retry-after']` equals `'30'` in the 503 spec.

### Items dismissed during architect triage

- **(P1, conf 70, adversarial) Admin endpoint accepts JWT-bearer auth, potentially violating ARCHITECTURE.md § 6.5 invariant #1.** Verified at triage: the admin account is set via `HIVE_ADMIN_ACCOUNT` env var (default `pevo.admin`); no elevation route, no admin-management UI, no DB column tracks admin status. The signup flow can't register the admin account as a light account either — `create_claimed_account` consumes claimed-account tokens to mint a NEW Hive account, but the admin account is already on-chain, so Hive itself would reject the operation. The JWT path through `verifyHiveSignature` for the admin's username is structurally impossible under current architecture. If a future admin-management route lands, this concern re-opens; not held against round-1.
- **(P2, conf 80, adversarial) Queue overflow at 1000 silently drops new entries while caller assumes successful enqueue.** Overflow requires sustained Redis outage AND high traffic; the admin reset endpoint provides operator recovery. Default-recommend dismiss per `feedback_dismiss_preemptive_test_hardening`.
- **(low, conf 60, adversarial) Drainer break-on-first-fail strands queued entries behind a poison entry.** Recovery cadence is bounded (30s next-cycle re-attempt); if a poison entry exists, ALL entries on the same DECR target would also fail (real Redis issue, not entry-specific). Below the actionable bar.
- **(low, conf 50, correctness residual) `prior_value` uses `Number(raw)` without NaN guard.** Unreachable from live code (the counter key is only INCR/DECR-written). Below the actionable bar.
- **(P1, conf 90, api-contract AC-2) `agents/docs/api-contracts/accreditation.md` admin endpoint row not yet documented.** Architect-zone; landed at cluster archive time as part of the api-contracts sweep (implementer's [TODO Architect] block at task tail).

### Re-review signal

When items 1-7 land, `git mv` this file back to `tasks/review/`. Round-2 architect review scopes `/ce-code-review` to the round-2 commit only.

Items 1-7 touch a mix of `backend/src/routes/admin.ts`, `backend/src/routes/accreditation.ts`, `backend/src/lib/pending-decrement-queue.ts`, `backend/src/config.ts`, and the three test files. Implementer's call whether one bundled commit, two (`code-shape + comment-anchor` + `tests`), or three; the zone-audit hook will be satisfied as long as all paths are under `backend/`.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>

---

## Backend re-review signal (2026-05-19, commit SHA `a678463`)

All 7 round-2 hold items landed in a single bundled commit (`a678463`):

- **Item 1.** `broadcastAttemptsKey` is now `export`ed from `backend/src/routes/accreditation.ts` and imported in `backend/src/routes/admin.ts`; the duplicate definition is gone.
- **Item 2.** All 8 new log events renamed to canonical dotted-path form (`accreditation.verify.decrement_queue_{drain,retry_failed,overflow,drain_threw}`, `accreditation.admin.reset_broadcast_counter{,_forbidden,_redis_unavailable,_failed}`). Test assertions in `tests/lib/pending-decrement-queue.test.ts` and `tests/routes/admin.test.ts` updated to pin the renamed discriminators.
- **Item 3.** Task-slug citations + the one round-number reference removed from all 6+ sites: `backend/src/lib/pending-decrement-queue.ts` header, `backend/src/config.ts` knob comment, three comment blocks in `backend/src/routes/accreditation.ts` (catch block, Redis-unavailable branch, attemptId declaration), `backend/src/routes/admin.ts` file header, `backend/tests/lib/pending-decrement-queue.test.ts` header, `backend/tests/routes/accreditation.test.ts` describe block (and its "Round-3 hold #10" sub-comment), `backend/tests/routes/admin.test.ts` header. Each replaced with behavioral anchors (route handlers, invariants, stable symbols).
- **Item 4.** New 500-branch spec added to `tests/routes/admin.test.ts`: stubs `redis.getdel` to reject, asserts `INTERNAL_ERROR` envelope + the renamed `accreditation.admin.reset_broadcast_counter_failed` discriminator.
- **Item 5.** `tests/routes/admin.test.ts` header extended with explicit clause (a) cryptographic-bypass acknowledgement + focus justification, and clause (c) names the real-path companion at `backend/tests/middleware/verifyHiveSignature-authmethod.test.ts`.
- **Item 6.** `redis.get(key)` + `redis.del(key)` replaced with atomic `redis.getdel(key)` in the admin reset route. ioredis 5.10.1 exposes `getdel` directly (verified against `node_modules/ioredis/built/utils/RedisCommander.d.ts`).
- **Item 7.** `res.set('Retry-After', '30')` added on the admin reset 503 branch; the 503 spec asserts `res.headers['retry-after']` is `'30'`.

Convention-enforcing-fix audit (per `convention-enforcing-fix-must-audit-its-own-new-code-2026-05-17.md`): the rewritten comments and test descriptions across item 3 anchor on behavioral semantics, route handler paths, and stable symbols. No line numbers, no SHAs, no task slugs, no round-N markers in the replacement prose. Spot-checked each of the 8 affected files.

The `[TODO Architect]` markers in this task file for `agents/docs/api-contracts/accreditation.md` (admin endpoint contract row) and `agents/docs/solutions/conventions/chain-write-timeout-ambiguous-outcome-2026-04-22.md` (manual-reset runbook section) remain from round 1 — architect-zone.

### Verification

- `npm run typecheck` (backend): clean.
- `npm run lint` (backend): clean.
- `npx vitest run tests/routes/admin.test.ts tests/lib/pending-decrement-queue.test.ts`: 16/16 pass.
- `npx vitest run tests/routes/accreditation.test.ts`: 26 pass, 7 fail. All 7 failures pre-exist on `main` with this commit reverted — they are unrelated to this work (free-email-provider 500, yahoo 500, round-4 hold #2 503-vs-502 already flagged in parent instructions, two SMTP-shape `BE-LOG-SHAPE-CONVERGENCE` specs, two `BE-ACCRED-REQ-LIMITER` specs). All 14 `BE-VERIFY-BROADCAST-ATTEMPTS-CAP` specs including the three flap-recovery specs from round 1 pass.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>

---

## Architect re-review (2026-05-19, round-2 → round-3) — HELD PENDING FIXES

`/ce-code-review` on commit `a678463` (the 7-item round-2 hold-block fixes — 11 reviewers, `ce-agent-native-reviewer` skipped per PEvO CLAUDE.md). All 7 hold items land in intent: `broadcastAttemptsKey` is exported and consumed via import in `admin.ts`, the 8 log events are renamed to the canonical dotted-path form with test assertions following suit, the convention-enforcing-fix self-audit on the sweep sites checks out, the 500-branch spec is added to `admin.test.ts`, the carve-out clauses (a)+(c) are documented, `redis.getdel` replaces the GET+DEL pair, and `Retry-After: 30` is set on the 503 branch with a test assertion.

Two items missed by the self-audit and one missed by item 1's deduplication intent warrant a small round-3 pass.

### Items held (must fix before archive)

**1. (P2, conf 100, correctness + learnings-researcher) Item 2's event rename left 4 comment cross-references citing the OLD flat-underscore names.** Three pre-existing comments at `backend/src/routes/accreditation.ts:124, 209, 223` and one `+`-line comment introduced by this commit itself at line 243 still reference the old names. Direct verification:

  ```
  L124: // `accred_verify_broadcast_decrement_redis_unavailable` warn: when ...
        (actual emit: accreditation.verify.broadcast_decrement_redis_unavailable)
  L209: // `accred_verify_broadcast_decrement_failed` warn (the route's ...
        (actual emit: accreditation.verify.broadcast_decrement_failed)
  L223: same as L209
  L243: same as L209 — this is a +line introduced by a678463
  ```

  The implementer's signal block claims "Spot-checked each of the 8 affected files" — the spot-check missed adjacent comment cross-references in the same file. Per `convention-enforcing-fix-must-audit-its-own-new-code-2026-05-17.md`, the rename should have caught these too (and the `+`-line at L243 is the exact failure mode that doc was written for: introducing a NEW citation in the same fix that was removing them).

  Suggested fix: replace each bare flat-underscore event name in the four comment sites with the dotted-path form. Mechanical search-and-replace on the specific bare names; the surrounding prose stays.

**2. (P3, conf 75, correctness residual) `backend/tests/lib/pending-decrement-queue.test.ts:23-25` still has a local `counterKey` helper that duplicates the `broadcastAttemptsKey` template literal, even though item 1 exported the canonical function for cross-route consumption.** `admin.test.ts` correctly imports `broadcastAttemptsKey` from `../src/routes/accreditation.js` and uses it directly; the queue test was missed. Today the strings are identical so no drift exists, but the single-source-of-truth intent of item 1 is only partially achieved while this duplicate remains.

  Suggested fix: at the top of `pending-decrement-queue.test.ts`, replace the local `counterKey` helper with an import: `import { broadcastAttemptsKey } from '../../src/routes/accreditation.js'`. Update the 1-2 call sites (currently calling `counterKey(token)`) to call `broadcastAttemptsKey(token)`. One-line import change + a small rename at call sites.

When items 1-2 land, `git mv` this file back to `tasks/review/`. Round-3 architect review scopes `/ce-code-review` to the round-3 commit only.

### Items dismissed during architect triage

- (adversarial adv-1) Operator audit-trail race on the admin reset 200 envelope's `prior_value` vs concurrent `/verify` INCR — landed as a documentation note in the architect-zone admin endpoint contract row. The race is irreducible without an admin-only token lock, which adds complexity disproportionate to the harm.
- (adversarial adv-2) `redis.getdel` requires Redis 6.2+ — PEvO ships Redis 7-alpine; the dependency floor is already higher. The 500 path covers the deployment-config-mismatch failure mode for AGPL forks that hit it.
- (adversarial adv-3) `decrementBroadcastAttempts` returns `'enqueued_for_drain'` even on queue overflow drops — failure mode requires sustained Redis outage AND queue depth ≥ cap (1000 entries) at PEvO single-instance scale; single-fire overflow warn still fires separately. Below the actionable bar.
- (testing T2 / maintainability M1) 503 admin warn discriminator `accreditation.admin.reset_broadcast_counter_redis_unavailable` not test-pinned — the 503 branch's behavioral contract (status, code, retriable, Retry-After: 30, counter unchanged) is fully covered; the warn event is observability-layer. Preemptive hardening per `feedback_dismiss_preemptive_test_hardening`.

### [TODO Architect] — landed at architect-zone cluster commit

- `agents/docs/api-contracts/accreditation.md` — `POST /api/admin/accreditation/reset-broadcast-counter` contract row landed in the architect-zone cluster commit.
- `agents/docs/solutions/conventions/chain-write-timeout-ambiguous-outcome-2026-04-22.md` — "Auto-recovery: in-process pending-decrement queue" + "Manual reset runbook" sections landed.
- `agents/docs/solutions/conventions/auth-structured-log-shape-2026-04-29.md` — `admin.ts` prefix added to the per-file prefix table.
