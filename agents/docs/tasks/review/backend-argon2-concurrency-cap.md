# BE-ARGON2-CONCURRENCY-CAP — Prevent burnSentinel thread-pool saturation from silently re-opening timing oracles on /login + /signup + /resend-verification + /recover

**Owner:** backend
**Created:** 2026-04-22 (surfaced by BE-LOGIN-UNKNOWN-USER-TIMING round-2 review 2026-04-22)
**Priority:** P2

## Context

`BE-LOGIN-UNKNOWN-USER-TIMING` round-2 consolidated 7 sentinel burn sites behind `burnSentinel()` in `backend/src/routes/auth.ts`. Adversarial re-review flagged that the helper's error path silently reopens every closed timing oracle under thread-pool saturation:

```js
async function burnSentinel(input = '...') {
  try {
    await argon2.verify(await SENTINEL_ARGON2_HASH_PROMISE, input);
  } catch (err) {
    logger.warn({ err }, 'argon2 sentinel burn failed — timing oracle may be open');
  }
}
```

argon2 uses the libuv thread pool (default `UV_THREADPOOL_SIZE=4`). With argon2's own `parallelism=4` option, each verify effectively serializes the pool. Under a burst of concurrent auth requests, queued burnSentinel calls may time out at the socket / fetch level and `argon2.verify` throws. The catch swallows the throw (log is async via pino, fires after the response), and the helper returns in ~0ms. The calling endpoint then returns in ~1ms — **the pre-sentinel oracle reopens for the duration of the saturated interval**.

Concrete attack (from the adversarial persona): flood /login with 50 concurrent unknown-usernames. The first 4 reach argon2, the other 46 queue behind them. Under thread-pool pressure some throw. 46 responses return in ~1ms with 401, 4 return in ~50ms with 401. Attacker has a bimodal distribution correlated with server load; they wait for a saturated window and enumerate.

The fix is infrastructure-level, which is why the round-1 adversarial finding (ADV-004, "libuv thread pool saturation") was dismissed as "not actionable at the code layer." Round-2 architect review reopened it because the burnSentinel consolidation made it more load-bearing: now **every** burn path shares the same thread pool, so saturation cascades across /login + /signup + /resend-verification + /recover simultaneously.

## Why this matters

The entire burnSentinel equalization scheme rests on "argon2.verify runs ≥40ms deterministically." Under saturation that invariant breaks and the timing oracle returns. Rate limits (loginLimiter 10/hr, signupLimiter 10/hr) are the practical defense — but multi-IP distributed attackers bypass per-IP limits (pre-existing concern filed as `backend-rate-limit-xff-spoof-guard.md`). Closing the saturation half of the oracle is the last straw that makes the equalization actually hold under realistic load.

## Goal

Cap concurrent argon2 operations so burnSentinel's throw path cannot silently shorten. Two candidate approaches:

**Option A — UV_THREADPOOL_SIZE bump (deployment knob).**
Raise `UV_THREADPOOL_SIZE` in the backend container env from the default 4 to 16 (or match expected peak concurrent auth requests + margin). Reduces queueing pressure at the cost of Node memory (each thread allocates a libuv task struct + argon2's 64 MiB working set per active verify). At 16 threads × 64 MiB = 1 GiB memory ceiling just for argon2 under full saturation. Tolerable on the single-backend-instance production topology; revisit if memory pressure shows.

**Option B — Application-level semaphore (code knob).**
Wrap burnSentinel's `argon2.verify` call in a `p-limit` or equivalent semaphore that caps in-flight argon2 operations at UV_THREADPOOL_SIZE − 1 (so pool cannot fully saturate). Queuing happens at the JS layer where it's deterministic rather than at libuv where pool exhaustion throws. Adds a dependency (`p-limit` is MIT-licensed, 18 stars, 6KB).

Recommend **Option A first** (one-line Dockerfile / docker-compose env change), with **Option B filed as a follow-up** if load testing shows Option A insufficient.

## Non-goals

- Changing argon2 parameters (memoryCost, parallelism, timeCost). Separate task if tuned.
- Adding retry logic on argon2 throws. The catch-and-log behavior is load-bearing for fail-open-on-crash posture.
- Rate-limit redesign. `backend-rate-limit-xff-spoof-guard.md` covers the per-IP evasion concern.

## Acceptance

- Option A: `UV_THREADPOOL_SIZE=16` set in `docker-compose.yml` backend service env (or equivalent env var location the user confirms).
- Documented tradeoff in a code comment near `SENTINEL_ARGON2_HASH_PROMISE` explaining why the thread pool size matters for timing-oracle correctness.
- A load-test note in the task's archive entry describing how to validate: concurrent 50× /login unknown-username requests should all return in ≥40ms (no sub-10ms outliers). Not a vitest assertion — operational verification.
- Monitoring follow-up: on the ops Grafana dashboard (per `reference_mahdi_haf` — if there's a pevo-local dashboard, surface argon2 p99 latency + throw count). Capture as a `[TODO Architect]` since it's infra, not code.

## [TODO Architect]

- Decide between Option A (env) and Option B (semaphore) or both. Option A suggested for this task, Option B as follow-up if needed.
- Confirm the memory-ceiling tradeoff (1 GiB under full saturation at 16 threads) is acceptable given the single-backend-instance production topology.
- If opting for monitoring, specify where the argon2 p99/throw signals land (pino JSON → log-aggregator, or a prometheus counter exposed via `/metrics`).
