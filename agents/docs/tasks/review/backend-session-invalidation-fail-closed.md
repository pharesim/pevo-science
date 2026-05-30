# BACKEND-SESSION-INVALIDATION-FAIL-CLOSED — return 503 instead of accepting JWT when sessions_invalidated_at lookup fails

**Owner:** Backend Agent
**Created:** 2026-05-30 (security audit workflow)
**Priority:** P2 (silent fail-open of password-reset revocation during DB hiccups)

## Problem

In `backend/src/middleware/verifyHiveSignature.ts` the JWT path queries `accounts.sessions_invalidated_at` to reject JWTs minted before a password-reset, e.g.

```ts
try {
  const { rows } = await pool.query(
    'SELECT sessions_invalidated_at FROM accounts WHERE username = $1',
    [payload.sub],
  );
  if (rows.length > 0 && rows[0].sessions_invalidated_at) {
    const invalidatedAt = Math.floor(rows[0].sessions_invalidated_at.getTime() / 1000);
    if (payload.iat < invalidatedAt) {
      return sendError(res, 401, 'SESSION_INVALIDATED', ...);
    }
  }
} catch (dbErr) {
  logger.warn({ err: dbErr }, 'Session invalidation check failed - allowing request');
}
```

The unscoped catch swallows connection errors, query timeouts, transient Postgres outages, and SQL misconfigurations, then proceeds to `next()` with the JWT honored. During any Postgres unavailability, every previously-invalidated JWT becomes usable again until the issue resolves.

Password-reset on a light account is the explicit revocation mechanism for a stolen JWT. A brief DB outage during an active compromise silently re-grants the attacker access for the duration. The post-key-rotation window (light account upgrading to self-custody) is the highest-stakes case — it is exactly when an attacker who captured the pre-rotation encrypted key store would race to use any pre-rotation JWT.

PEvO is single-instance (per project memory) — a Postgres hiccup is not a load-balanced multi-tenant blip; it's the whole product unavailable. Fail-closed during that window is the right posture.

## Goal

Convert the catch-and-allow into a catch-and-503: when the JWT carries an `iat` claim and the invalidation lookup fails for any reason, return 503 `SERVICE_UNAVAILABLE` ("Session check temporarily unavailable. Please retry.") rather than calling `next()` with the JWT honored.

The existing `if (pool)` early-skip (when `getAppPool()` returns null, e.g. startup-before-pool-ready) is fine to keep — that path is a configuration state, not a runtime failure. The query-failure branch is the only one that needs to change.

## Fix sketch

```ts
} catch (dbErr) {
  logger.error({ err: dbErr }, 'Session invalidation check failed');
  return sendError(res, 503, 'SERVICE_UNAVAILABLE', 'Session check temporarily unavailable. Please retry.');
}
```

User-facing message uses period-separated sentences (CLAUDE.md: no emdashes in user-facing text).

## Acceptance

1. **Fail-closed test.** Inject a query failure (mock pool whose `.query` rejects, or via the same scaffold as the existing tests for this middleware). A JWT with an `iat` claim that would otherwise pass through is rejected with 503 `SERVICE_UNAVAILABLE`. The log emits at `error` level, not `warn`.
2. **Pool-not-ready path still skips harmlessly.** When `getAppPool()` returns null (startup transient), the middleware does NOT 503 — it follows the existing skip. Test pinning this branch.
3. **Happy-path unchanged.** JWT minted after `sessions_invalidated_at` (or with no invalidation row) still passes through. JWT minted before passes the existing 401 `SESSION_INVALIDATED`. Both branches covered by existing tests; verify they still pass.
4. **Mutation-kill:** revert the catch → 503 conversion → the new fail-closed test goes RED.

## Out of scope

- Adding a circuit-breaker / retry loop around the lookup (over-engineering for a single-instance deployment).
- Caching `sessions_invalidated_at` in Redis to reduce per-request load (separate optimization, not a security fix).
- Distinguishing connection-error from query-error in the response (both map to 503; the operator log carries the underlying error for diagnosis).

## References

- `backend/src/middleware/verifyHiveSignature.ts` — the catch block in question; the surrounding JWT-validation flow.
- `backend/src/routes/auth.ts` (or `settings.ts`) — the password-reset path that writes `sessions_invalidated_at`.
- `backend/src/routes/custody.ts` — fresh-auth-proof routes that ALSO depend on the invalidation check (those paths require argon2 against the rotated `password_hash`, so they're naturally re-protected after reset; this task patches the surface they don't cover).
- CLAUDE.md "Carve-out for deterministic edge-case coverage" — mock-pool injection is permitted under clause (a) for this test (the real DB-failure path is impractical to exercise per-test).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
