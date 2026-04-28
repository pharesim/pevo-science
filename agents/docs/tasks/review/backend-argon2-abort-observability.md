# BE-ARGON2-ABORT-OBSERVABILITY — Make `ArgonAbortError` events visible to operators at default `LOG_LEVEL`

**Owner:** backend
**Created:** 2026-04-28 (surfaced by cluster A `/ce-code-review` of `backend-argon2-semaphore-abort-signal.md`, agent-native persona reframed as ops observability per root `CLAUDE.md` "API Consumer Surface")
**Priority:** P2

## Problem

`backend-argon2-semaphore-abort-signal.md` (commit `3dcc30d`) added silent-return-on-abort to four route handlers (`auth.ts`, `custody.ts`, `settings.ts`, `signup-verify.ts`). When a client disconnects during an argon2 op, the handler emits no HTTP response (the socket is gone) and logs at `debug` tier:

```ts
logger.debug({ err }, 'argon2 slot aborted by client disconnect — no response to write');
```

`backend/src/logger.ts:20`: `const level = process.env.LOG_LEVEL || 'info';`. `backend/.env.example:116`: documented default `LOG_LEVEL=info`. **Under default config, every abort event produces zero log lines.**

`pino-http`'s access-log middleware fires on `res.finish`, which never fires when the handler returns silently. So aborted requests leave **zero trace** under default config:
- No `debug` line (level too low).
- No `pino-http` access log (no `res.finish`).
- No 4xx/5xx in any operator dashboard built on access logs.

Operational consequences:
- A burst of client-disconnect aborts during a network event or attacker-driven connection-cycling scenario generates no operator signal whatsoever.
- An automated incident-correlator watching the log stream at default level cannot distinguish "many aborts" from "no auth traffic at all."
- Combined with the documented `burnSentinel` pre-queue ~0ms cost path, an attacker-driven flood of abort-after-body-upload requests would be invisible AND cheap.

## Goal

Restore operator visibility into abort events under default `LOG_LEVEL` without flooding logs during normal disconnect traffic (mobile clients on flaky connections produce a steady baseline of legitimate aborts).

## Options

The right shape requires a small design choice:

### Option A: Counter-based ops signal (recommended)

Expose an in-process counter on the argon2 semaphore module:
- `getArgon2AbortCount()` — synchronous read of cumulative aborts since process start.
- Increment in the abort listener and the slot-grant race-guard inside `argon2-semaphore.ts`.
- Surface via a dedicated internal admin endpoint (firewall-restricted, NOT `/api/health` per the prior decision to keep recon channels closed). Or surface in periodic logs (e.g., once every 5 minutes if `count > 0`).

**Pros**: Operators see rate without per-event log noise. Easily graphed if the counter ends up in metrics. Aligns with the existing `getArgon2QueueDepth()` / `getArgon2InFlight()` accessors.

**Cons**: Requires picking an exposure surface (admin endpoint or periodic log). Adds new public API to the semaphore module.

### Option B: Elevate log tier with rate limiting

Change the per-event log from `debug` to `info`, but rate-limit emission via a per-process token bucket (e.g., max 10 abort lines per minute, with a "..." summary when suppressed):

```ts
if (abortLogTokenBucket.consume()) {
  logger.info({ event: 'argon2_abort', route: routeLabel }, 'argon2 slot aborted by client disconnect');
}
```

**Pros**: Visible by default. Structured event field (`event: 'argon2_abort'`) makes it easy for log aggregators to count.

**Cons**: Token-bucket plumbing to add. Rate-limit threshold is a magic number. Per-event lines still cost log-storage at scale.

### Option C: Documentation-only (lowest cost)

Update `backend/.env.example` and the relevant route comments to document explicitly that aborts log at `debug` and require `LOG_LEVEL=debug` to see. Add a runbook note in `agents/docs/ARCHITECTURE.md` (or wherever ops guidance lives) saying "if investigating disconnect floods, raise `LOG_LEVEL` to `debug` before reproducing."

**Pros**: Zero code change. Operators investigating already know to raise log level.

**Cons**: Doesn't help automated monitoring; relies on operator knowing the runbook. Loses the proactive-alerting use case.

## Lean (Architect)

**Lean: Option A** with a periodic-log exposure surface (not an admin endpoint, to avoid widening the public surface). Once every 60s, if the counter has incremented since the last emission, log a single line: `logger.info({ event: 'argon2_abort_summary', count: deltaCount }, 'argon2 abort events in the last interval');` — bounded log volume regardless of traffic, structured field for aggregators, no per-event noise.

Implementer may push back if Option B's per-event-but-rate-limited shape fits the team's monitoring pipeline better.

## Acceptance

- A counter (or chosen mechanism) is in place; every abort path (pre-queue, parked-waiter, slot-grant) increments it.
- Operators see abort signal under default `LOG_LEVEL=info` without `LOG_LEVEL=debug` being required.
- Test: simulate N aborts via the existing semaphore unit tests, assert the counter reads N (or the periodic log is emitted with the expected count).
- `.env.example` updated if Option B's rate-limit threshold is configurable.
- ARCHITECTURE.md or runbook updated to describe the operator-visible signal.

## Non-goals

- Changing the per-event `debug` log itself (keep it for `LOG_LEVEL=debug` investigation).
- Surfacing abort counts in `/api/health` (deliberately closed recon channel per `BE-ARGON2-JSLEVEL-CONCURRENCY-CAP` round-2 hold).
- Counting non-argon2 aborts (e.g., other request handlers that also implement abort).

## Related

- `backend-argon2-semaphore-abort-signal.md` — task that introduced the silent-abort path; this is a follow-up, not a hold against it.
- `agents/docs/solutions/conventions/agent-native-persona-calibration-for-pevo-2026-04-28.md` — root-CLAUDE.md cross-link explaining why this finding was reframed as ops observability rather than agent-native.

## [TODO Architect]

Implementer chooses A vs B vs C; architect re-review verifies the chosen shape produces operator-visible signal under default config.
