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

---

**Architect re-review (2026-04-28) — HELD PENDING FIXES:**

Cluster A `/ce-code-review` on commit `4d4a651` ran 7 personas (correctness, testing, maintainability, project-standards, reliability, agent-native, learnings). One item survives triage. Guard correctness verified by inspection (sync check-and-set before any await; idempotent against multi-SIGTERM).

1. **P3 — Silent no-op on duplicate signal is an operator-visibility gap** (agent-native, advisory; reframed as ops observability per root `CLAUDE.md` "API Consumer Surface"). Container orchestrators (Kubernetes, Docker Compose) escalate SIGTERM → SIGINT during deploys; the SIGINT is silently dropped with no log trace. An operator manually probing a stuck shutdown via SIGINT gets no feedback. Fix: add a `logger.debug` line before the early return, gated to fire only when an operator has raised the log level:

   ```ts
   if (shutdownStarted) {
     logger.debug({ signal }, 'Duplicate shutdown signal received, ignored');
     return;
   }
   shutdownStarted = true;
   ```

   `logger.debug` produces zero noise under default `LOG_LEVEL=info`; visible only when the operator is investigating with `LOG_LEVEL=debug`. That's the right tier — duplicate signals fire on every rolling restart and would flood logs at `info`.

**Architect triage notes (cluster A, 2026-04-28):**

- **Re-entrancy guard branch is untested** (testing conf 75): Dismissed. The original task scope explicitly waived tests citing OS-level race non-determinism; the testing reviewer correctly noted the guard itself is deterministic and testable, but the cost (~30-50 LoC test setup for 4 lines of trivial-by-inspection code) doesn't justify reopening the waiver. Accepted as documented opt-out.

**Path to re-archive:** (1) Backend lands the one-line `logger.debug` addition. (2) Backend re-review signal block below the hold. (3) Architect re-reads the diff (no `/ce-code-review` rerun warranted for a 1-line debug log); archives on clean.
