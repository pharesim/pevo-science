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
