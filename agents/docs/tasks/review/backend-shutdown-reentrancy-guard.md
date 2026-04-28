# BE-SHUTDOWN-REENTRANCY-GUARD — Add re-entrancy guard to index.ts shutdown() to prevent SIGTERM+SIGINT racing pool.end()

**Owner:** backend
**Created:** 2026-04-28 (surfaced by argon2 cluster re-review)
**Priority:** P3

## Context

`backend/src/index.ts shutdown()` is registered as the handler for both SIGTERM and SIGINT. Both handlers call `shutdown()` with no flag preventing concurrent execution.

`closeHafPool()` and `closeAppPool()` both follow the pattern:
```
if (pool) {
  await pool.end();
  pool = null;
}
```

The check, await, and null-set are not atomic. Two concurrent `shutdown()` calls can both see `pool !== null`, both call `pool.end()`, and `pg.Pool.end()` throws "called end on a pool more than once" on the second invocation.

In practice, `process.exit(0)` on the first completion typically terminates the process before the second `shutdown()` reaches `closeHafPool()` — but under high-latency pool drain (slow DB, many idle connections) the race is reachable.

## Goal

Idempotent `shutdown()` regardless of how many SIGTERM / SIGINT signals arrive.

## Acceptance

- Module-level flag in `index.ts`: `let shutdownStarted = false;`
- Top of `shutdown()`: `if (shutdownStarted) return; shutdownStarted = true;`
- Optional follow-up — re-entrancy guards inside `closeHafPool()` and `closeAppPool()` themselves (defense-in-depth so any future caller is also safe). Not required for this task.

## Non-goals

- Changes to the 30s force-timeout on `server.close()`.
- Changes to drain ordering (drainArgon2Queue → server.close() → pool drains).
- Adding tests — this is a one-line guard against an OS-level race that's hard to reproduce deterministically. Code review verification is sufficient.
