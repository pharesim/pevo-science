# BE-TESTS-ORCID-RATE-LIMIT-CLEAR-HELPER-MIGRATION — Migrate surviving inline `rl:orcid-*` clear in `orcid.test.ts` to `clearRateLimitKeys` helper

**Owner:** backend
**Created:** 2026-04-22 (surfaced by BE-TEST-RATE-LIMIT-HELPER-EXTRACT code-review 2026-04-22)
**Priority:** P3

## Context

BE-TEST-RATE-LIMIT-HELPER-EXTRACT (commit `8c1ebef`) extracted `clearRateLimitKeys(names: string[])` to `backend/tests/support/redis-helpers.ts` with a 20 × 50ms ready-wait poll on `redis.status === 'ready'`. The task consolidated 4 named call sites (2 in `recover.test.ts`, 1 in `settings-set-password.test.ts`, 1 in `signup-verify.test.ts`).

The code-review surfaced one surviving divergent caller that was out of the original task's scope:

- `backend/tests/routes/orcid.test.ts:129` — inline `beforeEach` block clears `${config.appTag}:rl:orcid-*` keys using `if (redis) ... redis.keys(...)` with no ready-wait poll.

Same silent-no-op trap the helper was built to fix: if Redis is mid-connect during `beforeEach`, the clear silently skips and the next request can hit 429.

## Goal

Replace the inline `beforeEach` clear with a single `await clearRateLimitKeys(['orcid-start', 'orcid-callback'])` call (confirm the exact limiter names at implementation time by grepping `backend/src/routes/orcid.ts` for `rateLimit(...)` definitions).

Example target shape:

```ts
import { clearRateLimitKeys } from '../support/redis-helpers.js';

beforeEach(async () => {
  await clearRateLimitKeys(['orcid-start', 'orcid-callback']);
});
```

Grep as a post-fix check: `setTimeout\|redis\.keys.*:rl:` under `backend/tests/routes/orcid.test.ts` should return only the debounce/retry timers, no inline rate-limit clears.

## Non-goals

Auditing every Redis-state-clearing helper across the test suite. Scope is tight to the single known divergent caller identified by R1's review.

## Acceptance

- `orcid.test.ts:129` block replaced with one `clearRateLimitKeys(...)` call.
- Full backend vitest suite passes.
- No bare inline `redis.keys('${config.appTag}:rl:*')` call in `backend/tests/routes/orcid.test.ts` after the migration.

## [TODO Architect]

None — self-contained test-helper consolidation.
