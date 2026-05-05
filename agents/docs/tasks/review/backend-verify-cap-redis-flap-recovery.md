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
