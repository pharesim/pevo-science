---
title: Verify resource-knob math before baking it into load-bearing security margins
date: 2026-04-22
category: conventions
module: backend
problem_type: convention
component: authentication
severity: high
applies_when:
  - A commit justifies a runtime knob value (thread pool, worker count, connection pool) by stating a resulting concurrency capacity
  - A library's per-call resource multiplier (parallelism, fanout, memory footprint) interacts with the knob sizing
  - A security-margin fix (timing equalization, rate cap, memory budget) depends on the knob-sizing claim being correct
  - "UV_THREADPOOL_SIZE, libuv thread pool, argon2/bcrypt parallelism, or any crypto worker configuration is changed"
  - A container memory limit is set near the expected peak of a library's working memory
tags:
  - "argon2"
  - "libuv"
  - "thread-pool"
  - "resource-sizing"
  - "security-review"
  - "arithmetic-error"
  - "oom"
  - "concurrency"
  - "verify-claims"
---

# Verify resource-knob math before baking it into load-bearing security margins

## Context

Commit `c39377d` (BE-ARGON2-CONCURRENCY-CAP, 2026-04-22) set `UV_THREADPOOL_SIZE=16` in `docker-compose.yml` with the commit-message rationale:

> "Bump the libuv thread pool in the backend container from the default 4 to 16 so argon2.verify cannot saturate under a burst of concurrent /login, /signup, /resend-verification, /recover requests. Default is 4, which saturates at ~4 concurrent auth requests."

The rationale is **arithmetically wrong**, and the error compounds into a second concern the commit never addresses.

**The miscalculation.** `ARGON2_OPTIONS.parallelism = 4`. node-argon2 (and the Argon2 C reference impl it wraps) holds **`parallelism` libuv threads per call** for the full duration of the hash — this is not a tuning hint but a direct 1:1 thread-consumption model. The real concurrency formula is:

```
max_concurrent_argon2_ops = floor(UV_THREADPOOL_SIZE / parallelism)
```

| `UV_THREADPOOL_SIZE` | `parallelism` | concurrent argon2 ops |
|---|---|---|
| 4 (node default) | 4 | **1** (not 4 as the comment states) |
| 16 (post-fix) | 4 | **4** (not 16 as the comment implies) |

The fix shifted the saturation threshold from 1 concurrent argon2 op to 4 — meaningful against accidental burst load, but an attacker with 5 coordinated requests (trivial from 5 IPs, or 5 concurrent connections from one host) still saturates the pool. The 5th `burnSentinel` call throws inside argon2; the silent `.catch(() => {})` swallows it; response returns in ~0ms; timing oracle reopens for the saturated window.

**The compound concern.** At `parallelism=4`, `memoryCost=65536 KiB (64 MiB)`:

```
peak_argon2_mem = UV_THREADPOOL_SIZE × (memoryCost / 1024)
                = 16 × 64 MiB
                = 1024 MiB
```

`docker-compose.yml` caps backend at `memory: 512m`. 17+ concurrent auth requests → working memory exceeds the limit → Docker OOM-kill → `restart: always` cycles → `start_period: 15s` blocks all auth during restart. Availability-damage DoS requiring no authentication, trivially repeatable.

**Why the miscalculation wasn't caught.**

- "Thread pool of N → N concurrent ops" is correct for most single-threaded-per-call libraries; argon2 is unusual in holding `parallelism` threads per call, and that fact was not surfaced in the commit's reasoning chain.
- The Argon2 RFC defines `parallelism` as a KDF **strength** parameter (more lanes = more memory-hardness). The fact that node-argon2 also maps it to runtime thread consumption is a library-specific implementation detail that must be **verified**, not assumed.
- The memory math (concurrent argon2 × per-call memoryCost vs container limit) was not checked at all. The commit raised the pool ceiling without touching `mem_limit`.
- Prior SEC-LOGIN-UNKNOWN-USER-TIMING round-1 review flagged libuv-saturation as "no actionable fix at this layer; Global argon2 concurrency cap is an infrastructure decision." That handoff was directionally correct but baked in the unchecked assumption "set UV_THREADPOOL_SIZE=16 and it's fine" — which the follow-up commit inherited without re-verifying.

**Relationship to the library-claims sibling.** The convention `verify-library-claims-before-load-bearing-security-margins-2026-04-22.md` covers cases where a **library-behavior claim** (dhive's 30s broadcast timeout) was load-bearing for a security margin (ORCID binding lock TTL) and turned out not to exist. This doc is a sibling: same failure class (unverified claim baked into a security margin) applied to a **runtime-knob resource claim** (pool-size = concurrent-ops + memory-peak) rather than a library-feature claim. Both require the same discipline — cite the source, verify the math, add a test or startup assertion — but the specific checklist differs because the failure mechanics differ.

## Guidance

**Rule: when sizing a runtime worker-pool knob (thread pool, connection pool, worker count) to bound a library whose calls consume per-call resources (threads, memory, file descriptors), write out the derivation chain, verify each step against the library's actual implementation, and encode the derivation in a startup assertion. Never let the sizing claim exist only in a commit message or an inline comment.**

### Derivation chain (write this out in code or docs)

1. **Per-call resource consumption** (read from the library's docs or source — do NOT assume):
   ```
   per_call_threads = ARGON2_OPTIONS.parallelism          // = 4 (node-argon2 native binding holds this many threads)
   per_call_mem_mib = ARGON2_OPTIONS.memoryCost / 1024    // = 64 MiB
   ```

2. **Derived concurrency cap:**
   ```
   concurrent_ops_cap = floor(UV_THREADPOOL_SIZE / per_call_threads)
                      = floor(16 / 4)
                      = 4
   ```

3. **Derived peak working memory:**
   ```
   peak_mem = concurrent_ops_cap × per_call_mem_mib
            = 4 × 64 MiB
            = 256 MiB
   ```

4. **Verify peak_mem fits inside the container memory limit with headroom.** 256 MiB argon2 peak + Node.js V8 heap + in-flight HTTP state + pino worker thread → 512m container is tight but workable. 8 concurrent ops would cost 512 MiB in argon2 alone → OOM boundary hit before any HTTP overhead. Refuse to ship a sizing that touches the limit without slack.

5. **Startup assertion** so a future env-var change or ARGON2_OPTIONS edit doesn't silently break the margin:

   ```typescript
   const UV_THREADPOOL_SIZE = parseInt(process.env.UV_THREADPOOL_SIZE ?? '4', 10);
   const ARGON2_CONCURRENT_OPS = Math.floor(UV_THREADPOOL_SIZE / ARGON2_OPTIONS.parallelism);
   if (ARGON2_CONCURRENT_OPS < 1) {
     throw new Error(
       `UV_THREADPOOL_SIZE=${UV_THREADPOOL_SIZE} < argon2 parallelism=${ARGON2_OPTIONS.parallelism}: ` +
       `argon2 calls will deadlock.`,
     );
   }
   // Optional: warn if the derivation produces fewer concurrent ops than expected.
   ```

6. **JS-level concurrency semaphore** (the real fix — pool sizing alone is not deterministic under unbounded HTTP concurrency):

   ```typescript
   import pLimit from 'p-limit';

   // Derivation: floor(UV_THREADPOOL_SIZE / parallelism) = floor(16 / 4) = 4
   // Peak argon2 mem = 4 × 64 MiB = 256 MiB (under 512m container limit)
   // Changing either UV_THREADPOOL_SIZE or parallelism MUST recalculate this.
   const argon2Semaphore = pLimit(ARGON2_CONCURRENT_OPS);

   async function burnSentinel(input: string): Promise<void> {
     const hash = await SENTINEL_ARGON2_HASH_PROMISE;
     await argon2Semaphore(() =>
       argon2.verify(hash, input, ARGON2_OPTIONS),
     ).catch((err) => {
       logger.warn({ err }, 'burnSentinel failed — timing oracle may be open for this request');
     });
   }
   ```

   With the semaphore, the 5th concurrent request queues in JS rather than racing for libuv threads; the queue delay makes that request slower, not faster — the timing oracle stays closed.

### Prevention checklist (adapt per library)

- [ ] Source citation: commit message or code comment cites the library file/line that defines the per-call resource model.
- [ ] Arithmetic written out: `floor(pool / per_call)` or equivalent, with numeric substitution.
- [ ] Memory math checked: `concurrent × memoryCost` ≤ container limit with ≥30% headroom.
- [ ] Startup assertion or lint rule guards against silent future drift.
- [ ] If the margin is security-critical, a semaphore / rate-limiter at the application layer enforces the cap independent of infrastructure knobs.

## Why This Matters

Timing-oracle closure and availability both rest on the pool-sizing claim being correct. When the claim is off by a factor (here, `parallelism`):

- The **timing oracle reopens** at `concurrent_ops_cap + 1` requests instead of the assumed `UV_THREADPOOL_SIZE + 1`. Attacker-exploitable from a handful of coordinated connections.
- The **container OOM-kills** at `UV_THREADPOOL_SIZE × per_call_mem_mib > container_mem_limit`. The commit raised the numerator without checking the denominator. 1 GiB peak vs 512m limit is a self-inflicted DoS vector.
- The **review cascade** propagates. The commit rationale was internally plausible; a reviewer without the library implementation cited is disposed to accept the comment's math. Every subsequent reader compounds the trust.

Runtime-knob sizing is cheap to get wrong and expensive to notice. The failure is silent until attack or load reveals it. Verify the math once, encode the derivation in code (not comments), and the class closes permanently.

## When to Apply

1. Any PR setting `UV_THREADPOOL_SIZE`, `WEB_CONCURRENCY`, `MAX_PG_POOL`, or similar runtime-capacity knob for a security-sensitive codepath.
2. Any change to `ARGON2_OPTIONS.parallelism` or `memoryCost` — both affect the concurrency and memory math.
3. Any change to container `mem_limit` — recheck `concurrent_ops_cap × per_call_mem_mib` against the new limit.
4. Any security-sensitive library call where the library documentation says "parallelism", "workers", "fanout", or "lanes" — investigate whether these map to runtime threads or just strength.
5. Any timing-equalization or rate-limit fix that implicitly assumes "all requests complete in bounded time." If the library can throw under saturation, the assumption is false without an explicit JS-level cap.
6. Any security review where the author's own rationale is the only evidence for a knob-sizing claim. Demand citation of the library's actual resource model.

## Examples

**Wrong (what was committed):**

```yaml
# docker-compose.yml
services:
  backend:
    environment:
      UV_THREADPOOL_SIZE: "16"   # implies "16 concurrent argon2 ops" — wrong
    mem_limit: 512m              # never checked against argon2 working memory
```

```ts
// backend/src/routes/auth.ts — commit message rationale
// "Default is 4, which saturates at ~4 concurrent auth requests."
// Implicit 1:1 pool-size-to-concurrent-ops mapping. Ignores parallelism=4 multiplier.
```

**Right (derivation + semaphore):**

```ts
// backend/src/routes/auth.ts
//
// argon2 concurrency math (MUST be rechecked when either value changes):
//   UV_THREADPOOL_SIZE               = 16   (docker-compose.yml backend env)
//   ARGON2_OPTIONS.parallelism       = 4    (each argon2 call holds this many libuv threads —
//                                            see node-argon2 native binding argon2_ctx.threads)
//   concurrent_ops_cap               = floor(16 / 4) = 4
//   peak_argon2_working_mem          = 4 × 64 MiB  = 256 MiB (under 512m container limit)
//
// JS-level semaphore enforces the cap regardless of HTTP concurrency.
// Raising UV_THREADPOOL_SIZE alone does NOT increase argon2 throughput —
// it only increases OOM-kill risk.

const UV_THREADPOOL_SIZE = parseInt(process.env.UV_THREADPOOL_SIZE ?? '4', 10);
const ARGON2_CONCURRENT_OPS = Math.floor(
  UV_THREADPOOL_SIZE / ARGON2_OPTIONS.parallelism,
);
if (ARGON2_CONCURRENT_OPS < 1) {
  throw new Error(
    `UV_THREADPOOL_SIZE=${UV_THREADPOOL_SIZE} < argon2 parallelism=${ARGON2_OPTIONS.parallelism}`,
  );
}
const argon2Semaphore = pLimit(ARGON2_CONCURRENT_OPS);
```

**Quick-reference memory table (memoryCost=64 MiB, parallelism=4):**

| `UV_THREADPOOL_SIZE` | concurrent ops | peak argon2 mem | 512m container safe? |
|---|---|---|---|
| 4 (default) | 1 | 64 MiB | yes |
| 8 | 2 | 128 MiB | yes |
| 16 (post-fix) | 4 | 256 MiB | yes (tight) |
| 32 | 8 | 512 MiB | no — OOM boundary |
| 64 | 16 | 1024 MiB | no — OOM on first full burst |

## Related

- `agents/docs/solutions/conventions/verify-library-claims-before-load-bearing-security-margins-2026-04-22.md` — sibling: unverified **library-behavior** claims (dhive 30s broadcast timeout) cascading through review rounds. Same failure class, different axis.
- `agents/docs/solutions/conventions/timing-equalization-sub-branch-oracles-2026-04-21.md` — the security margin the miscalculation was meant to protect.
- `agents/docs/solutions/conventions/timing-equalization-smtp-failure-mode-oracle-2026-04-22.md` — sibling oracle-axis doc (status-code under SMTP failure).
- `agents/docs/tasks/pending/backend-argon2-jslevel-concurrency-cap.md` — follow-up task implementing the semaphore + startup assertion + correct comment.
- `backend/src/lib/argon2-options.ts` — canonical `ARGON2_OPTIONS`.
- `docker-compose.yml` backend service — `UV_THREADPOOL_SIZE` env + `memory: 512m`.
- [wrapping-primitive-exhaustive-call-site-audit-2026-04-22.md](wrapping-primitive-exhaustive-call-site-audit-2026-04-22.md) — sibling lesson from the same semaphore task. That doc captures the call-site coverage rule (grep every `argon2.hash`/`argon2.verify` across all files; the implementer missed `settings.ts:384`). This doc captures the arithmetic-chain verification rule. Both are necessary for the semaphore's invariant to hold; neither is sufficient alone.
