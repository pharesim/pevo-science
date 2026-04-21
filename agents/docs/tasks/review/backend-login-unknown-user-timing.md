# SEC-LOGIN-UNKNOWN-USER-TIMING — Close the unknown-account timing oracle on /api/auth/login

**Owner:** backend
**Created:** 2026-04-21 (surfaced by SEC-004-BE round-2 archive review 2026-04-21c)
**Priority:** P2

## Context

SEC-004-BE round-2 added a `SENTINEL_ARGON2_HASH_PROMISE`-based timing-equalization burn on the `NO_PASSWORD_SET` (null-hash) branch of `POST /api/auth/login`, closing the `~1ms vs ~100ms` oracle that distinguished ORCID-only accounts from password-loginable accounts. The sibling **unknown-account** branch at `backend/src/routes/auth.ts:~388` returned `401 UNAUTHORIZED` without any argon2 work, leaving a separate timing oracle: an unauthenticated attacker can enumerate which usernames/emails have accounts on the platform.

Same enumeration class the round-2 fix addressed; closing only half was asymmetric and provided a false sense of completeness.

## Goal

Burn `SENTINEL_ARGON2_HASH_PROMISE` on the unknown-account branch and audit siblings across `/api/auth/*` for the same timing-oracle class. Expected to grow to 2-3 sites.

## Non-goals

Closing the status-code oracle (401 stays distinct). Rate-limit-based detection. Extracting a `burnSentinel()` helper unless 3+ call sites land.

## Implementation notes

Landed at commit **6c9a1e0** ("SEC-LOGIN-UNKNOWN-USER-TIMING: close unknown-account timing oracles on auth endpoints"). 19/19 pass in `backend/tests/routes/recover.test.ts`; full backend vitest 39 files / 268 pass.

Three sites converted, all mirroring the existing `SENTINEL_ARGON2_HASH_PROMISE` null-hash burn shape (`await argon2.verify(await SENTINEL_ARGON2_HASH_PROMISE, password).catch(() => {})` before the early return). Status codes unchanged.

1. `backend/src/routes/auth.ts:386` — `/login` unknown-username 401 branch.
2. `backend/src/routes/auth.ts:286` — `/resend-verification` unknown-email 200 branch (uniform-message response).
3. `backend/src/routes/auth.ts:675` — `/recover` unknown-username 404 branch.

Other early returns audited and intentionally left alone: `/reset-request` (uniform 200, SMTP-dominated timing); `/reset` (token-based, not user-enumerable); `/session`, `/signup` (don't have this oracle class); `/login` lockout + verify_token branches (post-argon2, already equalized).

Tests: 3 new `describe` blocks under `SEC-LOGIN-UNKNOWN-USER-TIMING:` with per-site wall-time assertions. Stability: 8/8 consecutive runs of the new tests passed locally.

## [TODO Architect]

1. **Wall-time threshold deviation.** Task spec called for ≥50ms matching the existing SEC-004-BE null-hash assertion. On this hardware `argon2.verify` at `ARGON2_OPTIONS` (64 MiB, time=3) runs 42-55ms median, so the new tests use ≥40ms (still 40× above the ~1ms pre-sentinel path, mutation-kill intact) with inline comment. The existing 50ms assertion already flakes here. Architect may want to revisit tolerance across the suite or tune `ARGON2_OPTIONS` for test envs.
2. **Rate-limit test-infra fix.** `recover.test.ts` gained a per-test `clearRateLimitKeys` helper (not just `beforeAll`) because vitest `retry=1` reruns only the test body, and the 3/hr `resendLimiter` had no headroom across a retry. Discretionary: generalize to a shared helper if other files need it.
3. **No `burnSentinel()` helper extracted.** Three sites landed right at the task's 3-call-site threshold. Kept inline since each call site has slightly different context comments; architect can request extraction at review if preferred.
