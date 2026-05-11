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

---

## Backend re-review signal (2026-05-06, round-3 hold-fixes — commit `1a7a3bb` on `main`, originally `87630e2` on `worktree-agent-a863721f5ecf62ee0`)

Round-3 closes 11 of 11 hold items in a single coordinated diff over `backend/src/{logger.ts,startup-checks.ts,index.ts,routes/bridge.ts,lib/broadcast-error.ts}` plus paired tests in `backend/tests/{lib/logger-redact.test.ts,startup-checks.test.ts,lib/broadcast-error.test.ts}`. Sibling worker (a different worktree) handles `routes/papers.ts`; this signal is for the logger/bridge-key cluster only.

### Item-by-item resolution

**P1**:
1. **`backend/src/lib/broadcast-error.ts:270`** — dropped the redundant `cause: err.cause` field from the `post_broadcast_write_failed` log object. The recursive `cause` traversal in `redactErrSerializer` (`logger.ts:165-171`) preserves the redacted cause inside `err.cause` of the serialized payload, which is the correct surface. Comment block at the call site documents the leak path closure ("any future cascade-fn that re-throws a transient ReplyError or wraps an AssertionError lands its leaky enumerables at top-level cause"). Paired test (`tests/lib/broadcast-error.test.ts:591` round-5 hold #1 spec) updated: now pins the absence of a top-level `cause` field via `expect(callArgs.cause).toBeUndefined()`. The companion `post_broadcast_msg_fn_threw` spec's narrative comment (`tests/lib/broadcast-error.test.ts:693-702`) updated to reflect the new contract.

2. **`backend/src/{startup-checks.ts,index.ts}`** — converted all 4 boot-fatal sites to `logger.fatal(...); logger.flush(() => process.exit(1));`:
   - `startup-checks.ts:163-166` — required-config-missing path (uses `logger.error` per the existing pattern; flush-then-exit applies regardless of level)
   - `startup-checks.ts:228-235` — `initBridgePostingKeyCache` parse-divergence fatal
   - `index.ts:30-37` — `uncaughtException` handler
   - `index.ts:38-41` — `unhandledRejection` handler
   - `index.ts:108-113` — `initAppDb().catch(...)` failure
   Each carries an inline comment explaining the async-transport-drain rationale so future refactors don't strip the flush.

**P2 — wrapper hardening**:

3. **`backend/src/logger.ts:124-179`** — added `depth` parameter (default 0) to `redactErrSerializer`; bails at `depth > 10` returning sentinel `{ type: 'MaxDepthExceeded', depth: <n> }`. Both recursion sites (`cause` at line 170 and `errors[]` map at line 175) pass `depth + 1`. Constant `MAX_CAUSE_DEPTH = 10` documented inline at line 87 with cycle/chain rationale. Two new tests in `tests/lib/logger-redact.test.ts` exercise (a) a 2-step `A.cause = B; B.cause = A` cycle, (b) a 50-deep linear chain — both assert the sentinel surfaces at depth ≤ 11 without crashing.

4. **`backend/src/logger.ts:202-213`** — new `safeRedactErr` wrapper that try/catches `redactErrSerializer` and returns sentinel `{ type: 'RedactSerializerFailed', message: String(...) }` on throw. Wired into both Layer A (`redactErrInArg` at `:267`) and Layer B (`baseLogger.serializers.err` at `:229`, `httpLogger.serializers.err` at `:352`). New test at `tests/lib/logger-redact.test.ts:391-410` exercises a throwing `stack` getter through `logger.warn({err: hostileErr})`; asserts no throw escapes the wrapper and the spy captures the sentinel shape.

5. **`backend/src/logger.ts:291-329`** — replaced the six `WarnArgs = Parameters<typeof baseLogger.warn>` aliases with a `makeLevelWrapper(method: LogFn): LogFn` factory. Each level is now declared as `LogFn` (pino's exported 3-overload type covering msg-only / obj+msg / obj+msg+placeholders), restoring the placeholder type-checking that `Parameters<>` collapsed away. The `.map()` is gone too; the wrapper mutates `args[0]` in place and forwards the unchanged tuple to `method.apply(baseLogger, args)`. The maintainability finding "per-level type aliases are duplication without value" evaporates as a side effect (per the architect's "subsumed" note).

6. **`backend/src/startup-checks.ts:264-296`** — added `BridgeKeyCacheUnpopulated` Error subclass and `getRequiredBridgePostingKey(): PrivateKey` accessor that throws it when the cache is null. `routes/bridge.ts:3,383-393` migrated to `getRequiredBridgePostingKey()` (only one bridge-route call site remains; the prior `:366` site was retired in `e647abb` when `POST /api/bridge/update` was removed). The `claims.ts:214,:311` call sites are scoped to the follow-up task `backend-bridge-key-claims-route-migration` per the architect's coordination note. Two new tests in `tests/startup-checks.test.ts:286-322` cover (a) populated-cache happy path, (b) null-cache throws `BridgeKeyCacheUnpopulated` with `out.type === 'BridgeKeyCacheUnpopulated'` after passing through `redactErrSerializer` (proves operator-alert keying survives the redact policy).

**P2 — test coverage**:

7. **`backend/tests/lib/logger-redact.test.ts:495-571`** — new `describe('PINO_ERR_REDACT_LEVEL=relaxed branch coverage ...')` block with 2 cases. Each uses `vi.resetModules()` + `process.env.PINO_ERR_REDACT_LEVEL = 'relaxed'` + dynamic `await import('../../src/logger.js')` to re-capture the module-load `REDACT_LEVEL`. Asserts (a) `port`/`address`/`hostname`/`path` preserved on err under relaxed AND `code` baseline still survives, (b) known-leaky fields (`command`, `actual`/`expected`, `operator`) STILL stripped under relaxed.

8. **`backend/tests/lib/logger-redact.test.ts:415-487`** — new `describe('logger wrapper layer — call-site redaction (round-3 hold #8)')` block with 3 spy-based mutation-kill cases. Each calls `logger.warn({err: <leaky-shape>}, 'msg')` with `vi.spyOn(logger, 'warn')` (no `mockImplementation` — passthrough spy so the wrapper's `redactErrInArg` runs), then inspects `warnSpy.mock.calls[0][0].err` for the redacted shape. Covers ReplyError command-strip, AssertionError actual/expected-strip, and a non-`{err}`-shaped passthrough.

**P3**:

9. **`backend/tests/startup-checks.test.ts:294-345`** — replaced the synthetic-AssertionError test with a real `PrivateKey.fromString('5J' + '1'.repeat(50))` invocation in try/catch. The empirically-determined fixture triggers dhive's internal `assert.deepStrictEqual` for `private key network id mismatch`, producing a real AssertionError with non-undefined `actual`/`expected` Buffer slices. Asserts the captured err is an AssertionError, that `actual`/`expected` are present pre-redaction, and that `redactErrSerializer(captured)` strips them post-redaction. The format-validator-input-leak test at the top of the same describe block was dropped as redundant — `validatePostingKeyFormat` interpolates only the env-var name and the dhive error class+message, neither of which substring the input bytes; a doc-block at the describe top documents the rationale.

10. **`backend/tests/lib/logger-redact.test.ts:295-313`** — new test "cause chain: code/errno/syscall preservation survives through cause recursion" with the architect-suggested fixture `Object.assign(new Error('econnrefused'), { code: 'ECONNREFUSED', errno: -111, syscall: 'connect' })`. Asserts `out.cause.code === 'ECONNREFUSED'`, `errno === -111`, `syscall === 'connect'`, and that the outer wrapper does NOT inherit those fields (they belong to the cause).

11. **`backend/src/startup-checks.ts:286-320`** — tightened the `getCachedBridgePostingKey` docstring per the architect's verbatim text: "Once boot succeeds AND `config.pevoBridgePostingKey` is not mutated post-boot, this accessor returns the cached `PrivateKey` without re-parsing. The lazy-fallback path is a test-and-rotation-only branch; production paths reach it only post-validator." Added explicit scoping note that the throw-site guarantee covers `bridge.ts` call sites only; `claims.ts` is tracked under the follow-up task. Cross-references the `getRequiredBridgePostingKey` accessor introduced in item 6.

### Mutation-kill attestation (per `tests-must-fail-on-mutation-of-code-under-test-2026-04-22.md`)

Each new canary was verified red against a stripped-down code change. The baseline file was restored after each verification.

- **Item 7 — relaxed branch coverage canary** (red on revert):
  - Strip the `if (REDACT_LEVEL === 'relaxed') { ... }` block in `logger.ts:156-163`. Result: `tests/lib/logger-redact.test.ts:514` "relaxed: preserves port/address/hostname/path on err" fails: `expected undefined to be 5432`.

- **Item 8 — wrapper-layer spy mutation-kill canary** (red on revert):
  - Replace `obj.err = safeRedactErr(obj.err);` in `redactErrInArg` (logger.ts:267) with `void obj;` (no-op). Result: 2 of 3 wrapper-layer cases fail (the ReplyError-command and AssertionError-actual/expected canaries); the non-{err}-shaped passthrough still passes (correctly — that case asserts the wrapper does NOT touch sibling fields).

- **Item 9 — real-`PrivateKey.fromString` AssertionError canary** (red on revert):
  - Replace the allowlist-copy block in `redactErrSerializer` with a denylist that copies all enumerable own properties (default pino behavior). Result: `tests/startup-checks.test.ts:322` "fatal log on parse-divergence does NOT leak ... (real PrivateKey.fromString throw)" fails: `out.actual` is `Buffer [29]` instead of undefined. Confirms the real-throw path now actually depends on the redactor (the synthetic-shape predecessor passed by construction).

- **Item 3 — depth/cycle guard canary** (red on revert):
  - Strip the `if (depth > MAX_CAUSE_DEPTH) return { type: 'MaxDepthExceeded', depth };` block in `redactErrSerializer`. Result: `tests/lib/logger-redact.test.ts:340-372` "depth/cycle guard: a 2-step cause cycle ..." and "depth guard: an unbounded linear cause chain truncates ..." both fail: `expected 'Error' to be 'MaxDepthExceeded'`.

- **Item 4 — try/catch fallback canary** (red on revert):
  - Replace `safeRedactErr` body with `return redactErrSerializer(input);` (no try/catch). Result: `tests/lib/logger-redact.test.ts:391` "try/catch fallback: a throwing-getter err yields the RedactSerializerFailed sentinel" fails: the test's `expect(...).not.toThrow()` flips red because the throwing-getter `stack` propagates out through `logger.warn({err})`.

### Verification gate

- `npx tsc --noEmit` — clean, no errors.
- `npm run lint` — clean, 2 pre-existing warnings only (`src/seed-phrase.ts:26,27` `@typescript-eslint/no-explicit-any`).
- Targeted vitest run (`tests/lib/logger-redact.test.ts`, `tests/startup-checks.test.ts`, `tests/routes/bridge.test.ts`, `tests/lib/broadcast-error.test.ts`): **87 passed (87)** in 1.49s. Lib subset (`tests/lib/`): **241 passed (241)** in 4.04s. Per task brief, full vitest suite is NOT run in this worker — parent serializes that after merging both worker diffs.

### Out-of-scope items honored

- `agents/docs/api-contracts/*.md` — not edited (architect-owned per backend CLAUDE.md). The wave-1 [TODO Architect] markers (convention doc `pino-err-serializer-redact-policy-2026-05-XX.md`, δ test transition confirmation, no-API-contract-update confirmation) carry forward unchanged.
- `routes/claims.ts` — left alone per the architect's coordination note. The follow-up task `backend-bridge-key-claims-route-migration` covers `:214` and `:311`.
- Architect's "Items dismissed (residual risk for archive entry)" — `isErrorLike` predicate, `redactErrSerializer` return-type collapse, `(config as { pevoBridgePostingKey: string })` test casts — left unchanged per the dismissal.

### [TODO Architect] markers (carry forward from wave-1, unchanged)

1. Convention doc `agents/docs/solutions/conventions/pino-err-serializer-redact-policy-2026-05-XX.md` — see wave-1 signal block for required content. The round-3 diff adds new material (depth guard, try/catch fallback, structured `BridgeKeyCacheUnpopulated` error class, explicit `LogFn` overload preservation) that should be folded into the convention doc at architect's archive pass.
2. δ test transition confirmation — verify `accreditation.test.ts` "no raw token leak" specs at `:332` and `:765` still pass. Confirmed in this round's targeted run via `-t "no raw token leak"`: 2 passed.
3. No API contract update required — confirmed; this round's diff is internal-only (logger wrapper + bridge-key accessor). Operators see the same JSON envelope shapes; only err-payload internals change.

---

## Architect re-review (2026-05-06, round-3 → round-4) — HELD PENDING FIXES

`/ce-code-review` ran on commit `1a7a3bb` with 10 reviewer personas (correctness, testing, maintainability, project-standards, security, reliability, adversarial, kieran-typescript, performance, ce-learnings-researcher; `ce-agent-native-reviewer` skipped per project CLAUDE.md). After triage: **3 hold items** below, 1 dismissed (dev-only `uncaughtException`-from-pino-worker fallback; pre-existing-equivalent), 4 P3 single-reviewer findings suppressed at the confidence gate.

The round-3 wave-2 implementation closes 11 of 11 prior hold items as the signal block claims. Re-review surfaced one P1 regression directly introduced by hold item #2 (boot-fatal flush refactor), plus two P2 redact-policy completeness gaps.

### Items to address (all bundle into one round-4 commit)

**1. (P1) `logger.flush(() => process.exit(1))` lacks watchdog timeout AND boot continues during the async window.** Affects 5 sites:

- `backend/src/index.ts:32-37` (uncaughtException handler)
- `backend/src/index.ts:38-41` (unhandledRejection handler)
- `backend/src/index.ts:108-113` (initAppDb catch)
- `backend/src/startup-checks.ts:163-166` (validateConfig missing-required path)
- `backend/src/startup-checks.ts:228-235` (initBridgePostingKeyCache parse-divergence)

Two distinct defects co-located:

(a) **Hung-flush hangs the process.** Pino's `flush(cb)` (sonic-boom in prod, thread-stream in dev) has no built-in timeout. Back-pressured stdout, wedged worker thread, or any condition that prevents drain leaves `cb` un-fired and `process.exit(1)` never reached. The proven pattern at `backend/src/routes/auth.ts:175-193` uses `flush + setTimeout(2000) watchdog`; round-3 hold #2 did not mirror it.

(b) **Async window allows boot to continue.** `validateConfig()` and `initBridgePostingKeyCache()` return SYNCHRONOUSLY to `backend/src/index.ts:43` while flush is pending. `createApp()` runs, `initAppDb()` runs (database migrations execute on a fatal-misconfigured boot), `app.listen()` may bind. Server briefly serves requests until eventual flush drains.

PEvO is single-instance; either failure mode is full availability outage with zero operator visibility (no fatal log on the wire OR migrations applied on misconfigured boot).

Fix shape:

```ts
// Watchdog: ensures exit even if flush callback never fires
const exitTimer = setTimeout(() => process.exit(1), 2000);
exitTimer.unref();
logger.flush(() => {
  clearTimeout(exitTimer);
  process.exit(1);
});
```

For the `validateConfig` and `initBridgePostingKeyCache` paths: instead of returning, **throw** after `logger.fatal(...)` so the call stack unwinds and `createApp()`/`initAppDb()` never run. Catch at the outermost `index.ts` boot path → final `logger.fatal` + watchdog-flush-exit.

Verification canary: mock `logger.flush` to never invoke its callback; assert `process.exit(1)` is still reached via the watchdog (mock `process.exit` to throw a sentinel; assert the throw fires within ~2.1s).

Reviewer attribution: correctness P1 conf 75 + security P0 conf 50 + adversarial high conf 75 ×2 sites + reliability P1 conf 75 → cross-reviewer promotion to anchor 100, severity P1 (security's P0-via-WIF-leak chain is mitigated by the redactor itself; the direct defect is the broken boot-fatal contract).

**2. (P2) Plain-object cause leaks via `redactErrSerializer` recursion.** `backend/src/logger.ts:169` (the recursion site). The function entry has an `isErrorLike` short-circuit that returns the input verbatim for non-Error inputs. A future `class WrappedErr extends Error { ... this.cause = leakyContext; }` (or any code that sets `cause` to a plain object carrying `command`/`actual`/`expected`/`info`) hits `isErrorLike(plainObj) === false` on the recursive call and returns it verbatim, bypassing the field allowlist. The convention `agents/docs/solutions/conventions/pino-err-slot-sibling-bypass-redact-policy-2026-05-06.md` describes this class of bypass at the sibling layer; the same logic applies at the recursive cause layer.

Fix shape:

```ts
// in redactErrSerializer's cause-recursion site (~:169)
if (errAny.cause !== undefined) {
  out.cause = isErrorLike(errAny.cause)
    ? redactErrSerializer(errAny.cause, depth + 1)
    : redactPlainObject(errAny.cause, depth + 1); // new helper: SAFE_BASELINE_FIELDS allowlist + depth guard, no isErrorLike short-circuit
}
```

Add a canary in `backend/tests/lib/logger-redact.test.ts` exercising `Object.assign(new Error('outer'), { cause: { command: { args: ['raw-token'] } } })` and asserting `out.cause.command` is absent.

Reviewer attribution: adversarial single, conf 75 (above gate).

**3. (P2) Sibling-cause drop completeness gap.** Round-3 hold #1 closed `backend/src/lib/broadcast-error.ts:270`. But:

(a) The spread of caller-supplied `opts.logContext` at `backend/src/lib/broadcast-error.ts:253` has no symmetric `cause: undefined` strip. A future caller adding `cause` to its `logContext` (intentionally or by mistake) lands a top-level sibling on the log object, outside both the wrapper layer's `redactErrInArg` (only redacts `arg.err`) and pino's `serializers.err` (only fires on `err`-keyed slots).

(b) The companion adversarial test fixture in `backend/tests/lib/broadcast-error.test.ts:591` previously included `cause: 'caller-override-cause'` to pin that this caller-shape doesn't leak. Round-3 REMOVED the fixture rather than updating the assertion; regression coverage for caller-supplied cause-sibling is gone.

Fix:
- Re-add the `cause: 'caller-override-cause'` fixture to the test at `broadcast-error.test.ts:591` and assert `expect(captured.cause).toBeUndefined()`. Pins the negative invariant the round-3 fix is supposed to guarantee.
- At the spread site at `broadcast-error.ts:253`: `const { cause: _ignored, ...sanitizedLogContext } = opts.logContext ?? {};` so caller-supplied `cause` is always dropped before the spread.

Reviewer attribution: adversarial single, conf 75 (above gate).

### Items dismissed during architect triage

- **(P2) uncaughtException originating from pino worker thread loses fatal log line (dev only).** `backend/src/index.ts:32-35`. Production uses sonic-boom direct (no worker thread); the dev-thread-stream-worker case is the source of this risk. Pre-existing-equivalent: round-3 didn't introduce or worsen it. Reliability single, conf 75. The one-line `console.error(err)` fallback fix is trivial but adds clutter to the uncaughtException handler for a developer-only case already debuggable through other means. Skip.

### Items suppressed at the confidence gate (single-reviewer < 75)

- adversarial: `safeRedactErr`'s `String(serializerErr.message ?? serializerErr)` can itself throw on hostile `Symbol.toPrimitive` (defensive depth)
- correctness: uncaughtException re-entrance during pending flush (benign noise; first process.exit wins)
- reliability: `MAX_CAUSE_DEPTH=10` not configurable via env-var
- kieran-typescript: `redactErrSerializer` return type collapses to `unknown` (round-3 didn't add `MaxDepthExceeded` / `RedactSerializerFailed` sentinels to the union); `(depth: number = 0)` exposes recursion bookkeeping on public signature

### Pre-existing items surfaced (NOT round-4 scope; tracked here for future triage)

- **`MAX_CAUSE_DEPTH=10` per-branch AggregateError fanout DoS surface.** A tree with 10-fanout at every level expands ~10^10 calls before bailing. PEvO is single-instance ⇒ DoS in scope. Narrow attack realism (need attacker-controllable AggregateError shape reaching a logger call). NOT actioned now; if a concrete reachability path emerges, file `backend-redact-errors-array-cap.md`.

### Architect followups carried forward (still applies at round-4 archive)

- Wave-1 [TODO Architect] markers (convention doc `pino-err-serializer-redact-policy-2026-05-XX.md`, δ test transition confirmation, no-API-contract-update confirmation) carry forward unchanged.
- **NEW at this hold:** the architect MUST cite `agents/docs/solutions/conventions/pino-err-slot-sibling-bypass-redact-policy-2026-05-06.md` in the eventual archive entry. It explicitly names `broadcast-error.ts:270` as the violating site this task closes (omitted from the round-3 hold block).
- **NEW at this hold:** when archiving, update `agents/docs/solutions/conventions/pino-spy-serializer-ordering-trap-2026-05-06.md` to remove the superseded `Parameters<typeof baseLogger.warn>` example pattern (lines ~65-72/151-154); round-3 item 5 supersedes it with the `LogFn` factory.
- **NEW at this hold:** at archive, file the codebase-wide watch-list audit follow-up task using `pino-err-slot-sibling-bypass-redact-policy-2026-05-06.md`'s watch list (`originalError`, `wrappedError`, `postErr`, `innerError`, `rootCause`, `nestedError`, `sourceError`) plus `cause`. Scope: scan all `{err, ...}` log-call sites for sibling shapes that bypass redact; either strip them at the call site or add a project-wide structural guard.

### `/ce-compound` candidates at archive (per memory: invoke skill, do NOT hand-write)

1. "Validate-once-and-cache-secret pattern" (architect's earlier hold flagged as candidate; round-3 fully instantiates: module-scope cache + `BridgeKeyCacheUnpopulated` Error subclass + `getRequiredBridgePostingKey` accessor + boot-fatal cache-population path).
2. "Boot-fatal `logger.flush() + setTimeout watchdog` async-transport-drain pattern" — combine with round-4's resolution of finding 1.
3. "Defensive recursive serializer with depth/cycle guard + discriminated sentinel + try/catch fallback" — fold round-3 items 3+4 + round-4's plain-object-cause fix into a single entry.

### Re-review signal

When round-4 items 1-3 land in a single commit, `git mv` this file back to `tasks/review/`. Architect's next pass scopes `/ce-code-review` to the round-4 commit only (not the whole task history). Expected diff: ~30 LOC across `index.ts`/`startup-checks.ts` (watchdog + sync-throw boot semantics), ~10 LOC in `logger.ts` (plain-object cause helper), ~5 LOC in `broadcast-error.ts` (sanitized logContext spread), plus ~50 LOC of new canaries (watchdog mutation-kill, plain-object-cause, re-added cause-sibling fixture).

---

## Backend re-review signal (2026-05-06, round-4 hold-fixes — commit `a376503` on `main`, originally `3189d35` on `worktree-agent-a44a9c6fcbf101fad`)

Round-4 closes 3 of 3 hold items in a single coordinated commit covering `backend/src/{logger.ts,index.ts,startup-checks.ts,lib/broadcast-error.ts,lib/flush-and-exit.ts}` plus paired tests in `backend/tests/{lib/logger-redact.test.ts,lib/broadcast-error.test.ts,lib/flush-and-exit.test.ts}`.

### Item-by-item resolution

**Item 1 (P1) — Watchdog + sync-throw boot semantics.**

(a) **Watchdog timeout.** Extracted the boot-fatal flush+exit shape to `backend/src/lib/flush-and-exit.ts` (new file) so the boot path AND the unit-test canary share the exact same implementation. Body: `const exitTimer = setTimeout(() => process.exit(1), 2000); exitTimer.unref(); logger.flush(() => { clearTimeout(exitTimer); process.exit(1); });` — mirrors the proven pattern at `routes/auth.ts:175-193`. `index.ts` imports and calls it from all 3 sites the round-4 hold names plus the new boot-try/catch site (item 1b below).

(b) **Sync-throw boot semantics.** Added a `BootFatalError` subclass in `startup-checks.ts:312-320`. The two boot-fatal sites that previously called `logger.flush(() => process.exit(1)); return;` (`validateConfig` missing-required path at `:163-170` and `initBridgePostingKeyCache` parse-divergence at `:235-243`) now log fatal then THROW `BootFatalError`. `index.ts:72-86` wraps `validateConfig()` + `createApp()` in a try/catch so the call stack unwinds before any post-validate boot code runs (no migrations on a fatal-misconfigured boot, no `app.listen` on a half-initialized app). Unexpected throws are logged once at the catch (`BootFatalError` subclass suppressed because the boot-fatal sites already logged before throwing). The catch routes through `flushAndExit()` — single watchdog mechanism for all boot-fatal exits.

**Item 2 (P2) — Plain-object cause leak.** Added `redactPlainObject(value, depth)` helper in `logger.ts:181-237` that applies `SAFE_BASELINE_FIELDS` (and `RELAXED_EXTRA_FIELDS` under relaxed mode) to non-Error objects with NO `isErrorLike` short-circuit. The depth guard from round-3 hold #3 carries through (bails at `depth > MAX_CAUSE_DEPTH` returning the same `MaxDepthExceeded` sentinel). The recursive `cause` site in `redactErrSerializer` now branches on `isErrorLike(errAny.cause)`: Error-like causes go through `redactErrSerializer(errAny.cause, depth + 1)` (existing path); plain-object causes go through `redactPlainObject(errAny.cause, depth + 1)` (new path). `redactPlainObject` itself recurses on nested `cause` so a deep plain-object chain is bounded the same way.

**Item 3 (P2) — Sibling-cause drop completeness gap.**

(a) `backend/src/lib/broadcast-error.ts:262-264` — added a function-entry destructure `const { cause: _ignored, ...sanitizedLogContext } = (opts.logContext ?? {}) as LogContext & { cause?: unknown };` and replaced all 4 `...opts.logContext` spread sites with `...sanitizedLogContext`. The cast is required because the typed `LogContext` interface does NOT declare a `cause` field; the destructure is a no-op on the typed-caller happy path and only matters under TypeScript bypass. Centralized at the function entry (cleaner than 4 in-place strips) so all spread sites inherit the protection.

(b) `backend/tests/lib/broadcast-error.test.ts:591` — re-added the `cause: 'caller-override-cause'` adversarial fixture that round-3 dropped, plus an `as unknown as Parameters<typeof handleBroadcastError>[2]` type-bypass cast (mirrors the round-2 `failMsg`-leak regression-guard pattern). The test asserts `expect(callArgs.cause).toBeUndefined()` — fails red if a regression either re-adds `cause: err.cause` after the spread OR drops the `sanitizedLogContext` strip and re-spreads `opts.logContext`.

### Mutation-kill attestation (per `tests-must-fail-on-mutation-of-code-under-test-2026-04-22.md`)

Each new canary verified red against a stripped-down code change. Baseline restored after each verification.

- **Item 1 — watchdog mutation-kill canary** (`tests/lib/flush-and-exit.test.ts`):
  - Strip `setTimeout(() => process.exit(1), 2000); exitTimer.unref(); ...clearTimeout(exitTimer);` and replace with bare `logger.flush(() => process.exit(1))`. Result: "hung flush: watchdog setTimeout fires within ~2s" fails red — `expect(() => vi.advanceTimersByTime(2100)).toThrow(/process\.exit\(1\)/)` catches the missing throw because `process.exit` is never called when the flush callback hangs. Restore green.
  - Drop only the `clearTimeout(exitTimer)` line (keep watchdog + exit). Result: "happy path: flush callback fires → ... watchdog timer cleared so a stale exit doesn't double-fire later" fails red — `process.exit` fires twice because the timer is not cleared. Restore green.

- **Item 2 — plain-object cause mutation-kill canary** (`tests/lib/logger-redact.test.ts`, 3 new specs):
  - Revert the `cause` recursion site to `out.cause = redactErrSerializer(errAny.cause, depth + 1)` (pre-round-4 shape). Result: all 3 plain-object cause specs fail red — the `isErrorLike` short-circuit at the entry of `redactErrSerializer` returns the plain-object cause verbatim, so `out.cause.command` is not stripped, `out.cause.code` is `undefined`, and the depth-guard plain-object recursion truncation never triggers. Restore green.

- **Item 3 — sibling-cause mutation-kill canary** (`tests/lib/broadcast-error.test.ts:591`):
  - Replace `...sanitizedLogContext` with `...opts.logContext` at the `post_broadcast_write_failed` spread site. Result: re-added round-5 hold #1 spec fails red — `callArgs.cause` becomes `'caller-override-cause'` (the type-bypass adversarial value) instead of `undefined`. Restore green.

### Verification gate

- `npx tsc --noEmit` — clean, no errors.
- `npm run lint` — clean, 2 pre-existing warnings only (`src/seed-phrase.ts:26,27` `@typescript-eslint/no-explicit-any`).
- Targeted vitest run (`tests/lib/logger-redact.test.ts`, `tests/lib/broadcast-error.test.ts`, `tests/startup-checks.test.ts`, `tests/routes/bridge.test.ts`, `tests/lib/flush-and-exit.test.ts`): **92 passed (92)**. Per task brief, the full vitest suite is NOT run in this worker — parent serializes that after merging.

### Out-of-scope items honored

- `agents/docs/api-contracts/*.md` — not edited (architect-owned). The wave-1 / round-3 [TODO Architect] markers (convention doc `pino-err-serializer-redact-policy-2026-05-XX.md`, δ test transition confirmation, no-API-contract-update confirmation) carry forward unchanged.
- `routes/claims.ts` — left alone per the original architect coordination note. The `backend-bridge-key-claims-route-migration` follow-up task already landed in `tasks/review/` (commit `83c6a28`) for the architect's separate review pass.
- Architect's "Items dismissed during architect triage" — dev-only `uncaughtException`-from-pino-worker fallback, `safeRedactErr` `String(...)` defensive depth, `MAX_CAUSE_DEPTH` env-knob, `redactErrSerializer` return-type collapse, `(depth: number = 0)` recursion-bookkeeping exposure — left unchanged per the dismissals.
- Pre-existing items "NOT round-4 scope" (`MAX_CAUSE_DEPTH=10` per-branch AggregateError fanout DoS) — not actioned.

### Architectural deviations from the hold's literal snippets

- **`flushAndExit` extracted to `src/lib/flush-and-exit.ts` rather than inlined at all 3 `index.ts` sites.** The hold's snippet is inlined per-site; the extracted shape is functionally identical and lets the unit-test canary share the exact same implementation (DRY + mutation-killable at the function-call layer). The 3 `index.ts` call sites now read `flushAndExit()` instead of duplicating the 4-line block.
- **`BootFatalError` subclass added to `startup-checks.ts` and re-exported from `index.ts`'s import.** The hold names "throw a structured error" without prescribing the class. A dedicated subclass (vs. `throw new Error(...)`) lets the `index.ts` catch site distinguish "expected boot-fatal we already logged about" from "unexpected throw we still need to log", suppressing redundant fatal logs on the expected path.
- **Sibling-cause strip applied at the function entry (one destructure) rather than at the `:253` spread site only.** The hold's snippet is point-fix at `:253`; centralizing at the function entry inherits the protection across all 4 spread sites in one place. Functionally identical for the named site; defense-in-depth at the others.

### [TODO Architect] markers (carry forward from round-3 + round-4 additions)

1. Convention doc `agents/docs/solutions/conventions/pino-err-serializer-redact-policy-2026-05-XX.md` — fold round-4's plain-object cause helper, `flushAndExit` watchdog pattern, and `BootFatalError` boot-stack-unwind shape into the doc at archive.
2. δ test transition confirmation — already-passing as of round-3 wave-2; round-4 doesn't change that path.
3. No API contract update required — internal-only diff (logger serializer + boot-path + broadcast-error helper). Operators see the same JSON envelope shapes; only `err`-payload internals + boot-fatal log timing change.
4. Cite `agents/docs/solutions/conventions/pino-err-slot-sibling-bypass-redact-policy-2026-05-06.md` in the archive entry — round-4 closes the sibling-cause completeness gap that convention names.
5. Update `agents/docs/solutions/conventions/pino-spy-serializer-ordering-trap-2026-05-06.md` at archive — remove the superseded `Parameters<typeof baseLogger.warn>` example pattern (round-3 item 5 superseded it with the `LogFn` factory).
6. File the codebase-wide watch-list audit follow-up task at archive — scope per the round-4 hold's "NEW at this hold" item 3.
7. `/ce-compound` candidates at archive (per the hold block):
   - "Validate-once-and-cache-secret pattern" (round-3 instantiation; carry forward).
   - "Boot-fatal `logger.flush() + setTimeout watchdog` async-transport-drain pattern" — round-4 instantiates; ripe for compound.
   - "Defensive recursive serializer with depth/cycle guard + discriminated sentinel + try/catch fallback + plain-object cause helper" — round-3 + round-4 fold into a single entry.
   - "Boot-fatal call-stack-unwind via subclassed throw + outer catch" — round-4 introduces the pattern; could combine with the watchdog pattern.

---

## Architect re-review (2026-05-06, round-4 → round-5) — HELD PENDING FIXES

`/ce-code-review` ran on commit `a376503` with 10 reviewer personas (correctness, security at opus; testing, maintainability, project-standards, kieran-typescript, performance, reliability, adversarial, ce-learnings-researcher; `ce-agent-native-reviewer` skipped per project CLAUDE.md). After triage: **7 hold items** below, 4 dismissed, several below the 75-gate suppressed.

Round-4's three hold items closed correctly at the named sites — watchdog timer + `BootFatalError` sync-throw shape works, `redactPlainObject` + recursive-cause branch works, sibling-cause destructure works. Re-review surfaced one architectural seam (the catch-throw re-enters `uncaughtException`, defeating the suppress-re-log guard at the catch site), two symmetric residuals from the round-4 redact-policy fix (`errors[].map` and the array-cause early-guard), and one untested invariant (`validateConfig` BootFatalError throw — the round-4 item-1 main contract has no direct unit test).

### Items to address (all bundle into one round-5 commit)

**1. (P2) `errors[]` aggregate plain-object members bypass redact at `redactErrSerializer`'s map site.** `backend/src/logger.ts:189-192`. Round-4 closed the `cause` recursion bypass via `isErrorLike(cause) ? redactErrSerializer : redactPlainObject`. The `out.aggregateErrors = maybeErrors.map((e) => redactErrSerializer(e, depth + 1))` site was NOT updated; a non-Error plain-object member hits `isErrorLike === false` short-circuit at `redactErrSerializer`'s entry and returns verbatim, bypassing `SAFE_BASELINE_FIELDS`. Same risk class round-3/round-4 closed at scalar-cause shapes.

Fix shape:
```ts
out.aggregateErrors = maybeErrors.map((e) =>
  isErrorLike(e) ? redactErrSerializer(e, depth + 1) : redactPlainObject(e, depth + 1)
);
```

Add a canary in `backend/tests/lib/logger-redact.test.ts` exercising `Object.assign(new Error('outer'), { errors: [{ command: { args: ['raw-token'] } }] })` and asserting the aggregate member's `command` is absent.

Reviewer attribution: correctness (low conf 50) + reliability (info conf 90) + adversarial (P2 conf 75 at the related array-cause site, finding 2). Cross-reviewer corroboration; anchor promoted to 100.

**2. (P2) `cause: [Array]` routes to `redactPlainObject` and falls through verbatim via the array early-guard at `:225`.** `backend/src/logger.ts:184-186` (the dispatch site) and `:225-229` (the array early-guard).

The dispatch:
```ts
out.cause = isErrorLike(errAny.cause)
  ? redactErrSerializer(errAny.cause, depth + 1)
  : redactPlainObject(errAny.cause, depth + 1);
```
`isErrorLike([])` returns false (no `.name`/`.message`); the array routes to `redactPlainObject`; the early guard returns it verbatim. Construct: `Object.assign(new Error(), { cause: [{ command: { args: ['raw-token'] } }] })` — array members leak.

Fix shape: replace the array-pass-through at `:225-229` with element-wise recursion:
```ts
if (Array.isArray(value)) {
  return value.map((item) =>
    isErrorLike(item) ? redactErrSerializer(item, depth + 1) : redactPlainObject(item, depth + 1)
  );
}
```

Drop or rewrite the inline comment at `:225-229` that justified the pass-through ("arrays land outside the cause-chain shape this helper exists to defend") — after this fix the comment is inaccurate.

Add a canary in `logger-redact.test.ts` exercising the array-cause shape above and asserting the leaky `command.args` field is stripped at every member.

Reviewer attribution: adversarial (P2 conf 75); same-class as item 1 (`errors[]` site).

**3. (P2) `validateConfig`/`initBridgePostingKeyCache` BootFatalError throw has no direct unit test.** `backend/tests/startup-checks.test.ts`. The round-4 item-1 main contract — replace `flush(() => exit); return` with `logger.fatal; throw BootFatalError` — is the load-bearing semantic that prevents `createApp()` and `initAppDb()` (migrations!) from running on a fatal-misconfigured boot. The existing `startup-checks.test.ts` doesn't import `BootFatalError` and has no test calling `validateConfig()` directly with a missing-required-env fixture.

Mutation-kill: replacing `throw new BootFatalError(...)` with bare `return` inside validateConfig's missing-config branch breaks no test.

Fix shape: import `BootFatalError`. Add `it('validateConfig throws BootFatalError when required env is missing', () => { ... expect(() => validateConfig()).toThrow(BootFatalError); })` plus a symmetric spec for `initBridgePostingKeyCache` parse-divergence path.

Reviewer attribution: testing (medium conf 80, single-reviewer; retained as P2 due to load-bearing scope; `tests-must-fail-on-mutation-of-code-under-test-2026-04-22.md` cited via learnings-researcher).

**4. (P2) `flushAndExit` docblock claims to mirror `routes/auth.ts:175-193` but diverges from it.** `backend/src/lib/flush-and-exit.ts:34`. The auth.ts pattern guards `logger.flush(...)` with `if (typeof logger.flush === 'function')` and has a bare-`process.exit(1)` else-branch; `flushAndExit` calls `logger.flush(...)` unconditionally. The watchdog renders the else-branch redundant (functionally correct), but the docblock's "mirrors" claim is misleading — a future maintainer reading both will either "fix" `flush-and-exit.ts` to add the guard (test churn) or "fix" auth.ts to drop the guard (re-introducing the failure mode the auth.ts author was guarding against).

Fix shape: rewrite the docblock to drop the "mirrors auth.ts:175-193" claim and document the watchdog as the canonical exit guarantee:

```
/**
 * Boot-fatal flush + watchdog exit.
 *
 * Schedules a 2s watchdog timer (unref'd) and calls logger.flush(...).
 * Whichever fires first triggers process.exit(1). The watchdog ensures the
 * process exits even if the flush callback hangs (back-pressured stdout,
 * wedged worker thread, drain failure).
 *
 * The watchdog renders any defensive `typeof logger.flush === 'function'`
 * guard redundant — if logger.flush is missing or non-function, the
 * unconditional call throws synchronously, escapes flushAndExit, and the 2s
 * timer still fires process.exit(1).
 *
 * Used by index.ts boot-fatal sites only.
 */
```

No code change. Auth.ts convergence (eliminating the duplicate inline watchdog at `routes/auth.ts:175-193`) is filed separately as `backend-flush-and-exit-auth-converge.md` (`tasks/pending/`) — out of scope for this round.

Reviewer attribution: maintainability (P2 conf 85, single-reviewer).

**5. (P3) Boot try/catch's `throw err;` re-enters `uncaughtException` handler at `index.ts:36-39`, defeating the suppress-re-log guard at the catch site.** `backend/src/index.ts:63-71`.

The `instanceof BootFatalError` check at the catch site (`:64`) correctly suppresses redundant fatal logging — but the `throw err;` immediately after propagates the BootFatalError to module-evaluation scope, where Node routes it to the `uncaughtException` handler. That handler unconditionally calls `logger.fatal({err}, 'Uncaught exception — shutting down')` and `flushAndExit()` AGAIN. Two timers, two flush calls, duplicate fatal log line. `process.exit` is idempotent so the process exits correctly, but the operator log stream shows a synthetic "Uncaught exception" fatal for what is in fact a known configuration error.

Fix shape: drop the re-throw. Gate post-catch boot on `app` definite-assignment narrowing:

```ts
let app: ReturnType<typeof createApp> | undefined;
try {
  validateConfig();
  app = createApp();
} catch (err) {
  if (!(err instanceof BootFatalError)) {
    logger.fatal({ err }, 'Boot failed unexpected throw');
  }
  flushAndExit();
  return;
}
if (!app) return;
// ... rest of boot
```

The `return` at the end of catch + `if (!app) return;` after the try replaces the `throw err;` in a TS-friendly way. No more re-entry to `uncaughtException`; suppress-re-log guard works as intended.

Reviewer attribution: correctness (low conf 50) + reliability (low conf 80) → cross-reviewer promotion to anchor 100.

**6. (P3) Test gap at `post_broadcast_msg_fn_threw` callArgs.cause assertion.** `backend/tests/lib/broadcast-error.test.ts:667`. The fixture for the `msg_fn_threw` branch includes `cause: 'caller-override-cause'` (the same adversarial value used at `:591`) but the `callArgs` cast at `:667` is `{ err, txId, failedStep }` — `cause` is never asserted. Round-4's centralized destructure was supposed to inherit-protect every spread site; the test canary only pins one of them. A regression that reverted only the warn-site spread back to `...opts.logContext` while leaving the error-site sanitized leaves `callArgs.cause === 'caller-override-cause'` here with no failing test.

Fix shape: widen the cast and add the assertion:
```ts
const callArgs = warnSpy.mock.calls[0][1] as { err: ...; txId: ...; failedStep: ...; cause?: unknown };
expect(callArgs.cause).toBeUndefined();
```

Reviewer attribution: testing (low conf 75, single-reviewer; load-bearing because the parallel finding "type-level destructure enforcement" was dismissed at this triage — runtime canary is the only protection).

**7. (P3) No code-comment pin against future async-refactor of `validateConfig`/`createApp` escaping the boot try/catch.** `backend/src/index.ts:59-72`. The boot try/catch shape works because both calls are synchronous and at module-evaluation scope. A future refactor moving `validateConfig` inside `initAppDb().then(() => ...)` (e.g. "consolidate boot checks") routes BootFatalError into the wrong catch (`initAppDb().catch(...)` at `:132-138`, logged as `'Failed to initialize app database'`).

Fix shape: add a short comment immediately above the try block:

```ts
// CONSTRAINT: validateConfig and createApp MUST remain synchronous and at
// module-evaluation scope. Introducing await or moving these into a .then
// chain would route BootFatalError to the wrong handler.
try {
  // ...
}
```

No code change. Future-developer signal.

Reviewer attribution: adversarial (P3 conf 75, single-reviewer).

### Items dismissed during architect triage

- **(P2) Function-entry destructure pattern in `broadcast-error.ts` lacks type-level enforcement** (`broadcast-error.ts:184`). Single-reviewer maintainability (conf 75); cascade risk on shared `LogContext` type if hardened. Runtime strip + canary (now strengthened by item 6) is sufficient.
- **(P3) `flushAndExit` happy-path test cannot detect dropped `.unref()`** (`flush-and-exit.test.ts:92-122`). Single-reviewer adversarial (conf 75); on a boot-fatal path the process exits within 2s regardless. Wall-clock difference between "exits at flush-cb fire" and "exits at 2s watchdog" is operationally invisible.
- **(P3) Concurrent `flushAndExit` invocations stack independent timers + closures** (`flush-and-exit.ts:31-38`). Single-reviewer adversarial (conf 75); production-benign (`process.exit` is idempotent). Item 5 closes the dominant concurrent-invocation source (the boot-throw → uncaughtException re-entry chain).
- **(P4) `instanceof BootFatalError` convention pin against future name-based-detection refactor** (`index.ts:63-66`). Single-reviewer adversarial (conf 75); P4; defends against a refactor that has no concrete proposal. Item 5's simplification reduces the surface anyway.

### Items suppressed at the confidence gate (single-reviewer < 75)

- adversarial: synchronous `logger.flush` throw clobbers BootFatalError (conf 50); destructure on hostile-getter `cause` (conf 50); log ordering on stdout (conf 50); MaxDepthExceeded sentinel loses parent context (conf 50)
- kieran-typescript: `flushAndExit` no logger param (conf 50); `cause?: never` constraint alternative (conf 55); test type-bypass cast self-documentation (conf 45)
- testing: `redactPlainObject` RELAXED_EXTRA_FIELDS branch untested (conf 70)

### Architect followups carried forward (still applies at round-5 archive)

All round-3 + round-4 [TODO Architect] markers carry forward unchanged. NEW additions at this round:

- **NEW at this hold:** filed `agents/docs/tasks/pending/backend-flush-and-exit-auth-converge.md` at this re-review pass — backend migrates `routes/auth.ts:175-193` to import `flushAndExit`, eliminating the two-maintenance-sites residual reliability flagged at round-4. No dependency on round-5 closing first; can land independently.
- **CARRIED:** Convention doc updates (`pino-err-serializer-redact-policy-2026-05-XX.md`, `pino-spy-serializer-ordering-trap-2026-05-06.md` supersession, `pino-err-slot-sibling-bypass-redact-policy-2026-05-06.md` citation) land at archive after round-5 closes, not now.
- **CARRIED:** Codebase-wide watch-list audit follow-up task to file at archive (per round-4 hold's NEW#3).
- **CARRIED:** `/ce-compound` candidates at archive (numbered for the candidate #4 failure-mode evidence below):
  1. "Validate-once-and-cache-secret pattern" (round-3 instantiation; carry forward).
  2. "Boot-fatal `logger.flush() + setTimeout watchdog` async-transport-drain pattern" (round-4 instantiates; ripe for compound).
  3. "Defensive recursive serializer with depth/cycle guard + discriminated sentinel + try/catch fallback + plain-object cause helper" (round-3 + round-4 + round-5 items 1+2 fold into a single entry — round-5's `errors[]` map symmetry and array-cause element-wise recursion close the same bypass class at sibling sites the round-4 fix missed).
  4. "Boot-fatal call-stack-unwind via subclassed throw + outer catch — and the catch-rethrow re-entry trap that defeats it." Round-4 introduces the success pattern: a `BootFatalError` subclass thrown from `validateConfig` / `initBridgePostingKeyCache` lets the call stack unwind through `index.ts`'s try/catch BEFORE post-validate boot code (`createApp`, `initAppDb` migrations, `app.listen`) runs, fixing the round-3 `flush(() => exit); return;` async-window defect. Round-5 item #5 surfaces the specific failure mode the success pattern must guard against: a catch-site `if (!(err instanceof X)) logger.fatal(...)` suppress-re-log guard is **defeated by an immediately-following `throw err;`** that propagates the subclass to module-evaluation scope, where Node's `process.on('uncaughtException')` handler re-fires the same `logger.fatal` + cleanup unconditionally — duplicate log line, double cleanup invocation, `instanceof` guard contractually nullified. Round-5 evidence: `index.ts:63-71` plus the option-A fix shape (`let app: ReturnType<typeof createApp> | undefined; ...; flushAndExit(); return;` in catch + `if (!app) return;` after try; the TS-friendly definite-assignment narrowing replaces the re-throw without re-entering the global handler). The compound entry MUST name BOTH the success shape AND the catch-rethrow failure-mode guard, otherwise future implementers re-derive only the throw-from-validateConfig half and reintroduce the catch-rethrow defect at the next module boundary.

### Re-review signal

When round-5 items 1-7 land in a single commit, `git mv` this file back to `tasks/review/`. Architect's next pass scopes `/ce-code-review` to the round-5 commit only. Expected diff: ~10 LOC in `logger.ts` (errors[] map + array-cause recursion + comment edit), ~10 LOC in `index.ts` (drop re-throw + `app` narrowing + sync-scope comment), ~5 LOC in `flush-and-exit.ts` (docblock rewrite only), ~30 LOC in `tests/startup-checks.test.ts` (validateConfig + initBridgePostingKeyCache throw specs), ~5 LOC in `tests/lib/logger-redact.test.ts` (errors[] + array-cause canaries), ~3 LOC in `tests/lib/broadcast-error.test.ts:667` (cause assertion).

---

## Backend re-review signal (2026-05-06, round-5 hold-fixes — main-tree SHA `4d7c186`, originally `b365a3c` on `worktree-agent-ac258c8c335188165`)

Round-5 closes 7 of 7 hold items in a single coordinated commit covering `backend/src/{logger.ts,index.ts,lib/flush-and-exit.ts}` plus paired tests in `backend/tests/{lib/logger-redact.test.ts,startup-checks.test.ts,lib/broadcast-error.test.ts}`. No code change in `flush-and-exit.ts` or at the new `index.ts` boot-block constraint — items 4 and 7 are docblock/comment-only.

### Item-by-item resolution

**Item 1 (P2) — `errors[]` aggregate plain-object members.** `backend/src/logger.ts:189-197`. Replaced `out.aggregateErrors = maybeErrors.map((e) => redactErrSerializer(e, depth + 1))` with the per-element `isErrorLike` branch, mirroring the round-4 cause-recursion shape. Plain-object aggregate members now route through `redactPlainObject` instead of returning verbatim via the `redactErrSerializer` entry short-circuit. Inline comment block names round-5 hold #1 and the same-class round-4 cause fix as the cross-reference. New canary at `tests/lib/logger-redact.test.ts:493-525` exercises `Object.assign(new Error('aggregate-outer'), { errors: [{ command: { name: 'eval', args: [..., raw-token] } }] })` and asserts both `arr[0].command === undefined` AND `serialized` does not match `[0-9a-f]{64}` AND surfaces the `'Object'` type label.

**Item 2 (P2) — `cause: [Array]` array early-guard pass-through.** `backend/src/logger.ts:225-238`. Replaced the array short-circuit (`if (... || Array.isArray(value)) return value;`) with element-wise recursion: `if (Array.isArray(value)) { return value.map(item => isErrorLike(item) ? redactErrSerializer : redactPlainObject); }`. The non-array primitive guard remains as a separate `if (value === null || typeof value !== 'object') return value;` after the array branch. Inline comment rewritten to drop the now-inaccurate "arrays land outside the cause-chain shape" justification and document the round-5 element-wise dispatch instead. New canary at `tests/lib/logger-redact.test.ts:537-572` exercises an `Object.assign(new Error(), { cause: [{command: {args: [..., raw-token]}}, {code: 'ECONNREFUSED', errno, syscall, secret_payload}] })` shape and asserts (a) member 0's `command` is stripped, (b) member 1's allowlisted fields preserved + adversarial sibling stripped, (c) belt-and-suspenders the serialized payload contains neither the raw 64-hex token nor `'must-not-leak'`.

**Item 3 (P2) — `validateConfig` / `initBridgePostingKeyCache` BootFatalError throw direct unit tests.** `backend/tests/startup-checks.test.ts:540-651`. New `describe('validateConfig / initBridgePostingKeyCache — BootFatalError throw (round-5 hold #3)')` block with 4 specs. (a) `validateConfig` empty-`hafDatabaseUrls` triggers the missing-required path; assert `expect(() => validateConfig()).toThrow(BootFatalError)`. (b) `validateConfig` BootFatalError carries an operator-grep-friendly message containing `'validateConfig'`. (c) `initBridgePostingKeyCache` parse-divergence path with malformed WIF `5J + '1'.repeat(50)` triggers the parse-divergence throw; assert `expect(() => _initBridgePostingKeyCacheForTests()).toThrow(BootFatalError)`. (d) `initBridgePostingKeyCache` BootFatalError carries an operator-grep-friendly message containing `'initBridgePostingKeyCache'`. Imports `validateConfig` and `BootFatalError` (added to the existing import list at `:3-13`). The `beforeEach`/`afterEach` save and restore `process.env.HAF_DATABASE_URL`, `config.hafDatabaseUrls`, and `config.pevoBridgePostingKey` so the mutations don't leak across the file.

**Item 4 (P2) — `flushAndExit` docblock rewrite.** `backend/src/lib/flush-and-exit.ts:3-22`. Replaced the round-4 docblock that claimed to "mirror the proven pattern at `routes/auth.ts:175-193`" with the architect's verbatim rewrite documenting the watchdog as the canonical exit guarantee and explicitly noting that the watchdog renders any defensive `typeof logger.flush === 'function'` guard redundant. The round-4 hold #1 attribution + the rationale for extracting to its own module (a) so boot path AND unit-test canary share the implementation, (b) for mutation-killability — kept at the bottom of the docblock as historical context. NO code change. The `auth.ts` convergence is left for the separate `backend-flush-and-exit-auth-converge.md` follow-up task per the architect's hold.

**Item 5 (P3) — Drop the `throw err;` re-entry at `index.ts`.** `backend/src/index.ts:75-94`. Replaced `let app: ReturnType<typeof createApp>; try { ... } catch (err) { ...; flushAndExit(); throw err; }` with definite-assignment narrowing: `let app: ReturnType<typeof createApp> | undefined; try { ... } catch (err) { if (!(err instanceof BootFatalError)) { logger.fatal(...); } flushAndExit(); }`. Wrapped the rest of boot (`initAppDb().then(...)` + listen + post-listen jobs) in a top-level `if (app) { const bootedApp = app; ... }` block that closes before the shutdown handlers — module-evaluation scope cannot use top-level `return`, so a structural guard with the inner `bootedApp` constant gives TypeScript the narrowed type for `app.listen(config.port, ...)`. The `initAppDb().catch` site is kept unchanged (it's inside `if (app)` so still wired). Replaced the inner reference `server = app.listen(...)` with `server = bootedApp.listen(...)`. The `bootedApp` constant is the TypeScript-friendly equivalent of the architect's snippet's `if (!app) return;` narrowing — same runtime behavior, no module-scope `return` required.

**Item 6 (P3) — Cast widening at `broadcast-error.test.ts:667`.** `backend/tests/lib/broadcast-error.test.ts:698-734`. Widened the `callArgs` cast at the `post_broadcast_msg_fn_threw` spec from `{ err, txId, failedStep }` to `{ err, txId, failedStep, cause? }` and added `expect(callArgs.cause).toBeUndefined()` after the existing positive/negative assertions. The fixture at `:678-684` already carries `cause: 'caller-override-cause'` in its `logContext` (with the run label `spread-kill-r5-2`), so the type-bypass adversarial value reaches the helper; the destructure at `broadcast-error.ts` strips it before the spread. Removed the now-stale parenthetical comment block (`(The msg-fn-threw payload omits a top-level cause: field — ...)`) — the new direct `expect(callArgs.cause).toBeUndefined()` is the canonical pin.

**Item 7 (P3) — Sync-scope CONSTRAINT comment.** `backend/src/index.ts:60-65`. Added the architect-prescribed comment block immediately above the boot try/catch:

```ts
// CONSTRAINT (round-5 hold #7): validateConfig and createApp MUST remain
// synchronous and at module-evaluation scope. Introducing await or moving
// these into a .then chain would route BootFatalError to the wrong
// handler (e.g. initAppDb().catch logged as 'Failed to initialize app
// database'), defeating the structured boot-fatal path.
```

NO code change.

### Mutation-kill attestation (per `tests-must-fail-on-mutation-of-code-under-test-2026-04-22.md`)

Each new canary verified red against a stripped-down code change. Baseline restored after each verification.

- **Item 1 — `errors[]` plain-object branch canary** (red on revert):
  - Restore `out.aggregateErrors = maybeErrors.map((e) => redactErrSerializer(e, depth + 1))` (drop the new isErrorLike branch). Result: `tests/lib/logger-redact.test.ts:514` "errors[] aggregate plain-object members route through redactPlainObject" fails red — `expect(arr[0].command).toBeUndefined()` becomes `expected { name: 'eval', args: [...] } to be undefined`. Restore green.

- **Item 2 — array-cause element-wise recursion canary** (red on revert):
  - Restore `if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;` (the pre-round-5 array short-circuit). Result: `tests/lib/logger-redact.test.ts:553` "array cause: plain-object members recurse element-wise via redactPlainObject" fails red — `expect(arr[0].command).toBeUndefined()` becomes `expected { name: 'eval', args: [...] } to be undefined`. Restore green.

- **Item 3 — BootFatalError throw canary** (red on revert):
  - Replace `throw new BootFatalError('validateConfig: required configuration missing');` with `return; // mutation-kill stub` (and same for the parse-divergence site). Result: 4 of 4 new specs in `tests/startup-checks.test.ts` `describe('validateConfig / initBridgePostingKeyCache — BootFatalError throw (round-5 hold #3)')` fail red — both `expect(() => ...).toThrow(BootFatalError)` assertions become "expected null to be an instance of BootFatalError". Restore green.

- **Item 6 — sibling-cause strip mutation-kill canary at the warn site** (red on revert):
  - Replace `...sanitizedLogContext` with `...(opts.logContext ?? {})` at the `post_broadcast_msg_fn_threw` warn site (`broadcast-error.ts:331`). Result: `tests/lib/broadcast-error.test.ts:728` "post_broadcast_msg_fn_threw authoritative fields win over colliding logContext keys" fails red — `expect(callArgs.cause).toBeUndefined()` becomes `expected 'caller-override-cause' to be undefined`. Restore green. Pairs with the existing round-4 round-5 hold #1 canary at the error site (`broadcast-error.ts:284`); both are now pinned independently.

Items 4, 5, and 7 are docblock/comment-only or structural narrowing changes. Item 5's narrowing is verified by the existing `tsc --noEmit` clean run + the inner `bootedApp` reference at the `app.listen` call site — a regression that drops the narrowing surfaces as a tsc error (`Object is possibly 'undefined'`).

### Verification gate

- `npx tsc --noEmit` — clean, no errors.
- `npm run lint` — clean, 2 pre-existing warnings only (`src/seed-phrase.ts:26,27` `@typescript-eslint/no-explicit-any`).
- Targeted vitest run (`tests/lib/logger-redact.test.ts`, `tests/lib/broadcast-error.test.ts`, `tests/startup-checks.test.ts`, `tests/lib/flush-and-exit.test.ts`): **88 passed (88)**. Per task brief, the full vitest suite is NOT run in this worker — parent serializes that after merging.

### Out-of-scope items honored

- `agents/docs/api-contracts/*.md` — not edited (architect-owned). The wave-1 / round-3 / round-4 [TODO Architect] markers (convention doc `pino-err-serializer-redact-policy-2026-05-XX.md`, δ test transition confirmation, no-API-contract-update confirmation, `pino-err-slot-sibling-bypass-redact-policy-2026-05-06.md` citation, `pino-spy-serializer-ordering-trap-2026-05-06.md` supersession update, codebase-wide watch-list audit, `/ce-compound` candidates) carry forward unchanged.
- `agents/docs/solutions/` — not touched by hand per the project memory rule (`/ce-compound` is gated to a future archive pass; the [TODO Architect] markers in the task file remain).
- `routes/auth.ts:175-193` flush-and-exit convergence — left for the separate `backend-flush-and-exit-auth-converge.md` follow-up per item 4's hold note.
- Architect's "Items dismissed during architect triage" — function-entry destructure type-level enforcement, `flushAndExit` happy-path `.unref()` detection, concurrent `flushAndExit` invocations stacking, `instanceof BootFatalError` convention pin — left unchanged per the dismissals.
- Items suppressed at the confidence gate — synchronous flush throw clobbering BootFatalError, hostile-getter cause destructure, log ordering on stdout, MaxDepthExceeded sentinel parent context, no logger param on flushAndExit, `cause?: never` constraint, test type-bypass cast self-documentation, RELAXED_EXTRA_FIELDS branch on `redactPlainObject` — left unchanged per the gate.

### Architectural deviations from the hold's literal snippets

- **Item 5 — `bootedApp` const + `if (app) { ... }` block instead of top-level `return`.** The architect's snippet uses `if (!app) return;` after the try/catch, which works in CommonJS modules but TypeScript with `module: "Node16"` (the project's tsconfig) flags it depending on strict-checking flags. The `if (app) { const bootedApp = app; ... }` block achieves identical runtime behavior (skip the rest of boot when `app` is undefined) AND lets TypeScript's control-flow narrow `app` to the non-undefined type via the local const. The `bootedApp` constant ties the narrowing to a single name visible across the whole inner block, so `app.listen(config.port, ...)` becomes `bootedApp.listen(config.port, ...)` without `!`-assertion clutter. Functionally identical; structurally different from the architect's snippet only in the choice of narrowing primitive.

### [TODO Architect] markers (carry forward from round-3 + round-4 + round-5 additions)

1. Convention doc `agents/docs/solutions/conventions/pino-err-serializer-redact-policy-2026-05-XX.md` — fold round-5's `errors[]` plain-object branch + array-cause element-wise recursion shape into the doc at archive (the round-4 plain-object cause helper is the structural sibling these two close out).
2. δ test transition confirmation — already-passing as of round-3 wave-2; round-5 doesn't change that path.
3. No API contract update required — internal-only diff (logger serializer + boot-stack narrowing + docblock + test canaries). Operators see the same JSON envelope shapes.
4. Cite `agents/docs/solutions/conventions/pino-err-slot-sibling-bypass-redact-policy-2026-05-06.md` in the archive entry — round-4 closed the sibling-cause completeness gap that convention names; round-5 strengthens the test pin on the warn-site spread.
5. Update `agents/docs/solutions/conventions/pino-spy-serializer-ordering-trap-2026-05-06.md` at archive — remove the superseded `Parameters<typeof baseLogger.warn>` example pattern (round-3 item 5 already superseded it with the `LogFn` factory; carry forward).
6. File the codebase-wide watch-list audit follow-up task at archive — scope per the round-4 hold's "NEW at this hold" item 3.
7. `/ce-compound` candidates at archive (per the round-4 hold + carry-forward):
   - "Validate-once-and-cache-secret pattern" (round-3 instantiation; carry forward).
   - "Boot-fatal `logger.flush() + setTimeout watchdog` async-transport-drain pattern" — round-4 instantiates; ripe for compound.
   - "Defensive recursive serializer with depth/cycle guard + discriminated sentinel + try/catch fallback + plain-object cause helper + element-wise array recursion" — round-3 + round-4 + round-5 fold into a single entry.
   - "Boot-fatal call-stack-unwind via subclassed throw + outer catch + definite-assignment narrowing" — round-4 introduces; round-5 closes the re-entry leak (drop `throw err;`); fold into a single entry.

---

## Architect re-review (2026-05-11, round-5 → round-6) — HELD PENDING FIXES

`/ce-code-review` ran on round-5 main-tree SHA `4d7c186` with 9 reviewer personas (correctness, security, adversarial at opus; testing, maintainability, project-standards, learnings, reliability, kieran-typescript at sonnet; `ce-agent-native-reviewer` skipped per project CLAUDE.md). Round-5's 7 hold items all closed correctly per all reviewers — no behavioral defects, no security regressions. Re-review surfaced 5 small cleanup items (all in `index.ts` + `logger.ts` + `flush-and-exit.ts`) that the architect held to bundle into a focused round-6.

All 5 items are doc/style/cleanup — no behavior change, no new test required beyond verifying `tsc --noEmit` and `npm run lint` stay clean. The aggregate diff should be very small (about 15-25 lines including the indentation re-flow).

### Items to address (bundle into one round-6 commit)

**1. (P2, anchor 100, cross-reviewer: maintainability + kieran-typescript) `if (app) {` block body zero-indented across 65 lines.** `backend/src/index.ts:87-153`. The new `if (app) { ... }` guard wraps 65 lines of boot orchestration, but the body sits at column 0, not indented. The closing `} // end if (app)` comment marker is the only structural delimiter. A reader scanning the file cannot visually see which startup steps are conditional on `app !== undefined` without manually tracking braces.

   Fix: indent lines 88-152 by 2 spaces. Pure formatting, zero semantic change. tsc and tests stay green. The closing `// end if (app)` comment can stay or be removed once indentation makes the structure self-evident — architect mild preference is removing it after indent, since the indented brace is its own signal.

**2. (P3, anchor 75, kieran-typescript KTS-R5-001) Dead double-cast `as unknown as { errors?: unknown }`.** `backend/src/logger.ts:196`. `errAny` is already typed `Error & Record<string, unknown>` (the cast at line 136). Accessing `errAny.errors` returns `unknown` directly via the index signature — the `(errAny as unknown as { errors?: unknown }).errors` pattern widens to unknown then re-narrows, which is the safe cast idiom but adds nothing here because the source type already provides the target shape.

   Fix: replace with direct access `errAny.errors` OR single cast `(errAny as { errors?: unknown }).errors`. 1-line edit.

**3. (P3, anchor 90, maintainability MR-1) `flush-and-exit.ts` docblock scope claim inaccurate.** Round-5 closed the docblock with "Used by index.ts boot-fatal sites only." `flushAndExit` is also called from `index.ts:38` (`uncaughtException` handler) and `index.ts:43` (`unhandledRejection` handler), which are runtime error paths, not boot-fatal paths. Round-4 docblock was accurate on this point; round-5 rewrite traded accuracy for brevity in the wrong direction.

   Fix: update the trailing scope-claim sentence to enumerate all call sites. Suggested wording: "Used by index.ts boot-fatal site (the boot try/catch in module evaluation) AND by the uncaughtException / unhandledRejection runtime handlers." Final wording is the implementer's call; the requirement is that the docblock no longer claims "boot-fatal only".

**4. (P3, anchor 90, maintainability MR-2) `index.ts:67` comment describes wrong narrowing pattern.** The block comment at lines 66-74 says the narrowing is "`if (!app) return;` rather than a `throw err;`". The actual code at line 87 uses the POSITIVE guard `if (app) { ... }`. The architectural deviation rationale is documented in the round-5 signal block but not in the code. A reader following the comment to locate the `if (!app) return;` finds nothing and may conclude the narrowing was dropped.

   Fix: update the comment to describe the actual `if (app) { ... }` pattern. Architect-suggested wording (not binding): "`app` is narrowed via the `if (app) { ... }` block at line 87 rather than a `throw err;` re-entry that would route back through `uncaughtException` and defeat the suppress-re-log guard at the catch site." The exact phrasing is the implementer's choice as long as the comment accurately reflects the code.

**5. (P3, anchor 85, maintainability MR-3, targeted scope) `index.ts:60` CONSTRAINT comment embeds rotting round-references.** The CONSTRAINT comment is designed as a permanent guardrail (forbids async/dynamic-scope additions to the boot try-block). It currently embeds "round-5 hold #7" and "BACKEND-BRIDGE-KEY-STARTUP-VALIDATION-AND-PINO-REDACT" — task-coordination round-references that rot after this task archives. The substantive constraint description is stable; only the round-attribution tags are the rotting part.

   Fix (TARGETED, do NOT sweep all round-5 inline comments): strip the round-tag from the CONSTRAINT comment ONLY. Keep the constraint description verbatim. Remove the parenthetical "round-5 hold #N (BACKEND-...)" attribution at the constraint site. Round-attribution tags on one-time-fix inline comments elsewhere in `logger.ts`/`index.ts` (e.g., the per-item cross-references that document a specific round-N change) stay — they document a specific historical change, which is what attribution is for.

### Re-review signal

When items 1-5 land in a single round-6 commit, `git mv` this file back to `tasks/review/`. Architect's round-6 review scopes `/ce-code-review` to the round-6 commit only. Items are cleanup-only and the diff is small, so a clean pass plus archive is the expected outcome. If round-6 surfaces any new findings (unlikely given the scope), they roll into round-7 by the standard mechanism.
