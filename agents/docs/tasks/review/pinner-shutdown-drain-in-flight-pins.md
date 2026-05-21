# PINNER-SHUTDOWN-DRAIN-IN-FLIGHT-PINS — Drain in-flight pin operations on shutdown instead of cancelling

**Owner:** pinner
**Created:** 2026-05-21 (surfaced by full-codebase audit 2026-04-21, `.context/audit-2026-04-21/chunk-6-correctness-reviewer.md` + `chunk-6-reliability-reviewer.md`)
**Priority:** P1 (reliability + correctness)

## Context

`pinner/main.go` shutdown sequence currently:

- Cancels the root context, which cancels all in-flight `backend.Pin(ctx, cid)` calls.
- Calls `backend.Close()` on the embedded node.
- Runs `discovery.Stop` after the backend is already closed.

Two defects from the audit:

1. **Autopin runs against a closed backend.** During the shutdown window, `discovery.refresh` can still be mid-iteration and fire its autopin callback against a backend whose underlying file handles and locks are already gone. The error surfaces as a generic write failure, not as a shutdown signal.
2. **In-flight pins are cancelled, not drained.** A pin operation that's mid-stream from a gateway gets its context cancelled. The partial file in `blocks/<cid>` is left on disk unless the cleanup path runs (the audit notes cleanup is racy — partial file may persist). On next startup, `IsPinned` may report the CID as present despite the file being incomplete.

## Goal

Make shutdown deterministic:

1. **Order:** signal discovery to stop first, wait for it to return, then drain in-flight pins, then close the backend.
2. **Drain mechanism.** Track in-flight `Pin` calls via a `sync.WaitGroup`. On shutdown, stop accepting new pins (via a closed `done` channel checked at entry) and `wg.Wait()` with a hard timeout (e.g., 30s).
3. **Partial-file cleanup on cancelled pin.** If a `Pin` returns context-cancelled mid-`io.Copy`, `os.Remove(path)` before returning. Don't leave a partial block on disk.
4. **Health endpoint reflects draining state.** During shutdown, `/healthz` should return 503 (drained, not ready). See related task if/when `pinner-health-readiness-endpoint.md` is filed — for now, add the state and a log line even without an HTTP endpoint.

## Non-goals

- Reworking the discovery loop's polling cadence or concurrency model. Separate concern.
- Adding circuit breakers around backend operations. Different audit P1.

## Acceptance

- Pinner shutdown waits for in-flight pins to complete (or hard-timeout) before closing the backend.
- A test simulates a slow gateway during shutdown and asserts the in-flight pin either completes or has its partial file cleaned up.
- No log lines about "writing block: ..." against a closed backend during a clean shutdown.

## References

- Audit chunks:
  - `.context/audit-2026-04-21/chunk-6-correctness-reviewer.md` (P1: shutdown runs autopin callback against closed backend).
  - `.context/audit-2026-04-21/chunk-6-reliability-reviewer.md` (P1: in-flight pin operations cancelled not drained on shutdown).
