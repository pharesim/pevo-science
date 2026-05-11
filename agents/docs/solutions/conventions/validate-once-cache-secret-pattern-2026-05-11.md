---
title: "Validate-once-and-cache-secret pattern (boot-init + typed accessor + structured throw)"
date: 2026-05-11
category: conventions
module: backend/src/startup-checks.ts
problem_type: convention
component: authentication
severity: high
applies_when:
  - "An expensive-to-parse value (private key, parsed JWK, compiled regex, prepared statement) is read per-request from config"
  - "The parse step itself can throw a leaky error shape (Buffer slices, command args, raw input echoed in the message)"
  - "A bare `process.exit(1)` on parse failure is unacceptable because the fatal log line must drain through pino's async transport first"
  - "The cached value's null state is a programming error rather than a recoverable condition, so callers should get a typed throw instead of a `T | null` return"
  - "Operator alerting needs a stable, redact-safe discriminator on the error class so log shippers can key alerts on a single field"
tags:
  - secret-handling
  - boot-fatal
  - cache-pattern
  - error-subclass
  - defense-in-depth
  - bridge-admin-key
  - typed-accessor
---

# Validate-once-and-cache-secret pattern (boot-init + typed accessor + structured throw)

## Context

`BACKEND-BRIDGE-KEY-STARTUP-VALIDATION-AND-PINO-REDACT` (rounds 3-6, archived 2026-05-11) closed a leak class where `routes/bridge.ts:233` and `:362` called `PrivateKey.fromString(config.pevoBridgePostingKey)` inside the per-request broadcast try/catch. dhive's `PrivateKey.fromString` throws an `AssertionError` whose `.actual` / `.expected` are `Buffer` slices DERIVED from the WIF. Anyone with read access to operator logs (aggregation, archives, log-shipping, third-party SaaS log services) could reconstruct the bridge admin posting key from those slices.

The naive shape — `PrivateKey.fromString(config.X)` at every call site — is both a security defect (per-request throw site leaks the secret in logs) AND a performance defect (re-parses an expensive value per-request). Round-3 closed both by moving the parse to boot and providing a typed accessor for per-request reads.

Rounds 4-6 refined the pattern by closing failure modes the round-3 version introduced: a lazy-fallback re-parse path, a non-null assertion (`!`) tying type-narrowing to a runtime-only invariant, and a docstring that overclaimed project-wide coverage. The pattern as documented below is the round-5/6 canonical shape.

## Guidance

Compose four pieces. Each addresses one failure mode the others don't cover.

### 1. Module-scope cache

```ts
// backend/src/startup-checks.ts
let cachedBridgePostingKey: PrivateKey | null = null;
```

Process-lifetime storage. `null` means "boot has not populated this yet" — never "we cleared it on purpose."

### 2. Init function called at boot

```ts
export function initBridgePostingKeyCache(): void {
  const parsed = PrivateKey.fromString(config.pevoBridgePostingKey);
  // Parse-divergence defense: re-serialize, compare to input
  if (parsed.toString() !== config.pevoBridgePostingKey) {
    throw new BootFatalError(
      'initBridgePostingKeyCache: parse-divergence — round-trip changed the WIF',
    );
  }
  cachedBridgePostingKey = parsed;
}
```

Two responsibilities:
- Parse the secret once.
- Validate that the parsed-then-re-serialized form equals the input (parse-divergence check). Catches silent transcoding bugs where the library accepts a malformed input by coercing it to a valid-looking but DIFFERENT value.

Throw a `BootFatalError` subclass (see piece 4) on either failure. Do NOT log the original input in the error message — the redact policy strips known-leaky fields but the message is operator-facing prose.

### 3. Typed accessor that throws on cache-unpopulated

```ts
export class BridgeKeyCacheUnpopulated extends Error {
  readonly type = 'BridgeKeyCacheUnpopulated';
}

export function getRequiredBridgePostingKey(): PrivateKey {
  if (cachedBridgePostingKey === null) {
    throw new BridgeKeyCacheUnpopulated(
      'Bridge posting key cache unpopulated — initBridgePostingKeyCache must run during boot',
    );
  }
  return cachedBridgePostingKey;
}
```

Three properties matter:
- **Return type is `PrivateKey`, NOT `PrivateKey | null`.** Callers get TypeScript narrowing for free; no `!` non-null assertion at the call site. (The naive `getCachedBridgePostingKey(): PrivateKey | null` shape forces every caller to either `!`-assert or null-check, and `!`-assertions tie type-narrowing to a runtime invariant.)
- **The throw shape is a structured Error subclass with a `type` discriminator field, not a string-typed error.** The `type` field is in `SAFE_BASELINE_FIELDS` of the project's `redactErrSerializer`, so it survives redaction. Operator alerting can key on `event.err.type === 'BridgeKeyCacheUnpopulated'` reliably.
- **A separate lazy-fallback accessor (`getCachedBridgePostingKey()`) exists for test-and-rotation paths only.** Production code paths reach it only post-validator. The docstring scopes the throw-site guarantee explicitly to the strict accessor's call sites.

### 4. Boot-fatal cache-population path

```ts
// backend/src/index.ts (module-evaluation scope)
// CONSTRAINT: validateConfig and createApp MUST remain synchronous and at
// module-evaluation scope. Introducing await or moving these into a .then
// chain would route BootFatalError to the wrong handler.
let app: ReturnType<typeof createApp> | undefined;
try {
  validateConfig();              // calls initBridgePostingKeyCache() internally
  app = createApp();
} catch (err) {
  if (!(err instanceof BootFatalError)) {
    logger.fatal({ err }, 'Boot failed — unexpected throw during startup');
  }
  flushAndExit();                // 2s watchdog + logger.flush race
}

if (app) {
  // ... rest of boot orchestration runs only when boot succeeded
}
```

The init function is called from a synchronous boot try/catch. A `BootFatalError` thrown from inside `validateConfig()` unwinds the call stack BEFORE `createApp()`, `initAppDb()` (migrations!), or `app.listen()` can run. The catch routes through `flushAndExit()` which drains the fatal log line under a 2s watchdog before `process.exit(1)`.

The `if (app)` positive-guard pattern is structurally required because module-evaluation scope cannot use `return`. The narrowed type `app: ReturnType<typeof createApp>` is available inside the block via TypeScript's control-flow analysis.

## Why This Matters

- **Closes the WIF-leak class at the source.** Eliminating the per-request `PrivateKey.fromString` call site eliminates the `AssertionError`-with-Buffer-slices runtime failure mode. The redact policy is defense-in-depth at the log layer; this pattern is defense-in-depth at the parse layer.
- **Per-request hot paths skip the parse.** For high-throughput routes (e.g., bridge broadcast under load), parsing a WIF on every request is non-trivial CPU. The cache is a free speedup.
- **Operator alerting becomes reliable.** Without the structured `type` discriminator, operators must regex on error messages — which break the moment the message changes. With the discriminator, alerts key on `err.type` directly.
- **Boot semantics become checkable.** A misconfigured production deploy fails at boot, with a clear fatal log, and the server never starts. Without the pattern, a misconfigured deploy starts the server and fails per-request, producing N spam fatal lines and accepting traffic in a degraded state for the duration of the misconfiguration.

## When to Apply

- Bridge admin posting key (the canonical instantiation).
- Any other dhive `PrivateKey.fromString(...)` call site (the accreditation-authority keys, future bridge-service keys, future delegation keys).
- ORCID OAuth client secret if it's ever parsed (currently a flat string; not applicable today).
- Any parsed JWK or signing key loaded from config.
- Compiled regexes used per-request from a config string — same parse-once-cache shape, though the security framing is lighter.

Do NOT apply to:
- Values that are intentionally null until first-use (e.g., the IPFS client which is lazy-initialized).
- Values whose parse semantics depend on runtime state (e.g., per-request key derivations).
- Values where re-parsing per call is genuinely cheap and the throw-shape is already redact-safe (e.g., `JSON.parse` of a known-shape config blob).

## Examples

### Before (naive shape — what round-3 replaced)

```ts
// backend/src/routes/bridge.ts (pre-round-3)
try {
  const adminKey = PrivateKey.fromString(config.pevoBridgePostingKey);
  await client.broadcast.json({ ... }, adminKey);
} catch (err) {
  // err may be an AssertionError with `actual` / `expected` Buffer slices
  // derived from config.pevoBridgePostingKey — leaks the WIF if logged
  logger.error({ err }, 'Bridge broadcast failed');
  return reply.status(502).send({ error: 'BROADCAST_FAILED' });
}
```

Two defects compounded:
- The throw site is in the broadcast catch, so a misclassification of "invalid WIF" as "broadcast failure" mis-routes operator alerts.
- The full err object reaches the log shipper before any redact policy fires.

### After (round-5/6 canonical shape)

```ts
// backend/src/index.ts (module-evaluation scope)
try {
  validateConfig();              // initBridgePostingKeyCache() inside
  app = createApp();
} catch (err) {
  if (!(err instanceof BootFatalError)) {
    logger.fatal({ err }, 'Boot failed — unexpected throw during startup');
  }
  flushAndExit();
}

// backend/src/routes/bridge.ts (per-request)
const adminKey = getRequiredBridgePostingKey();   // typed PrivateKey, never null
await client.broadcast.json({ ... }, adminKey);
```

- The parse happens exactly once, at boot, with a structured-throw fatal.
- The per-request path has no parse, no `!`-assertion, no `PrivateKey | null` to handle.
- A null cache (test-isolation bug, rotation race) throws `BridgeKeyCacheUnpopulated` with a redact-safe `type` discriminator.

## Related

- `agents/docs/solutions/conventions/pino-err-slot-sibling-bypass-redact-policy-2026-05-06.md` — defense-in-depth at the log layer; the structured-throw shape in this pattern is the input the redact policy consumes.
- `agents/docs/solutions/conventions/tests-must-fail-on-mutation-of-code-under-test-2026-04-22.md` — mutation-kill discipline for the new tests this pattern produces (`getRequiredBridgePostingKey()` null-cache throw, parse-divergence throw).
- `backend/src/startup-checks.ts` — canonical implementation of all four pieces.
- `backend/src/index.ts:60-90` — the boot-fatal call-stack-unwind shape that consumes the structured throw (see the separate compound entry on call-stack-unwind + catch-rethrow trap for that pattern's full treatment).
- `agents/docs/tasks-archive.md` — `BACKEND-BRIDGE-KEY-STARTUP-VALIDATION-AND-PINO-REDACT` archive entry for the full 6-round history that produced this pattern.
