# BACKEND-REDIS-SCRIPT-EVALSHA-OPTIMIZATION — SCRIPT LOAD + EVALSHA pattern for project-wide Lua scripts

**Owner:** Backend Agent
**Created:** 2026-05-04 (architect, surfaced by δ `/ce-code-review` cluster B)
**Priority:** P3 (perf)

## Why now

δ round-3 introduced `backend/src/lib/redis-scripts.ts` centralizing shared Lua scripts. Currently `INCR_AND_EXPIRE_IF_FIRST_LUA` is sent as the full script body via `redis.eval(SCRIPT_BODY, ...)` on EVERY `/api/accreditation/verify` call. ioredis does NOT cache or use EVALSHA automatically. At current beta scale this is ~80B wire overhead per call — negligible. As more Lua scripts land (likely if project pattern continues) and traffic grows, the overhead compounds.

Standard ioredis pattern: SCRIPT LOAD on startup → EVALSHA with NOSCRIPT fallback to EVAL.

## Goal

Project-wide pattern: every shared Lua script in `lib/redis-scripts.ts` is SCRIPT LOAD'd on Redis-connect; runtime call sites use EVALSHA with NOSCRIPT-fallback wrapper.

## Acceptance

### 1. Script registration on startup

In `backend/src/redis.ts` (or wherever Redis connection lives), on `connect` event:
- For each script in `lib/redis-scripts.ts`, call `redis.script('LOAD', SCRIPT_BODY)` and store the returned SHA in a map keyed on script-name.
- Re-load on reconnect (Redis SCRIPTS are wiped on FLUSHALL or restart).

### 2. `evalScript` helper

Add `backend/src/lib/redis-scripts.ts`:
```ts
export async function evalScript(
  redis: Redis,
  scriptName: keyof typeof SHARED_SCRIPTS,
  keys: string[],
  args: string[]
): Promise<unknown> {
  const sha = scriptShaCache.get(scriptName);
  if (!sha) {
    return redis.eval(SHARED_SCRIPTS[scriptName], keys.length, ...keys, ...args);
  }
  try {
    return await redis.evalsha(sha, keys.length, ...keys, ...args);
  } catch (err) {
    if (isNoScriptError(err)) {
      const reloadedSha = await redis.script('LOAD', SHARED_SCRIPTS[scriptName]);
      scriptShaCache.set(scriptName, reloadedSha);
      return redis.evalsha(reloadedSha, keys.length, ...keys, ...args);
    }
    throw err;
  }
}
```

Call sites (currently `routes/accreditation.ts incrementBroadcastAttempts`) migrate from `redis.eval(...)` to `evalScript('INCR_AND_EXPIRE_ON_ZERO_TO_ONE', ...)`.

### 3. Tests

- `evalScript` uses cached SHA when available; falls back to EVAL on cache miss.
- NOSCRIPT error triggers re-LOAD + retry.
- Other errors propagate unchanged.
- Migrate existing `INCR_AND_EXPIRE` test to use `evalScript`.

### 4. Document

Update the docblock in `lib/redis-scripts.ts` to document the helper + when to use direct `redis.eval` vs `evalScript` (always `evalScript` for shared scripts; direct `redis.eval` reserved for one-off ad-hoc scripts which should be rare).

## Out of scope

- Migrating ad-hoc `redis.eval` calls outside `lib/redis-scripts.ts` (there shouldn't be any; survey first).
- Generic Lua-script bundler / build-time SHA precomputation. SCRIPT LOAD on startup is sufficient.
- Performance benchmarking. The optimization is structural; perf gain at current scale is theoretical.

## Coordination

- **δ's hold-block:** δ round-4 doesn't depend on this task. Once δ archives, this task is independent.
- **Pairs with future Lua scripts:** when a second shared Lua script lands, it should be added via this task's pattern. If this task hasn't landed, add a [TODO] note in the new script's docblock.

## Source

- δ `/ce-code-review` (cluster B, 2026-05-04): reliability R-3 (perf only at current scale; structural improvement).

## Cross-references

- `backend/src/lib/redis-scripts.ts` — created in δ round-3 (commit `e4f822a`).
- ioredis docs: SCRIPT LOAD + EVALSHA pattern.

---

## Wave-1 attempt aborted (2026-05-04, backend orchestrator)

Worker subagent `agent-a9bff802c28f9c919` produced commit `57963fd` on its worktree branch, but the worktree was based on stale commit `2616cc1` (36 commits behind `main` at fan-out time, parent commit per `git log --format='%P' -1 57963fd`). Two intervening changes on `main` between `2616cc1` and current HEAD:

1. **δ round-3 renamed `INCR_AND_EXPIRE_IF_FIRST_LUA` → `INCR_AND_EXPIRE_ON_ZERO_TO_ONE_LUA`** in `backend/src/lib/redis-scripts.ts` (clarifies that EXPIRE re-fires on every transition from 0→1, not "first ever write to the key" semantics). Worker's commit uses the old name `INCR_AND_EXPIRE_IF_FIRST` as the SHARED_SCRIPTS key.
2. **Other accreditation.ts churn** in the same window (handleBroadcastError migration, broadcast-attempts cap, redaction tests) created additional content drift in the call site the worker migrated.

`git cherry-pick 57963fd` produced unresolvable-by-auto-merge conflicts in 3 files (`backend/src/lib/redis-scripts.ts`, `backend/src/routes/accreditation.ts`, `backend/tests/routes/accreditation.test.ts`) — the cherry-pick was aborted to avoid risk of mis-merge.

Worker's intent + helper module shape are sound and should be preserved on re-do. Required adjustments for the next attempt:
- Use the current name `INCR_AND_EXPIRE_ON_ZERO_TO_ONE_LUA` as the `SHARED_SCRIPTS` key (or drop the `_LUA` suffix to match the registry's other entries).
- Re-base from current `main` HEAD so the `accreditation.ts` call-site migration applies cleanly.
- The worktree at `.claude/worktrees/agent-a9bff802c28f9c919` (commit `57963fd`) is preserved for reference — read its `redis-scripts.ts`, `evalScript` helper shape, and test file as the design baseline; copy that structure onto current main.

Other wave-1 tasks (`backend-bridge-key-startup-validation-and-pino-redact`, `backend-canonical-root-walker-author-gate`, `backend-orcid-custody-default-invariant`) landed cleanly on main at `23bdae9`, `e2f7e1b`, `36b3f49` respectively and moved to `tasks/review/`.
