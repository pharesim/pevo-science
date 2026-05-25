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

---

## Architect re-review (2026-05-21) — HELD PENDING FIXES (round 1)

`/ce-code-review` on commit `d6e0e528` with 8 reviewers (correctness on Opus; testing, maintainability, project-standards, reliability, performance, learnings-researcher on Sonnet; ce-adversarial on Opus). `ce-agent-native-reviewer` skipped per project CLAUDE.md. After user triage: 8 items held below, 2 dismissed, 1 routed to a separate task.

Substantive helper landed correctly — the EVALSHA dispatch + NOSCRIPT-fallback shape, the `ready`-event SHA registration, and the two production callsite migrations all pass review. The hold items cluster into (a) test-mock surface labeling that didn't track the eval→evalsha retarget, (b) public-surface hygiene on the helper's exports, (c) ioredis-coupling documentation gaps, and (d) one pre-existing comment-anchor rot at a file the commit touched.

### Items to address

**1. (P1) `clearScriptShaCache()` and `getCachedSha()` exported from production module without `@internal` annotation.**

**Where:** `backend/src/lib/redis-scripts.ts` (the helper module). Two test-only exports sit on the module's public surface.

**Why:** Maintainability M1 (P1, conf 90) + adversarial ADV-004 (low, conf 55). Both helpers are called only from test code (`tests/lib/redis-scripts.test.ts beforeEach`/`afterAll`, `tests/setup.ts beforeAll`). Nothing in the production surface needs them. A future production import would silently degrade ALL `evalScript` calls to EVAL fallback (no log, no signal — the cache lookup just returns `undefined`). The docblock for `evalScript` mentions `clearScriptShaCache` only in passing; there's no `@internal` tag or naming convention that signals test-only intent to the next reader.

**Fix:** Add a `@internal` JSDoc tag to both `clearScriptShaCache` and `getCachedSha`. Optionally add a one-line note explaining they're test-only state pivot points (cache invalidation for tests; not a production reset API).

**2. (P1) Pre-existing task-slug+round-number rot at `backend/src/reputation-batch.ts:33-37` should be cleaned up while editing the adjacent line.**

**Where:** `backend/src/reputation-batch.ts:33-37`. Comment block reads `(BACKEND-REPUTATION-SSOT round-1 hold #24, round-2 hold #7)`.

**Why:** Maintainability M2 (P1, conf 85). Per `agents/docs/solutions/conventions/task-slug-citations-in-comments-go-stale-on-archive-2026-05-15.md`, task-slug citations rot when the task archives (eventually trims off the 250-line tasks-archive.md cap). The cited rounds and the BACKEND-REPUTATION-SSOT slug both become dead pointers. Commit `d6e0e528` touched the import block at line 40 (replacing `RELEASE_LOCK_IF_TOKEN_MATCHES_LUA` with `evalScript`) — the rot was directly adjacent and was the natural opportunity to fix.

**Fix:** Rewrite the comment block to anchor on stable symbols. The load-bearing claim is that the staging prefix must match across the Lua math, the TS writer, and the reader filter. Replace with something like: `// BATCH_KEY_PREFIX is the canonical prod prefix (\`${appTag}:reputation:batch:\`); STAGING_SEGMENT and the Lua substring math both derive from it so the staging-vs-prod swap cannot drift.` Drop the slug + round-number citations.

**3. (P2) `accreditation.test.ts` file header + test description + inline comment still name `redis.eval` after the spy was retargeted to `redis.evalsha`.**

**Where:** `backend/tests/routes/accreditation.test.ts:24, 32, 1006, 1008`.

**Why:** Three-reviewer cross-corroboration at conf 100 (testing T1 + maintainability M3 + project-standards PS-001). The commit retargeted the spy from `vi.spyOn(redis, 'eval')` to `vi.spyOn(redis, 'evalsha')` at line 1019+ but did not update the surrounding documentation:
- Line 24 mocked-surfaces list: `redis.eval`
- Line 32 (same list section): `redis.eval`
- Line 1006 test description: `pre-INCR redis.eval rejection surfaces 503 SERVICE_UNAVAILABLE`
- Line 1008 inline comment: `a redis.eval rejection`

Per CLAUDE.md "Running Tests" carve-out clause (a) — the test file header MUST document the justification explicitly, including which real path is impractical and why. Naming the wrong method breaks the carve-out's documentation requirement.

**Fix:** Update all four sites to say `redis.evalsha` (preserve all other clause-(a) justification text — only the method name changes).

**4. (P2) `isNoScriptError` couples to ioredis error-message format with no docstring naming the dependency.**

**Where:** `backend/src/lib/redis-scripts.ts isNoScriptError` (the `err.message.startsWith('NOSCRIPT')` check).

**Why:** Maintainability M5 (conf 75). The NOSCRIPT-recovery path is load-bearing — it's what makes EVALSHA safe across Redis FLUSHALL/restart cycles. The prefix-match couples to ioredis's specific behavior of surfacing Redis server errors with the exact `NOSCRIPT ...` prefix preserved. A major ioredis upgrade that changes how server errors are wrapped (e.g., a `ReplyError` with a different message shape) would silently break the NOSCRIPT path — `isNoScriptError` would return false, the error would propagate as if it were a non-NOSCRIPT failure, and post-FLUSHALL calls would start erroring instead of transparently recovering. The current test exercises this against the current ioredis behavior, so a version bump would pass tests until the first production FLUSHALL event.

**Fix:** Add a brief inline comment naming the ioredis behavior being relied on, so the dependency surfaces during future dependency upgrades. One sentence is enough — e.g., "Couples to ioredis's pass-through of Redis's `NOSCRIPT ...` prefix on server-reply errors; revisit at major ioredis upgrades."

**5. (P2) Docstring claims shared scripts MUST go through `evalScript` but `bridge.ts` + `orcid.ts` have known violations with no lint enforcement.**

**Where:** `backend/src/lib/redis-scripts.ts` module docblock (the line that reads "Direct `redis.eval` is reserved for ad-hoc one-off scripts that aren't worth registry membership; shared scripts MUST go through `evalScript`").

**Why:** Maintainability M4 (conf 75). The "ad-hoc" carve-out wording is arguably stretched by the existing Lua release scripts in `backend/src/bridge.ts` (`BRIDGE_RELEASE_LOCK_LUA`) and `backend/src/orcid.ts` (`RELEASE_LOCK_LUA`) — both implement the same lock-release CAS semantic as the now-registered `RELEASE_LOCK_IF_TOKEN_MATCHES`. The "MUST" is a normative claim with no lint backstop; the next maintainer adding a Lua script has no mechanical signal distinguishing "acceptable ad-hoc" from "required to register".

**Fix:** Soften "MUST" → "should" in the docblock and inline-document the known exceptions (`bridge.ts BRIDGE_RELEASE_LOCK_LUA`, `orcid.ts RELEASE_LOCK_LUA`) so the next maintainer doesn't read MUST as enforced policy. Migration of those two callsites is out-of-scope for this task; if the architect wants them migrated, a separate task is the right channel.

**6. (P3) Stale `redis.eval` reference in `accreditation.ts:980` comment after migration to `evalScript`.**

**Where:** `backend/src/routes/accreditation.ts:980` (comment in `incrementBroadcastAttempts`).

**Why:** Maintainability M3 (conf 80). The comment reads "so a redis.eval rejection (OOM, Lua error, connection drop) would propagate" after the call site was migrated to `evalScript`. The described behavior is still correct (`evalScript` propagates non-NOSCRIPT errors unchanged), but the named mechanism is wrong. A future developer searching for direct `redis.eval` usage gets a false-positive hit.

**Fix:** Replace `redis.eval` → `evalScript` in the comment text. One-word edit.

**7. (P3) `accreditation.test.ts:1141-1151` Redis-unavailable spec spies `redis.eval` after migration; auxiliary `not.toHaveBeenCalled` assertion is on the wrong method.**

**Where:** `backend/tests/routes/accreditation.test.ts:1141-1151`.

**Why:** Testing T2 (conf 70). The Redis-unavailable spec does `vi.spyOn(redis, 'eval')` then asserts `expect(evalSpy).not.toHaveBeenCalled()`. After the migration the production code dispatches via `evalsha` on the warm path; if the `isRedisAvailable()` short-circuit somehow failed, the negative assertion on `eval` would still pass — the auxiliary check is on the wrong method. The primary behavioral assertions (result value + warn check) still kill the mutation, so this is a polish item, not a regression.

**Fix:** Retarget the spy: `vi.spyOn(redis, 'evalsha')` and update the inline comment.

**8. (P3) `tests/setup.ts:23-25` comment anchors on redis.ts's fire-and-forget implementation detail rather than on the stable test-setup semantic.**

**Where:** `backend/tests/setup.ts:23-25`.

**Why:** Maintainability M6 (conf 65). The comment reads "The production `ready` handler fires `loadAllScripts` async without awaiting; tests that mock `evalsha`/`eval` need a warm SHA cache by assertion time, so block on it here." The first clause describes an implementation property of `redis.ts`'s ready handler. If that handler is later changed to await `loadAllScripts`, the setup.ts comment becomes misleading without the test behavior changing.

**Fix:** Reword to anchor on the test-setup invariant directly — e.g., "Ensure the SHA cache is warm before test assertions run, since the production-side load is asynchronous and tests that mock `evalsha`/`eval` need a deterministic warm state."

### Findings dismissed at triage (no action)

- **(reliability R1 + adversarial ADV-003, P2 conf 80)** `Promise.all` partial-failure silent. Per memory `feedback_pevo_logging_minimal` defaults. Partial state self-heals on next reconnect; cold entries fall back to EVAL (safe). Dismissed.
- **(testing TG1 + correctness residual)** `SHARED_SCRIPTS` exhaustive-key assertion missing. Preemptive per `feedback_dismiss_preemptive_test_hardening`; registry has 2 entries today, gap is structural-only.

### Items routed to separate task

- **(reliability R2, P2 conf 75)** NOSCRIPT-recovery `SCRIPT LOAD` has no `commandTimeout`. A stalled LOAD hangs the accreditation HTTP request indefinitely (`maxRetriesPerRequest: 3` only bounds connection-level retry, not per-command). Pre-existing scope at the ioredis-client constructor in `redis.ts` — not introduced by this commit, broader scope than evalsha helper. Filed as separate task `backend-redis-command-timeout` in `tasks/pending/`.

### Re-review signal

When items 1, 2, 3, 4, 5, 6, 7, 8 land, `git mv` this file from `tasks/pending/` back to `tasks/review/` per `feedback_task_mv_to_review_after_each_round`. Use bare `backend:` or `backend(<scope>):` commit prefixes so the zone-audit hook fires. Items 3, 6, 7 touch the same accreditation route+test pair — bundle. Items 1, 4, 5 touch the same `lib/redis-scripts.ts` docblock — bundle. Item 2 touches `reputation-batch.ts` independently. Item 8 touches `tests/setup.ts` independently.

---

## Backend re-review signal (2026-05-25, working tree)

Round-1 hold items 1-8 landed, plus one discovered fix (item 9) approved by the user mid-round.

### Item 1 — `@internal` on `getCachedSha` + `clearScriptShaCache`

Both test-only exports in `backend/src/lib/redis-scripts.ts` now carry `@internal` JSDoc. `getCachedSha`: notes production reads the cache through `evalScript`. `clearScriptShaCache`: notes a production caller would silently degrade every `evalScript` call to the EVAL fallback with no signal.

### Item 2 — slug+round rot rewritten in `reputation-batch.ts`

The `(BACKEND-REPUTATION-SSOT round-1 hold #24, round-2 hold #7)` citation on the `BATCH_KEY_PREFIX`-derivation comment was rewritten to anchor on the stable invariant (the Lua substring math, TS writer, and `getBatchReputationMap` reader filter all derive from one prefix so the staging-vs-prod swap cannot drift). NOTE scope: this fixes only the adjacent block the evalsha commit touched. Other `BACKEND-REPUTATION-SSOT round-N hold #M` citations elsewhere in `reputation-batch.ts` are pre-existing rot left for the dedicated `backend-anchor-rot-sweep-2026-05-21` umbrella task, per item 2's stated scope.

### Item 3 — `redis.eval` → `redis.evalsha` in accreditation.test.ts docs

Header mocked-surfaces list and the 503-cap spec description + leading comment now say `redis.evalsha` (the warm-path dispatch evalScript uses). Adjacent same-block refs ("cap-counter eval" → "cap-counter dispatch via evalScript"; "drives the eval rejection path" → "evalsha rejection path") updated for consistency per the audit-own-replacement convention.

### Item 4 — `isNoScriptError` ioredis-coupling comment

Added an inline comment naming the dependency: couples to ioredis passing Redis's server-reply error through with its `NOSCRIPT ...` prefix intact; a major ioredis upgrade rewrapping server errors would silently break the NOSCRIPT-recovery retry — revisit at ioredis upgrades.

### Item 5 — "MUST" → "should" + documented exceptions

Softened the module docblock's normative claim and documented the two known unmigrated lock-release CAS scripts that still call `redis.eval` directly: `routes/orcid.ts` RELEASE_LOCK_LUA and `routes/bridge.ts` BRIDGE_RELEASE_LOCK_LUA. (Verified both exist via grep — the architect's hold cited `bridge.ts`/`orcid.ts`; the actual paths are `routes/bridge.ts`/`routes/orcid.ts`. `reputation-batch.ts` CYCLE_SWAP_LUA is genuinely ad-hoc, not a violation, so it is not listed.) Migrating the two is left to a separate task.

### Item 6 — stale `redis.eval` → `evalScript` in accreditation.ts comment

The `incrementBroadcastAttempts` comment now says "an `evalScript` rejection" (the call site dispatches via `evalScript`, not direct `redis.eval`).

### Item 7 — Redis-unavailable spec spy retargeted eval → evalsha

`vi.spyOn(redis, 'eval')` → `vi.spyOn(redis, 'evalsha')` in the Redis-unavailable spec, with the comment updated to note `isRedisAvailable()` short-circuits before `evalScript` would dispatch.

### Item 8 — `tests/setup.ts` comment anchored on the invariant

Reworded to anchor on the test-setup invariant ("block until the SHA cache is warm before any test runs; the production-side load is asynchronous") instead of `redis.ts`'s fire-and-forget `ready`-handler implementation detail.

### Item 9 (DISCOVERED — user-approved) — 503-cap spec was failing on clean HEAD

While verifying item 3/6/7, the `pre-INCR ... rejection surfaces 503` spec was found RED on clean HEAD (confirmed by stashing all round-2 changes and running the file alone: 1 failed | 32 passed). Root cause: this commit's own eval→evalsha migration (`d6e0e528`) means the `/verify` limiter (`RATE_LIMIT_CHECK_AND_CONSUME`, also dispatched via `evalScript` → `evalsha`) runs BEFORE the cap-INCR and consumed the spec's `mockRejectedValueOnce`, so the intended cap-INCR rejection never fired — the broadcast was reached and the route returned 502 instead of 503.

Fix (user chose "fix the spec too"): replaced the order-dependent `mockRejectedValueOnce` with a discriminator mock on BOTH `redis.eval` and `redis.evalsha` that rejects ONLY the cap-INCR call (matched by the broadcast-attempts counter key at arg index 2) and passes every other script — including the limiter's — through to real Redis. Mocking both dispatch verbs makes the spec robust to SHA-cache warmth (a sibling spec's `vi.resetModules()` can leave the cache cold, selecting the EVAL path). The `toHaveBeenCalledTimes(1)` assertion was replaced with a counter-key filter across both spies asserting the cap-INCR was attempted exactly once. Full file: 33 passed (was 32 + 1 fail); isolated `-t "rejection surfaces 503"`: passes.

### Verification

- `npm run typecheck` (src + tests) — clean.
- `npm run lint` — clean (only the pre-existing unrelated `author-supersession.ts` warning).
- `npx vitest run tests/lib/redis-scripts.test.ts` — 6 passed.
- `npx vitest run tests/routes/accreditation.test.ts` — 33 passed (the previously-red 503-cap spec now green).

### Files changed (this round)

- `backend/src/lib/redis-scripts.ts` — items 1, 4, 5.
- `backend/src/reputation-batch.ts` — item 2 (comment-only).
- `backend/src/routes/accreditation.ts` — item 6 (comment-only).
- `backend/tests/routes/accreditation.test.ts` — items 3, 7 (doc/spy) + item 9 (503-cap spec fix).
- `backend/tests/setup.ts` — item 8 (comment-only).

## Architect re-review (round 2, 2026-05-25) — HELD PENDING FIXES:

`/ce-code-review` of round-1 hold-fix commit `cb3811e2` came back essentially clean. Items 1-9 are all genuinely resolved — the item-9 discriminator-mock fix was verified in detail: `args[2]` is reliably the first key for both scripts on the `/verify` path (each has exactly one key), `realEval`/`realEvalsha` are `.bind()`'d before `vi.spyOn` installs the mocks (no recursion), the injected `Lua error: OOM...` is not a NOSCRIPT error so there is no re-LOAD retry double-count, and both spies are restored in `finally`. Item-5's documented exceptions check out (`routes/orcid.ts RELEASE_LOCK_LUA`, `routes/bridge.ts BRIDGE_RELEASE_LOCK_LUA` both exist and call `redis.eval` directly); item-2's rewrite drops the slug+round citation without introducing new anchor rot. One item held:

1. **Test header docblock drift introduced by this commit.** The file-header "Per-test ... rejection mocks" / "Mocked surfaces" section of `backend/tests/routes/accreditation.test.ts` was renamed `redis.eval` → `redis.evalsha` (item 3) but was not reconciled with item 9's change to the same spec. The header still says the specs use `vi.spyOn(redis, '<verb>').mockRejectedValueOnce(...)` for one call, lists only `redis.evalsha` for the pre-INCR 503 path, and asserts "the carve-outs are narrow: only the named verb is mocked, only on that one call." The pre-INCR 503 spec now mocks BOTH `redis.eval` AND `redis.evalsha` via a persistent key-discriminating `mockImplementation` (rejects only the cap-INCR dispatch, keyed on the broadcast-attempts counter key; delegates every other dispatch — including the `/verify` limiter's own script — to real Redis), not a single-verb `mockRejectedValueOnce`. This is doc-vs-code drift this commit introduced, and it erodes the carve-out clause-(a) documentation the project requires to be accurate (root CLAUDE.md "Running Tests"): a maintainer trusting the header could revert to a blanket single-verb reject and reintroduce the exact item-9 bug (the limiter, which dispatches via `evalScript` and runs before the cap-INCR, consuming the cap-INCR's rejection). Fix: update the mocked-surfaces section to describe the dual-verb discriminator `mockImplementation` shape used by the pre-INCR 503 path, and adjust the "only the named verb / only that one call" wording, which no longer holds for that spec. Anchor the description on the dispatch-discrimination behavior — do not cite line numbers, a round number, or this task's slug.

When item 1 lands, `git mv` this file from `tasks/pending/` back to `tasks/review/` per the re-review handoff convention. Use a bare `backend:` / `backend(<scope>):` commit prefix so the zone-audit hook fires.

---

## Backend re-review signal (2026-05-25, branch HEAD)

Round-2 hold item 1 landed.

**Item 1 — test header docblock reconciled with the dual-verb 503 mock.** `backend/tests/routes/accreditation.test.ts` file header. Rewrote the per-test Redis-rejection-mocks section to describe TWO shapes: (a) the single-verb `vi.spyOn(redis, '<verb>').mockRejectedValueOnce(...)` mocks (`redis.del` cleanup-branch, `redis.decr` decrement-failure path), unchanged; and (b) the pre-INCR 503 path's dual-verb key-discriminating `mockImplementation` on BOTH `redis.eval` AND `redis.evalsha`, which rejects ONLY the cap-counter dispatch (discriminated by the broadcast-attempts counter key in the script args) and delegates every other dispatch — including the `/verify` limiter's own shared script — to a bound real-Redis call. The header now states why both verbs are mocked (`evalScript` selects `evalsha` warm / `eval` cold at runtime) and that discrimination is by counter key, not call ordinal (the limiter dispatches via `evalScript` and runs before the cap-counter INCR, so a blanket reject would be consumed by it). Removed the stale "only the named verb is mocked, only on that one call" universal claim and replaced it with shape-specific carve-out language. Audit-own-replacement clear: no line-number anchor, round-N marker, task-slug citation, or SHA in the rewrite.

**Verification:** `cd backend && npm run typecheck` clean; comment-only change to the test file header. Vitest run serially by the parent after the concurrent backend fan-out merges. Expected: `tests/routes/accreditation.test.ts` unaffected (header comment only, no spec/assertion change) — 33 passed.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
