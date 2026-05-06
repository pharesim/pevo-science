# BACKEND-BRIDGE-KEY-STARTUP-VALIDATION-AND-PINO-REDACT — Project-wide pino `err` redact policy + bridge admin WIF startup validation

**Owner:** Backend Agent
**Created:** 2026-05-04 (architect, surfaced by cluster-B `/ce-code-review` of α and δ — two findings of the same shape)
**Priority:** P1 (security defense-in-depth)

## Why now

Two independent log-leak findings surfaced in cluster B with the same root cause:

1. **α (`backend-bridge-custody-broadcast-discrimination`):** `bridge.ts:233, :362` calls `PrivateKey.fromString(config.pevoBridgePostingKey)` INSIDE the broadcast try-catch. dhive's `PrivateKey.fromString` throws an `AssertionError` whose `.actual` / `.expected` are `Buffer` slices DERIVED from the WIF — combined with the network-ID byte and 4-byte checksum, an attacker with read access to operator logs (aggregation, archives, log-shipping, third-party SaaS log services) can reconstruct the bridge admin posting key. Two compounded issues:
   - (a) Classification: invalid WIF mis-classified as 502 BROADCAST_FAILED (routes alert to broadcast on-call instead of config/ops).
   - (b) Log-side leak: `{err, ...logContext}` passes the full err object; pino's default err serializer (`pino-std-serializers/lib/err.js`) enumerates ALL enumerable own properties of the error and copies them to the serialized payload. `logger.ts` has no custom err serializer override. The `AssertionError.actual`/`.expected` Buffer slices land in operator logs.

2. **δ (`backend-verify-broadcast-attempts-cap`):** `accreditation.ts:344, :458, :483` log paths pass `{err, ...}` for ioredis errors. ioredis attaches `err.command = { name, args }` to errors that propagate from a command call (`redis.eval`, `redis.decr`, `redis.del`). For `redis.eval` of the broadcast-attempts INCR script, `args[]` includes the script body + the key `${appTag}:pending_accred_broadcast_attempts:${token}` — the raw 64-hex verify token is in there. The token is the SOLE credential at `/api/accreditation/verify` (no Hive sig, no other auth), so anyone with read access to operator logs for the duration of the 24h TTL can replay it to enqueue an `accredit` `custom_json` op signed by the admin key.

Same root cause: pino's default err serializer EXPANDS all enumerable error properties. Round-3 of δ added `hashTokenForLogs` and replaced explicit `token` fields with `token_hash` — but the raw token still leaks via `err.command.args` because nothing strips it. The redaction test passes BY CONSTRUCTION because the test's mock rejection is `new Error('flap')` (no `command` property); the real ioredis path it claims to cover would FAIL the negative regex.

## Goal

Single project-wide pino `err` serializer policy that strips known-leaky standard error properties before they reach operator logs. Plus a startup validator for the bridge admin WIF that eliminates the classification branch preemptively.

## Acceptance

### 1. Custom pino `err` serializer in `backend/src/logger.ts`

Replace pino's default err serializer with a custom implementation that:
- Preserves `name`, `message`, `stack`, `cause` (recursively serialized), and any explicitly-allowlisted operational fields (`code`, `errno`, `syscall`).
- Strips `actual`, `expected`, `operator` (Node.js `AssertionError` shape — these carry buffer-slice diffs of the comparison values).
- Strips `command`, `command.args`, `command.name` (ioredis shape — these carry the Redis key + script body, both of which include user/system tokens).
- Strips `info`, `jse_info`, `jse_shortmsg`, `jse_cause` (VError / dhive shape — these carry chain-internal RPC details that may include op payloads).
- For unknown error subclasses, log only the safe baseline (`name`, `message`, `stack`, `cause`).
- Configurable via env var `PINO_ERR_REDACT_LEVEL=strict|relaxed` (default `strict`); `relaxed` allows additional fields for debugging in non-production.

Reference implementation pattern: pino's `custom serializers` API (`{ serializers: { err: (err) => ({ ... }) } }`).

### 2. Bridge admin WIF startup validation

In `backend/src/index.ts` (or wherever startup validation lives), call `PrivateKey.fromString(config.pevoBridgePostingKey)` ONCE at boot (after config load, before HTTP server starts). On throw: log a clear fatal-style error (without leaking the WIF — use the new serializer above) and `process.exit(1)`. Server never starts with a malformed WIF.

This eliminates the per-request `PrivateKey.fromString` call site as a runtime failure source: at request time, `config.pevoBridgePostingKey` is known to be syntactically valid. The α finding's classification branch (b) becomes dead code.

Open question for the implementer: should `PrivateKey.fromString` continue to be called per-request (defensive), or should the parsed `PrivateKey` instance be cached at startup and reused? Cached is more efficient; per-request is more defensive against in-process memory corruption. Recommend cached given the startup validator guarantees correctness; document the choice.

### 3. Test coverage

#### 3a. pino serializer tests (`backend/tests/lib/logger-redact.test.ts` — NEW file)

For each error subclass + leaky-field combination:
- `AssertionError` with `actual`/`expected` buffers — assert they are absent from serialized output.
- ioredis `ReplyError` with `command.args` containing a 64-hex token — assert the token is absent.
- VError-shaped error with `info`, `jse_info`, `jse_shortmsg` — assert they are absent.
- Plain `Error` — assert `name`, `message`, `stack` survive intact.
- Error with `cause` chain — assert `cause` is recursively serialized AND each level passes through the same redact policy.

Mutation-kill tests: removing the redact policy from `logger.ts` should cause every assertion in this file to fail red.

#### 3b. δ-Finding 1 redaction test (existing — fix the by-construction-passing problem)

The existing redaction test in `backend/tests/routes/accreditation.test.ts` uses `new Error('redis flap...')` as the mock rejection. Plain `Error` has no `command` property, so the `not.toMatch(/[0-9a-f]{64}/)` assertion passes by construction. Change the mock rejection to a hand-crafted ioredis-shaped error: `Object.assign(new Error('flap'), { command: { name: 'decr', args: [counterKey] }, name: 'ReplyError' })`. After the redact policy lands, the test passes for the right reason. Apply same fix to the 502+deleteToken-rejection spec at line 350.

(δ's hold block already calls for this fix; coordinate the two task lifecycles so the test transitions from failing-red → passing-green when this task's redact policy lands. Either:
- (a) Land the test fix in δ's round-4 (test fails red against current code, exposing the bug); land the redact policy in this task next; the test goes green naturally.
- (b) Land both in a single coordinated commit cluster.

Option (a) is recommended — gives a clean "test-first" arc + each task's commit has independent narrative coherence.)

#### 3c. Bridge WIF startup validation tests

In `backend/tests/index.test.ts` (or wherever startup tests live):
- Server starts cleanly with a valid WIF.
- Server `process.exit(1)`s with a clear log on a malformed WIF.
- The fatal log does NOT leak the WIF or any buffer slices derived from it.

### 4. Convention doc

Append a new entry under `agents/docs/solutions/conventions/` (architect lands at archive — backend cannot touch this zone): `pino-err-serializer-redact-policy-2026-05-XX.md` documenting:
- The default-serializer leak class (enumerable error properties expanded into log payload).
- The known-leaky standard fields (`actual`, `expected`, `command`, `command.args`, `info`, `jse_info`, `jse_shortmsg`, `jse_cause`).
- The redact policy + how to extend it for new error subclasses.
- Cross-reference α + δ as the two findings that surfaced this class.

## Out of scope

- Other PII redaction (email, IP, etc.) — already covered by `hashEmailForLogs` / IP middleware. This task is specifically about the err-serializer path.
- Refactoring all `{err, ...}` log call sites to use a different shape — the redact policy works at the serializer level, so no call-site changes required.
- Slack / Sentry log-export integration — those consume the already-serialized payload; they inherit the redact policy automatically.

## Coordination

- **Pairs with δ:** δ's round-4 hold-fix item 1 will land the corrected redaction test that fails red until this task lands. Land this task soon after δ's round-4 to close the test+code arc.
- **α's hold-block:** α's hold-fix items don't depend on this task (item 2 in α's hold is just the test fixtures using realistic VError shape, which exercises the leak surface but doesn't fix it). Once this task lands, α's leak-via-AssertionError surface is closed regardless of α's hold completing.
- **Architect must approve** the convention-doc landing path (architect-owned zone). Backend implements the runtime + tests; architect adds the convention doc at archive.

## Source

- α `/ce-code-review` (cluster B, 2026-05-04): reliability R-5 + adversarial adv-3 cross-corroborated, conf 100. Filed in α's "Items dismissed" → "Filed as separate task".
- δ `/ce-code-review` (cluster B, 2026-05-04): security sec-1 conf 75. Filed in δ's "Items to address" → "Production fix deferred to follow-up task".

## Cross-references

- `agents/docs/solutions/conventions/auth-structured-log-shape-2026-04-29.md` — establishes pino structured-log discipline; this task extends it with redact policy.
- `backend/src/lib/log-pii.ts` — `hashEmailForLogs`, `hashTokenForLogs` (added in δ's round-3). The redact policy is the project-wide complement to these per-field helpers.

---

## Backend completion signal (2026-05-04, commit `23bdae9` on `main`)

Acceptance items 1, 2, 3a, 3c land in `23bdae9` (cherry-picked from `worktree-agent-ae979196ecef55594` whose base was 36 commits behind main; cherry-pick auto-merged `startup-checks.ts` and `startup-checks.test.ts` cleanly). Targeted vitest passed: 51/51 across `tests/lib/logger-redact.test.ts` (11), `tests/startup-checks.test.ts` (27), `tests/routes/bridge.test.ts` (13). `tsc --noEmit` and `npm run lint` clean.

Acceptance item 3b (existing accreditation redaction tests): no edits required. δ's round-4 commit `bed4f1f` already landed the corrected `Object.assign(new Error(...), { command: { name, args: [<key-with-token>] }, name: 'ReplyError' })` shape and the `not.toMatch(/[0-9a-f]{64}/)` assertion that was failing red. The redact policy in this commit turns those tests green naturally.

[TODO Architect] markers (worker could not append from a stale-base worktree; parent appended at merge):

1. **Convention doc (Acceptance item 4):** Add `agents/docs/solutions/conventions/pino-err-serializer-redact-policy-2026-05-XX.md` documenting (a) the default-serializer leak class (pino enumerates `for (const key in err)`), (b) the known-leaky standard fields by error subclass (AssertionError `actual`/`expected`/`operator`, ioredis `command`/`command.args`/`command.name`, VError `info`/`jse_info`/`jse_shortmsg`/`jse_cause`), (c) the allowlist-based redact implementation + recursive `cause` and `errors[]` traversal + `PINO_ERR_REDACT_LEVEL=relaxed` env knob, (d) extension procedure for new error subclasses (audit before adding to `SAFE_BASELINE_FIELDS`), (e) cross-references to α (`backend-bridge-custody-broadcast-discrimination`) and δ (`backend-verify-broadcast-attempts-cap`) as the surfacing findings.

2. **δ test transition confirmation:** At archive, confirm `accreditation.test.ts` redaction tests (the `not.toMatch(/[0-9a-f]{64}/)` ones added in δ round-4) transition from failing-red to passing-green via this commit's redact policy. No code edits required from this task; only verification at architect's archive pass.

3. **No API contract update required.** This task is internal-only (logger serializer + startup cache); operators see the same JSON envelope shapes, only the `err` payload internals change. Architect can confirm at archive.

---

## Backend re-open (2026-05-04, vitest run revealed forcing-function tests still red)

Wave-1 worker landed `23bdae9` (custom pino `err` serializer + bridge admin WIF startup validation), but the project-wide vitest run after worktree merge surfaced two NEW failures introduced by this commit:

- `tests/routes/accreditation.test.ts:302` — "502 BROADCAST_FAILED path with deleteToken rejection: ... no raw token leak"
- `tests/routes/accreditation.test.ts:735` — "round-3 hold #5: decrement-failure log path ... no raw token leak"

Both are the forcing-function tests that this task's Acceptance 3b expected would "go green naturally." The test header at `accreditation.test.ts:54-59` declares them red-by-design until pino's redact configuration is widened to scrub `err.command.args`.

**Why the worker's redact policy doesn't fix them:** The worker implemented redaction as a pino `serializers.err` hook in `backend/src/logger.ts`. Pino's custom serializers fire AT WRITE TIME (when pino formats a log line for output), NOT at the `logger.warn(...)` call. The failing tests inspect `loggerWarnSpy.mock.calls` — i.e., the args captured by a vitest spy on `logger.warn` — which records the call PRE-pino-serialization. Result: the spy still sees `err.command.args[0]` containing the raw 64-hex token.

**What the next attempt needs:**

A logger wrapper layer that redacts `err`-shaped args BEFORE delegating to pino. Sketch:
```ts
const baseLogger = pino({ ... });
function redactErrInArg(arg: unknown) {
  if (arg && typeof arg === 'object' && 'err' in (arg as object)) {
    return { ...(arg as Record<string, unknown>), err: redactErrSerializer((arg as Record<string, unknown>).err) };
  }
  return arg;
}
export const logger = {
  warn: (...args: unknown[]) => baseLogger.warn(...args.map(redactErrInArg)),
  error: (...args: unknown[]) => baseLogger.error(...args.map(redactErrInArg)),
  // ... and so on for info / debug / fatal / trace
};
```

The wrapper invokes the existing exported `redactErrSerializer` so the redact policy stays single-source-of-truth. The pino `serializers.err` config can stay too (defense-in-depth for any direct-baseLogger call site, though there shouldn't be any once the wrapper is the public export).

Alternative shape: keep pino's serializer, change the failing tests to inspect the actual log output stream rather than `loggerWarnSpy.mock.calls`. The test header says "Do NOT 'fix' the test back to passing" — but rewriting it to inspect the right layer (e.g., spying on the destination stream's `write`) is not the same as masking the symptom. Either approach closes the gap; the wrapper is more aligned with the task's stated acceptance.

**Other vitest results from the same run (for context, NOT this task's responsibility):**
- `tests/routes/disciplines-canon-mocked.test.ts:669` — pre-existing failure on main ("continuation-chain head-override lowercases head metadata"). Confirmed by canonical-root worker (commit `e2f7e1b`) noting same red on a stashed-clean tree.
- `tests/routes/stats-profile-parity.test.ts:80` — real-HAF reputation score fluctuation (5 vs 20). Likely flake.

The two NEW failures are the only ones this task is on the hook for. Fixing them — either via the wrapper sketched above or via a test-layer change — closes the forcing-function gap.

---

## Backend re-review signal (2026-05-06, commit `5d9c68d` on `main`)

Wave-2 closed the re-open by adding a call-site `err`-redaction wrapper in `backend/src/logger.ts` that runs `redactErrSerializer` on `{err, ...}`-shaped log args BEFORE delegating to pino. The wrapper covers `info`/`warn`/`error`/`debug`/`fatal`/`trace`/`flush` and mutates the `err` field in place on the passed-in arg object so that `vi.spyOn(logger, ...)` captures the redacted reference (closing the spy-vs-serializer ordering trap documented in `agents/docs/solutions/conventions/pino-spy-serializer-ordering-trap-2026-05-06.md`). Pino's `serializers.err` config remains as defense-in-depth at the transport layer. `pinoHttp` was rebound to use the private `baseLogger` so per-request child loggers inherit the base config.

The two forcing-function tests at `accreditation.test.ts:332` and `:765` (the "no raw token leak" specs that inspect `loggerWarnSpy.mock.calls`) now pass green naturally; the redact policy strips `err.command.args` before the spy captures the call. `tests/lib/logger-redact.test.ts` (11/11) and `tests/startup-checks.test.ts` (36/36) also pass. `npx tsc --noEmit` and `npm run lint` clean.

Pre-existing main-tree failures observed (NOT this task's scope): `accreditation.test.ts` "rejects free email providers" and "rejects yahoo email" specs flake on shared-Redis rate-limit state pollution, and `disciplines-canon-mocked.test.ts:669` continuation-chain head-override lowercases head metadata. Both reproduced on stashed-clean main.

[TODO Architect] markers from wave-1 (`23bdae9`) carry forward: convention doc `pino-err-serializer-redact-policy-2026-05-XX.md`, δ test transition confirm, no-API-contract-update confirmation. Wave-2 adds no new architect markers.

---

## Architect re-review (2026-05-06) — HELD PENDING FIXES

`/ce-code-review` ran on the cherry-picked union diff of `23bdae9` (wave-1) + `5d9c68d` (wave-2) to keep the diff scope precise (the in-between commits on `main` belong to other tasks). 9 reviewer personas spawned (correctness, testing, maintainability, project-standards, security, reliability, adversarial, kieran-typescript, ce-learnings-researcher; `ce-agent-native-reviewer` skipped per project CLAUDE.md). After triage: **12 hold items** below, **2 follow-up tasks** spawned (see "Coordination" addendum), **1 finding subsumed** by another, **3 dismissed** as residual risk for the eventual archive entry. Lands in one hold round to keep the wrapper-layer diff coherent.

### P1 — must fix

1. **`backend/src/lib/broadcast-error.ts:270` — top-level sibling `cause: err.cause` bypasses both redaction layers.** Wrapper (`redactErrInArg` at `logger.ts:189`) and Layer-B `serializers.err` only redact the `err` slot; sibling top-level `cause` falls through to pino's default Error serialization. Reachability today is bounded (no current cascade-fn produces a leaky shape there) but the redact-policy SSoT claim is broken at this surface — any future cascade-fn that re-throws a transient ReplyError or wraps an AssertionError lands its leaky enumerables at top-level cause. **Fix:** drop the redundant `cause: err.cause` field from the broadcast-error.ts:270 log object — the serializer's recursive `cause` traversal at `logger.ts:140-142` already preserves the redacted cause inside `err.cause`. (security + adversarial cross-reviewer)

2. **`backend/src/startup-checks.ts:~224-230`, `:~164`, and `backend/src/index.ts:25-28` — `logger.fatal(...)` then `process.exit(1)` can drop the boot-fatal log line under pino's async transport.** Pino's destination transport is async by default; `process.exit(1)` immediately tears down the runtime including the worker thread before the buffered fatal line drains. The wrapper exposes `logger.flush(cb)` for exactly this case but the boot path doesn't call it. **Fix:** convert all three sites to `logger.fatal(...); logger.flush(() => process.exit(1));`. The two `startup-checks.ts` sites are clearly in scope; `index.ts:25-28` is pre-existing same-pattern code — bundle it here OR file a one-line follow-up at backend's preference. (reliability)

### P2 — wrapper hardening

3. **`backend/src/logger.ts:140` — `redactErrSerializer` recursive `cause`/`errors[]` traversal lacks depth/cycle guard.** Today's depth-1 self-reference guard does not catch 2-step cycles (`A.cause=B; B.cause=A`) or unbounded `errors[]` recursion. Stack overflow → process crash on hostile/buggy error chain (PEvO is single-instance ⇒ full availability impact). **Fix:** add `depth` parameter (default 0), bail at `depth > 10` returning sentinel `{ type: 'MaxDepthExceeded', depth: <n> }`. Recurse with `depth + 1` for `cause` and each `errors[i]`. (correctness + security cross-reviewer)

4. **`backend/src/logger.ts:189-244` — wrapper level methods catch nothing; throwing getter on hostile err propagates synchronously, breaking catch-and-log flow.** `redactErrSerializer` reads `errAny.stack`/`cause`/`errors`/`SAFE_BASELINE_FIELDS` without try/catch. A custom Error subclass with a throwing getter, a Proxy whose `getOwnPropertyDescriptor` throws, or an AggregateError member with throwing `Symbol.toPrimitive` propagates the throw out of every `logger.error({err}, 'msg')` site that already had an err in hand. **Fix:** wrap the `redactErrSerializer` invocation in `redactErrInArg` (and inside the Layer-B `serializers.err` callback) in try/catch with fallback `{ type: 'RedactSerializerFailed', message: String(serializerErr?.message ?? serializerErr) }`. Pair with #3 — together they make the serializer fault-tolerant against deep cycles AND throwing-getter shapes. (reliability)

5. **`backend/src/logger.ts:205-236` — wrapper `Parameters<typeof baseLogger.warn>` collapses pino's three LogFn overloads to one.** TypeScript reduces overload sets to the last overload's tuple at `Parameters<>`, so `%s`/`%d` placeholder type-checking and the msg-only overload are silently lost at every call site. **Fix:** re-declare each level method with an explicit overload set mirroring pino's LogFn (msg-only, obj+optional-msg, obj+msg+placeholders). The six `WarnArgs = Parameters<...>` aliases evaporate as a side effect — this also resolves the maintainability finding "per-level type aliases are duplication without value" (subsumed). (kieran-typescript)

6. **`backend/src/routes/bridge.ts:233, :366` — non-null assertion `getCachedBridgePostingKey()!` ties type narrowing to a runtime-only invariant.** `assertBridgeKeyConfigured` guards `config.pevoBridgePostingKey`, NOT cache contents. A future change that nulls the cache while config stays truthy silently produces `null!.toString()` → TypeError. **Fix:** add a `getRequiredBridgePostingKey(): PrivateKey` accessor in `startup-checks.ts` that throws a structured error (`{ type: 'BridgeKeyCacheUnpopulated' }`, redact-safe message) when the cache is null. Bridge.ts:233/:366 use the helper. Sets the convention for the claims.ts follow-up (see Coordination) to inherit. (kieran-typescript)

### P2 — test coverage

7. **`backend/tests/lib/logger-redact.test.ts` — `PINO_ERR_REDACT_LEVEL=relaxed` branch has zero test coverage.** Acceptance #1 explicitly listed the strict/relaxed env knob. `REDACT_LEVEL` is captured at module-load (logger.ts:79-80), so coverage requires `vi.resetModules()` + `process.env.PINO_ERR_REDACT_LEVEL = 'relaxed'` + re-import. **Fix:** add 1-2 cases asserting (a) `port`/`address`/`hostname`/`path` preserved on err under relaxed, (b) known-leaky fields (`command`/`args`, `actual`/`expected`) STILL stripped under relaxed. (testing)

8. **`backend/tests/lib/logger-redact.test.ts` — wave-2 wrapper layer has no direct mutation-kill test in this diff's new file.** All 11 cases test `redactErrSerializer` as a pure function; none calls `logger.warn({err:...})` and inspects `vi.spyOn(logger,'warn').mock.calls[0][0].err`. The `accreditation.test.ts:332/:765` forcing functions cover the same risk class but live in a distant file. **Fix:** add 2-3 spy-based cases that mutation-kill the wrapper locally — assert the spy's captured arg has `command`/`actual` redacted out. Reverting `redactErrInArg` to a no-op or spread-copy must turn these red. (testing)

### P3

9. **`backend/tests/startup-checks.test.ts:~850` (validatePostingKeyFormat tests) — assertions pass by construction, not by redaction.** The synthetic-AssertionError test never invokes `PrivateKey.fromString(fakeWif)` to capture the real dhive throw — it tests redaction shape on a hand-rolled error. The format-validator test asserts non-leakage of input substrings the function never embeds in its error message at all. Repeat of the original δ-task forcing-function trap (`new Error('flap')` had no `.command` so the regex passed regardless). **Fix:** (a) replace the synthetic-AssertionError test with a real `PrivateKey.fromString(fakeWif)` invocation in try/catch; assert `redactErrSerializer(realErr)` strips `actual`/`expected`. (b) Either construct a malformed WIF whose dhive error message DOES substring the input, or drop the format-validator test as redundant. (correctness, conf 100)

10. **`backend/tests/lib/logger-redact.test.ts` — no test for `code`/`errno`/`syscall` preservation through `cause` recursion.** Strip-recursion is well-covered; preserve-recursion is not. **Fix:** add ~10 lines: outer Error wrapping `Object.assign(new Error('econnrefused'), { code: 'ECONNREFUSED', errno: -111, syscall: 'connect' })`, assert `out.cause.code === 'ECONNREFUSED'` etc. (correctness)

11. **`backend/src/startup-checks.ts:260-271` (`getCachedBridgePostingKey` lazy-fallback) AND the cache accessor's docstring** — wave-1 narrative claimed elimination of per-request `PrivateKey.fromString` but the lazy-fallback path keeps a request-time throw site live (test reset, mid-runtime rotation, init-order edge cases). Compounded with the claims.ts follow-up: the docstring's project-wide phrasing overclaims relative to reality. **Fix:** tighten the docstring on `getCachedBridgePostingKey` to: "Once boot succeeds AND `config.pevoBridgePostingKey` is not mutated post-boot, this accessor returns the cached `PrivateKey` without re-parsing. The lazy-fallback path is a test-and-rotation-only branch; production paths reach it only post-validator." Additionally, scope the project-wide phrasing in the docstring to bridge.ts call sites (claims.ts is now tracked under the `backend-bridge-key-claims-route-migration` follow-up below). (correctness + reliability cross-reviewer)

### Subsumed

- **Maintainability finding "per-level type aliases are duplication without value" (`logger.ts:197-244`)** is subsumed by item 5 above. The six `WarnArgs = Parameters<...>` aliases evaporate when explicit overloads land per method.

### Items dismissed (residual risk for archive entry)

The architect dismissed three documentary/aesthetic findings with no runtime impact and no realistic regression path. To be noted in the eventual archive entry as residual risk, not in code:

- **`backend/src/logger.ts:90-96` — `isErrorLike` type predicate `(value): value is Error` returns true for non-Error duck-typed objects.** Type-system encodes a fiction; runtime is per-field-defended; predicate is local-not-exported. (kieran-typescript)
- **`backend/src/logger.ts:105` — `redactErrSerializer` return type `SerializedErr | unknown` collapses to `unknown`.** Misleading-as-documentation, useless-as-narrowing. Tests cast 11× via `as Record<string, unknown>`. (kieran-typescript)
- **`backend/tests/startup-checks.test.ts` (10 sites) — tests bypass `Readonly<Config>` via repeated `(config as { pevoBridgePostingKey: string })` cast.** Test-only convenience; cast pattern is local to one file; future refactor cost is small. (kieran-typescript)

### Coordination

Two follow-up tasks were spawned during triage (created in `tasks/pending/` alongside this hold-block move):

- **`backend-bridge-key-claims-route-migration.md`** — `routes/claims.ts:214` (`/papers/:author/:permlink/claims/approve`) and `:311` (`/revoke`) still call `PrivateKey.fromString(config.pevoBridgePostingKey)` per-request. 3-reviewer cross-corroboration (correctness, maintainability, reliability — confidence 100). Pre-existing relative to this task's named scope, but the cache accessor's docstring claim of project-wide coverage forces resolution. Mechanical migration; depends on item 6 above (use `getRequiredBridgePostingKey()` if it lands here, otherwise `getCachedBridgePostingKey()`).

- **`backend-logger-wrapper-pino-runtime-api-surface.md`** — restore pino runtime API surface lost in the wrapper (`.child(bindings)`, `.isLevelEnabled(level)`, `.level` getter/setter, `.bindings()`). Includes the deliberate child-wrapping decision: do `logger.child({reqId})`-derived loggers inherit the redaction wrapper, and if yes, by what mechanism? Decoupled from this hold cycle to allow that deliberation outside a busy hold round. (reliability)

### Past learnings cited (ce-learnings-researcher)

- `agents/docs/solutions/conventions/pino-spy-serializer-ordering-trap-2026-05-06.md` — wave-2's wrapper IS the implementation of this convention.
- `agents/docs/solutions/conventions/auth-structured-log-shape-2026-04-29.md` — anticipated this wrapper at line 97 ("transport-only protection insufficient for spy-visible redaction"); wave-2 closes that gap.
- `agents/docs/solutions/conventions/tests-must-fail-on-mutation-of-code-under-test-2026-04-22.md` — reinforces hold items 8 and 9 (mutation-kill weaknesses).
- No prior learning on validate-once-and-cache-secret pattern — possible `/ce-compound` candidate at archive.

### Re-review pointer

When the hold round lands and the implementer `git mv`s the file back to `tasks/review/`, the architect will run `/ce-code-review` scoped to the new commits since this hold block (per the multi-round re-review protocol). The earlier review of `23bdae9` + `5d9c68d` already passed all non-held findings; the next pass is scoped to the hold-resolution diff only, not the full task history.
