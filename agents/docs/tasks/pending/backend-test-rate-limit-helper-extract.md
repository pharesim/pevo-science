# BE-TEST-RATE-LIMIT-HELPER-EXTRACT — Shared `clearRateLimitKeys` helper for vitest suites

**Owner:** backend
**Created:** 2026-04-21 (surfaced by SEC-LOGIN-UNKNOWN-USER-TIMING maintainability review 2026-04-21)
**Priority:** P3

## Context

As of commit `6c9a1e0`, the same rate-limit-clearing pattern now lives in four places with subtly diverging implementations:

1. `backend/tests/routes/recover.test.ts:446` — `clearRateLimitKeys` (NEW, adds a ready-wait poll loop for up to 1 second on `redis.status !== 'ready'`).
2. `backend/tests/routes/recover.test.ts:259` — `clearRecoverRateLimit` (older, uses `isRedisAvailable()` guard).
3. `backend/tests/routes/settings-set-password.test.ts` — `clearSettingsRateLimits` (older `isRedisAvailable()` guard variant).
4. `backend/tests/routes/signup-verify.test.ts` — `clearSignupRateLimit` (older `isRedisAvailable()` guard variant).

The new variant's ready-wait poll is the correct form — older variants silently no-op if Redis is mid-connect when the helper fires. A future test author copying the wrong variant inherits the silent-no-op trap.

## Goal

Extract a single `clearRateLimitKeys(names: string[])` helper to `backend/tests/support/redis-helpers.ts` (create the directory if it doesn't exist) with the ready-wait poll approach. Replace all four local variants.

**Helper shape:**

```ts
export async function clearRateLimitKeys(names: string[]): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  // Wait up to ~1s for Redis to be ready; silently return if it never is.
  for (let i = 0; i < 20 && redis.status !== 'ready'; i++) {
    await new Promise((r) => setTimeout(r, 50));
  }
  if (redis.status !== 'ready') return;
  for (const name of names) {
    const keys = await redis.keys(`${config.appTag}:rl:${name}:*`);
    if (keys.length > 0) await redis.del(...keys);
  }
}
```

Callers become:

```ts
import { clearRateLimitKeys } from '../support/redis-helpers.js';

beforeEach(async () => {
  await clearRateLimitKeys(['resend', 'login', 'recover']);
});
```

## Non-goals

Resetting the in-memory `memStore` fallback when Redis is unavailable. That requires exporting a test hook from `rateLimit.ts` itself (`resetMemStore()`) and is a separate concern — this helper intentionally no-ops on Redis-unavailable (callers that need memStore reset must either skipIf or use a dedicated test-only export).

## Acceptance

- All four test files use the shared helper.
- Full backend vitest suite passes (39 files / 268 pass + skips).
- Header comment on the helper cites the ready-wait rationale so future authors don't downgrade it.

## [TODO Architect]

None — self-contained test-infra refactor.
