# BE-HANDLE-BROADCAST-ERROR-HELPER — Extract the 7-site `BroadcastTimeoutError` discrimination pattern into a shared helper

**Owner:** backend
**Created:** 2026-04-22 (surfaced by BE-ORCID-BROADCAST-ABORT-TIMEOUT round-2 review)
**Priority:** P3

## Context

`BE-ORCID-BROADCAST-ABORT-TIMEOUT` round-1 landed the 504/502/500 discrimination pattern at 7 HTTP-surface catch sites across `orcid.ts` (x2), `accreditation.ts`, `papers.ts`, and `claims.ts` (x3). Each site is structurally identical:

```ts
try {
  await broadcastJsonWithTimeout(op);
  ...post-broadcast writes...
  sendOk(res, ...);
} catch (err) {
  if (err instanceof BroadcastTimeoutError) {
    // logger.warn (to be added per BE-ORCID-BROADCAST-ABORT-TIMEOUT round-2 hold #4)
    sendError(res, 504, 'BROADCAST_TIMEOUT', '<contextual>', {
      retriable: false,
      outcome: 'uncertain',
      verify_before_retry: true,
      timeout_ms: err.timeoutMs,
    });
  } else {
    logger.error({err, ...routeCtx}, '<route> broadcast failed');
    sendError(res, 502, 'BROADCAST_FAILED', '<contextual>', {retriable: false});
  }
}
```

Only the log context fields and user-facing message strings differ. The pattern is duplicated at 7 sites; a future 8th site will either copy correctly or drift subtly.

Maintainability M-001 (0.88) in the round-2 review.

## Goal

Introduce a helper `handleBroadcastError(res, err, opts)` in a new file `backend/src/lib/broadcast-error.ts` (or collocated with `broadcastJsonWithTimeout` in `src/hive.ts`). The helper owns:

- `instanceof BroadcastTimeoutError` discrimination
- `logger.warn` on timeout branch (with `timeoutMs` + route context)
- `logger.error` on non-timeout branch (with full error + route context)
- 504/502 `sendError` emission with the canonical envelope shape (synchronized with `agents/docs/api-contracts/common.md`)

Signature shape:

```ts
interface HandleBroadcastErrorOpts {
  timeoutMsg: string;   // user-facing message for 504
  failMsg: string;      // user-facing message for 502
  logContext: Record<string, unknown>;  // merged into both log calls
  verifyLocation?: string;  // optional UI hint (e.g., '/settings' for orcid)
}

export function handleBroadcastError(
  res: Response,
  err: unknown,
  opts: HandleBroadcastErrorOpts,
): void;
```

Migrate the 7 existing sites to call the helper. Each site shrinks from ~16 LoC to ~5 LoC.

## Non-goals

- Changing the emitted envelope shape (that is owned by the contract doc + round-2 hold decision).
- Migrating `bridge.ts` / `custody.ts` `broadcastSendOperationsWithTimeout` sites — those are the subject of `backend-bridge-custody-broadcast-discrimination.md`. Once this helper lands, that task reuses it.
- Changing log tiers.

## Acceptance

- `backend/src/lib/broadcast-error.ts` (or equivalent) exports `handleBroadcastError`.
- All 7 existing sites call the helper; per-site test coverage from `BE-ORCID-BROADCAST-ABORT-TIMEOUT` continues to pass unchanged.
- `npx tsc --noEmit` clean; full backend vitest passes.
- Grep for `sendError(res, 504, 'BROADCAST_TIMEOUT'` returns zero hits outside the helper.
- Unit tests on the helper itself: (a) `BroadcastTimeoutError` → 504 envelope + logger.warn called; (b) generic Error → 502 envelope + logger.error called; (c) log context propagates correctly.

## [TODO Architect]

None — self-contained refactor. Helper output shape is pinned to `common.md`.
