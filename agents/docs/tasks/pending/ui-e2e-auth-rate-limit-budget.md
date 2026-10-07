# E2E runs can exhaust the per-IP auth rate limits once tests retry

**Owner:** ui
**Created:** 2026-10-07
**Priority:** low

Filed from the architect review of `ui-revoked-session-e2e-real-path` (archived 2026-10-07), where
the correctness reviewer raised it as a residual risk. The user approved filing it.

## Why

The backend's auth limiters in `backend/src/routes/auth.ts` are keyed by IP, and every e2e test
comes from the same IP. `loginLimiter` allows 10 requests per hour; `resetRequestLimiter` and
`resetLimiter` allow 5 each. `frontend/tests/e2e/global-setup.js` deletes the `${appTag}:rl:*`
keys once, before the run, and `frontend/playwright.config.js` sets `retries: 1`.

The reviewer counted 9 real `POST /api/auth/login` calls across the e2e specs. Each retry of a
login-consuming test spends another one, so two such retries in one run push the next login to
429, which then fails a test that has nothing wrong with it. The reset endpoints have a lower
limit and fewer callers (`password-recovery.spec.js` and `session-revoked.spec.js`).

This may explain some of the failures already standing in the e2e suite. It is not confirmed.

## Scope

1. Count, per run, every real request to an IP-keyed auth limiter, including the retry case, and
   record the counts in this file.
2. Make a run's results independent of how many limited calls earlier tests made. One option is
   clearing the `${appTag}:rl:*` keys before each test in a shared fixture rather than once per
   run. Do not raise or bypass the limits in the backend for the test stack.
3. Check whether any of the e2e failures already standing are 429s from these limiters, and say
   which in the signal block.

## Acceptance criteria

1. A full e2e run in which login-consuming tests retry hits no 429 from an auth limiter.
2. The backend's limiter values are unchanged.
