# BACKEND-A1-EXTEND-LOCK-MISSING-EVENT-DISCRIMINATION — distinguish self-expire vs sibling-DEL vs Redis-eviction at lock-extension time

**Owner:** Backend Agent
**Created:** 2026-04-30 (architect, surfaced by cluster 2 task 1+2 round-3 review — reliability conf 80 + adversarial conf 60 cross-reviewer convergence)
**Priority:** P3

## Problem

The `extendBindingLockOnTimeoutOrLog` helper in `backend/src/routes/orcid.ts` fires `event: 'binding_lock_extend_lock_missing'` when `redis.expire(lockKey, 120)` returns 0. Three distinct operational causes collapse to this single signal:

1. **Self-expire** — the lock TTL (~35s) elapsed naturally before extension. This means HAF indexing-lag preamble (acquireLock → broadcast attempt → BroadcastTimeoutError → reach the extend call) ate the entire window. **Operator action: investigate Hive node latency / HAF backlog.**
2. **Sibling DEL** — a sibling process explicitly released the lock via `releaseBindingLock`'s Lua CAS. This shouldn't happen mid-broadcast (the sibling can't acquire the same orcid_id while we hold it, modulo same-tick contention which writes a different anchor). **Operator action: investigate the sibling's lifecycle; potential lock-helper bug.**
3. **Redis eviction** — Redis under memory pressure flushed the key via `allkeys-lru` or similar policy. **Operator action: investigate Redis memory + eviction policy; consider scale-up.**

The single `lock_missing` event tag can't discriminate between these. Operator gets the same signal for "HAF lag exceeded the bound" (a routine cause-of-day) vs "Redis is under memory pressure" (a serious infrastructure regression).

## Why now

- The branch is **operationally reachable** in normal traffic, not just exceptional. Adversarial review surfaced that DB/HAF preamble can consume the 5s headroom between the 35s lock TTL and the 30s broadcast timeout, so case (1) fires more often than the helper's design originally framed.
- Without discrimination, the event is forensic-only at best — operators can't page on case (3) (real infra incident) without false-paging on case (1) (routine).
- Cluster 2 task 1+2's `chain-write-timeout-ambiguous-outcome` convention demands that operator anchors enable cause discrimination at the dashboard layer; this anchor partially fails that bar.

## Goal

Add a structured field to the `lock_missing` event payload (or split into multiple event literals) that lets operator dashboards distinguish the three causes.

## Proposed shapes

### Option A — `cause:` discriminator field

Read `redis.pttl(lockKey)` immediately before `redis.expire(lockKey, 120)`. If the pttl read returns `-2` (key missing), capture that. After expire returns 0, log the captured pttl-state alongside:

- `cause: 'expired_or_evicted'` (pttl was -2 before expire — the key was already missing). Could still be either case 1 or case 3, but can't distinguish further with Redis primitives alone.
- `cause: 'released_by_sibling'` (pttl was a positive value before expire but expire returned 0 — race between pttl read and expire call; more likely a sibling DEL'd the key in the gap).

Cases (1) and (3) remain conflated in this shape; the dashboard can correlate (1)-vs-(3) via co-occurrence with `event:'haf_lag_high'` (if such an anchor exists) or with Redis memory metrics.

### Option B — separate event literals

Drop `lock_missing` as a single literal. Emit one of:

- `event: 'binding_lock_extend_already_expired'` — `redis.exists` before extend returned 0 AND there's no co-occurring sibling release log within the same request lifecycle.
- `event: 'binding_lock_extend_redis_evicted'` — separately attributable via Redis memory check at extend time (probe `INFO memory` evicted_keys counter; correlate spikes with this anchor).
- `event: 'binding_lock_extend_sibling_release'` — sibling release detected (rare; sibling shouldn't hold the same orcid_id during a broadcast).

Heavier but clearer per-cause dashboards.

### Recommendation

**Option A** is the lighter implementation. Option B requires Redis-side observability that PEvO doesn't have today (no Prometheus / Loki integration per cluster 2 task 1+2 agent-native review). Land Option A; revisit Option B if/when PEvO adds metric-based observability.

## Acceptance

1. **Read pttl before expire.** Inside `extendBindingLockOnTimeoutOrLog`, before `redis.expire(lockKey, EXTEND_TTL_SECONDS)`, do `const ttl = await redis.pttl(lockKey);` and capture the result.
2. **Add `cause:` field to the warn payload.** When `expire` returns 0, emit:
   - `cause: 'expired_or_evicted'` if `ttl === -2` (key missing at pttl-read time)
   - `cause: 'released_during_extend'` if `ttl > 0` at pttl-read time but `expire` returned 0 (race window between reads)
   - `cause: 'unknown'` for any other shape
3. **Test coverage.** Extend `tests/routes/orcid.test.ts`'s `binding_lock_extend_lock_missing` matrix to cover both shapes:
   - Lock seeded then DEL'd between pttl and expire (race window — exercise via spy ordering).
   - Lock never seeded (pttl returns -2 first call).
4. **Document in convention.** Append a note to `agents/docs/solutions/conventions/chain-write-timeout-ambiguous-outcome-2026-04-22.md` documenting the per-cause anchor shape so the next operator runbook can key on it.

## Out of scope

- Adding Redis memory observability infrastructure (Prometheus, Loki, dashboards). Track separately if/when PEvO adds metric infrastructure.
- Mitigating the underlying cause (extending TTL further, restructuring the helper to be cause-aware before extension). The fix is observational, not behavioral.
- Sibling-DEL race investigation. If case 2 fires in production, the lock-helper has a separate bug worth its own task.

## Source

`/ce-code-review` cluster 2 task 1+2 round-3 review (2026-04-29):
- reliability finding R5 (P3 conf 80): "binding_lock_extend_lock_missing event conflates self-expire vs eviction vs DEL" (originally surfaced as `a1_extend_lock_missing` pre-rename; renamed in commit `7387435` per BACKEND-ORCID-LOCK-TTL-EXTEND-ON-TIMEOUT round-3 hold)
- adversarial finding adv-3 (P3 conf 60): "branch is operationally reachable when DB/HAF preamble eats the 5s headroom"
- Cross-reviewer corroboration via cluster aggregation.

## Cross-references

- `agents/docs/solutions/conventions/chain-write-timeout-ambiguous-outcome-2026-04-22.md` — operator anchor convention this task extends.
- `backend/src/routes/orcid.ts` `extendBindingLockOnTimeoutOrLog` helper.
- `backend-orcid-lock-ttl-extend-on-timeout.md` (in `tasks/review/`) — predecessor; this task is a follow-up that doesn't block its archive.

---

## Backend implementer signal (2026-04-30, round-1 — initial implementation, working tree)

All four acceptance items landed.

### Item 1 — `pttl` probe before `expire`

`backend/src/routes/orcid.ts` `extendBindingLockOnTimeoutOrLog`. Added a `redis.pttl(lockKey)` call immediately before `redis.expire(lockKey, HAF_INDEXING_LAG_CEILING_SECONDS)`. The probe captures the lock's residual TTL state at the moment of the extend attempt; the value is then used as the `cause` discriminator on the `binding_lock_extend_lock_missing` branch. Both calls share the same `lockKey` local so a future rename of the key constructor doesn't drift between probe and extend.

The probe is best-effort: if `redis.pttl` itself throws (Redis flap mid-extend), the existing outer `catch (expireErr)` block at the bottom of the helper continues to fire `event: 'binding_lock_extend_threw'` — the new probe doesn't widen the failure surface, just adds a per-cause discriminator on the lock-missing branch.

### Item 2 — `cause:` field added to the lock-missing anchor

When `extended === 0` (lock key not found at extend time), the `logger.error` payload now carries:

- `cause: 'expired_or_evicted'` if `pttlBefore === -2` (key was already missing at probe time — collapses the self-expire-from-HAF-lag and Redis-eviction cases; dashboard correlates with HAF-lag and Redis-memory anchors when those exist).
- `cause: 'released_during_extend'` if `pttlBefore > 0` (key alive at probe but gone at extend — sibling `releaseBindingLock` Lua CAS DEL'd it in the gap; rare but operationally meaningful).
- `cause: 'unknown'` for any other shape (defensive default; should never fire under documented Redis primitives but pinned to make the discriminator total).

The `pttlBefore` raw value is also included in the structured payload so the operator dashboard can surface the underlying TTL number alongside the `cause` discriminator without recomputing.

### Item 3 — Test coverage

`backend/tests/routes/orcid.test.ts` — strengthened the existing `binding_lock_extend_lock_missing when the binding lock key is absent` spec to assert the structured `cause: 'expired_or_evicted'` + `pttlBefore: -2` shape under `expect.objectContaining` (so a regression dropping the discriminator surfaces as a test failure rather than silently degrading the anchor back to its conflated form).

Added a new spec, `cause=released_during_extend when pttl>0 but expire returns 0`, that drives the rare race window via `vi.spyOn(redis, 'pttl').mockResolvedValueOnce(30_000)` + `vi.spyOn(redis, 'expire').mockResolvedValueOnce(0)`. Asserts `cause: 'released_during_extend'` + `pttlBefore: 30_000`.

Mock carve-out is justified inline (cannot deterministically induce a co-running sibling DEL between the helper's two Redis calls against a single shared fixture). `verifyHiveSignature` and other middleware are NOT mocked — the spies are scoped to two specific `redis` methods on a single call each, with `mockRestore` in `finally`.

### Item 4 — `[TODO Architect]` for convention-doc note

`agents/docs/solutions/conventions/chain-write-timeout-ambiguous-outcome-2026-04-22.md` is in the architect zone (`agents/docs/solutions/` per the commit-msg `allowed_for_agent` map). Per backend CLAUDE.md "Boundaries", architect-owned doc edits land during the architect's review pass.

**[TODO Architect]** Append a paragraph to `agents/docs/solutions/conventions/chain-write-timeout-ambiguous-outcome-2026-04-22.md` documenting the `cause:` discriminator on the `binding_lock_extend_lock_missing` anchor:

> The `binding_lock_extend_lock_missing` operator anchor carries a `cause:` discriminator field with three values:
> - `'expired_or_evicted'` (probe found the key already missing) — collapses self-expire (HAF lag preamble exceeded the 35s lock window) and Redis eviction (memory pressure flushed the key). Operator separates these via co-occurrence with HAF-lag / Redis-memory anchors.
> - `'released_during_extend'` (probe found the key alive but expire returned 0) — sibling DEL'd the key in the gap. Rare; sibling shouldn't be holding the same `orcid_id` during a broadcast. If this fires in production, investigate the lock-helper's lifecycle.
> - `'unknown'` (defensive default) — should never fire under documented Redis primitives. If it does, file a backend task.
>
> Source: `BACKEND-A1-EXTEND-LOCK-MISSING-EVENT-DISCRIMINATION` round-1 (2026-04-30).

### Verification

- `npx tsc --noEmit` clean.
- `npm run lint` clean (only pre-existing `seed-phrase.ts` `any` warnings).
- `npx vitest run tests/routes/orcid.test.ts -t "extendBindingLockOnTimeoutOrLog"` → 8 pass / 57 skipped (4 modes × 2 surfaces; the new race-case spec is included in the count).
- Full backend vitest deferred to the parent agent's post-fan-out pass.

### Files changed

- `backend/src/routes/orcid.ts` — `pttl` probe + `cause` discriminator + `pttlBefore` field on the `binding_lock_extend_lock_missing` anchor.
- `backend/tests/routes/orcid.test.ts` — existing lock-missing spec strengthened with `cause: 'expired_or_evicted'` + `pttlBefore: -2` assertions; new `released_during_extend` race-window spec added.

### Out of scope (per task spec)

- Sibling-DEL race investigation (case 2 forensic) — separate task if production logs surface it.
- Adding Redis memory observability infrastructure (Prometheus, Loki) — tracked separately if/when PEvO adds metric infrastructure.
- Extending TTL further or restructuring the helper to be cause-aware before extension — the fix is observational, not behavioral, per the task's explicit out-of-scope clause.

---

## Architect re-review (2026-05-01, round-1 → round-2) — HELD PENDING FIXES

`/ce-code-review` ran on commit `1aa2382` with 5 personas (correctness, testing, reliability, agent-native, project-standards). The 3-way `cause:` discriminator logic is correct against Redis PTTL semantics; the strengthened lock-absent spec and the new race-window spec both pin their respective branches via `expect.objectContaining`; mock carve-out is scoped (only `redis.pttl` + `redis.expire`, single calls each, `mockRestore` in `finally`, `verifyHiveSignature` unmocked); zone-audit + commit subject + Co-Authored-By trailer all pass. Two cross-reviewer findings need to land before archive.

Architect refreshed the task body in this same review pass to use the renamed `binding_lock_extend_*` literals (per the [TODO Architect] handoff from `BACKEND-ORCID-LOCK-TTL-EXTEND-ON-TIMEOUT` round-3 hold). The task body's framing is now consistent with the implementation.

### Items to address

**1. (P1, conf 100 — testing T01 + reliability gap convergence) `redis.pttl` throw path is uncovered.** The implementer's commit message asserts: "best-effort: if `redis.pttl` itself throws, the existing outer catch continues to fire `event: 'binding_lock_extend_threw'` — the new probe doesn't widen the failure surface." Production code at `backend/src/routes/orcid.ts:1018-1029` does cover this (the outer `catch (expireErr)` block fires regardless of whether `pttl` or `expire` rejected). But the existing `binding_lock_extend_threw` spec at `tests/routes/orcid.test.ts:1942` only stubs `redis.expire` to reject — it doesn't exercise the pttl-throw path. A refactor that wraps `pttl` in its own try/catch (silently swallowing the rejection and falling through to `expire`) would break the implementer's invariant without surfacing as a test failure. Add a sibling spec mirroring the `expire`-throw shape but stubbing `redis.pttl` to reject; assert `event: 'binding_lock_extend_threw'` fires with the documented payload.

**2. (P2, conf 100 — testing T02 + project-standards residual convergence) Test-file header docblock not updated to enumerate the new `redis.pttl` / `redis.expire` spy pattern.** Per CLAUDE.md "Running Tests" carve-out clauses (a)/(b)/(c), the test file header at `tests/routes/orcid.test.ts:8-44` should document each mock pattern in use. The header currently covers DB pools, `broadcastJsonMock`, round-2 broadcast-throw additions, and the `verifyHiveSignature` wrapper — but not the new `vi.spyOn(redis, 'pttl')` / `vi.spyOn(redis, 'expire')` shape introduced by this commit. The new spec's inline justification at lines 2061-2070 references the header (`see tests/routes/orcid.test.ts header`), creating a dangling pointer. Append a paragraph to the header documenting the new pattern: which real path is impractical (cannot deterministically induce a co-running sibling DEL between the helper's two Redis calls against a single shared fixture), why the mock is justified (spies scoped to two specific methods on single calls each, `mockRestore` in `finally`, middleware not mocked), and that real-Redis sibling coverage exists (the strengthened lock-absent spec exercises real Redis for the `expired_or_evicted` branch).

### Items dismissed during architect triage

- **`cause: 'unknown'` branch uncovered** (testing T03 P2 conf 75 + correctness residual conf 25 + reliability gap conf 50). Branch is dead-defensive: `pttlBefore === -1` is unreachable (acquireBindingLock uses `SET ... NX EX`, so any live lock has a TTL); `pttlBefore === 0` is theoretically possible but operationally indistinguishable from `'expired_or_evicted'`. Defensive-default carve-out per established convention; no test required for an unreachable branch.
- **Eviction-vs-sibling-DEL false classification** (reliability residual conf 60). If Redis evicts the lock key in the microsecond window between pttl probe and expire call, the discriminator routes the eviction to `'released_during_extend'` (sibling DEL) instead of `'expired_or_evicted'`. Atomic Lua `PTTL+EXPIRE` would close the gap, but the task spec explicitly chose Option A (two round-trips). Operationally minor; flag for the operator runbook so dashboards don't over-index on a single `'released_during_extend'` as evidence of a sibling-DEL regression. Roll into the convention-doc paragraph below.
- **`pttlBefore === -1` silently routed to `'unknown'`** (reliability conf 55). Per acquireBindingLock's `SET ... NX EX`, this should be unreachable. If it ever fires, it indicates a real lock-acquisition bug — `'unknown'` is an acceptable signal to the operator that something off-spec happened.
- **Cross-call ordering not asserted** (reliability conf 45). `mockResolvedValueOnce` queue assumption is cosmetic. Below confidence gate.
- **Adjacent `cacheOrcidBinding` error log lacks `event:` key** (agent-native AN-3 conf 50). Out of scope for this commit; pre-existing observability-hygiene gap. File separately if/when an event-anchor sweep across all orcid.ts log lines runs.

### Architect-side residuals (deferred to separate sweep)

- **[TODO Architect] convention-doc paragraph** in `agents/docs/solutions/conventions/chain-write-timeout-ambiguous-outcome-2026-04-22.md` documenting the `cause:` discriminator on the `binding_lock_extend_lock_missing` anchor (the implementer wrote the suggested prose in the round-1 signal block above). Architect-zone work; defer to a separate convention-doc sweep alongside the broader event-anchor convention rollup landing across the broadcast-error file family. Roll the eviction-vs-DEL classification caveat into the same paragraph (per agent-native AN-1 + reliability residual conf 60).

### Re-review signal

When items 1-2 land, `git mv` this file back to `tasks/review/`. Round-2 architect review scopes `/ce-code-review` to the round-2 commit.
