# BACKEND-REISSUEDAT-ROUNDTRIP-REALPATH-TEST — pin the reissuedAt↔sessions_invalidated_at round-trip with a real-DB test; document the /reset same-second edge

**Owner:** Backend Agent
**Created:** 2026-06-09 (architect review of backend-verifyhivesignature-preexisting-replay-revocation-hardening, commit 9ac96ba2)
**Priority:** P2 (test-coverage gap on a high-stakes invariant + a one-line doc comment; no current defect)

## Background

The same-second JWT-revocation fix spares the legitimately-reissued post-reset token by identity: `verifyHiveSignature` revokes `iat <= invalidatedSec` EXCEPT the token whose `reissuedAt` claim equals `sessions_invalidated_at.getTime()` read back from Postgres. `routes/recover.ts` (`/recover` and `/recover/verify`) writes `sessions_invalidated_at` from a Node `Date` and embeds that exact epoch-ms in the reissued token. The correctness of "reissued token survives" depends on the **DB round-trip preserving the millisecond exactly**: `reissuedAt` (embedded at mint) must equal `rows[0].sessions_invalidated_at.getTime()` (read back).

It holds today: the column is `TIMESTAMPTZ`, a JS `Date` is millisecond-precision, and no custom pg type parser is registered, so the round-trip is exact (verified during review). But the only test for this behavior mocks `getAppPool` to return a hand-built `Date` from the SAME constant the token embeds, so it is tautological for the round-trip and never exercises the real recover → Postgres → middleware path. The CLAUDE.md test-carve-out clause-(c) real-path companion is effectively absent: `recover.test.ts` does not decode the reissued JWT or compare its `reissuedAt` to the stored row.

Risk if unaddressed: a future change that switches either reissue writer back to SQL `NOW()` (microsecond precision) or otherwise perturbs the round-trip would silently log out every user immediately after a password reset, with the existing suite staying green.

## Goal

1. **Real-path round-trip test (F1).** Add a test that, against the real app Postgres (no mocked pool for the round-trip), drives an actual recover reissue (`/recover` or `/recover/verify`), reads back the stored `sessions_invalidated_at`, and confirms the reissued token presented to the real `verifyHiveSignature` SURVIVES (200, not 401 `SESSION_INVALIDATED`) while a pre-reset same-second token is REVOKED. The decisive assertion is that the reissued token's `reissuedAt` equals the round-tripped `sessions_invalidated_at.getTime()`. This also retroactively guards the maintainability concern (a `NOW()`/seconds-rounding regression in `recover.ts` turns this test RED). Real-path companion per CLAUDE.md test carve-out clause (c); auth-focused, so run the real `verifyHiveSignature` and real crypto (clause b), no `MOCK_VERIFY_SIGNATURE`.

2. **Document the same-second self-healing edge (F2).** Add a one-line invariant comment near the `iat <= invalidatedAtSec && payload.reissuedAt !== invalidatedAtMs` comparison in `verifyHiveSignature.ts` noting that the `reissuedAt` exemption covers only the `recover.ts` reissue sites: a `/api/auth/reset` → `/api/auth/login` relogin completed within the same integer second as the reset is revoked on its first request and self-heals on the next login. Anchor the comment on stable symbols (no task slug, line number, or SHA). The architect documented the same edge in ARCHITECTURE § 6.7.

## Out of scope / accepted residuals (do NOT implement)

- Closing the same-second `/reset` → `/login` edge in logic (sub-second, self-healing, email-reset-path only — accepted; document only).
- A runtime `typeof` guard on `reissuedAt` (safe-direction: a non-number `reissuedAt` revokes, never admits).
- A size cap on the in-memory `seenSignatures` replay-fallback map (bounded by the existing TTL sweep; single-instance).

## References

- `backend/src/middleware/verifyHiveSignature.ts` — the `iat <= invalidatedAtSec && reissuedAt !== invalidatedAtMs` comparison.
- `backend/src/routes/recover.ts` — the two reissue sites that write `sessions_invalidated_at` (Node `Date`) and embed `reissuedAt`.
- `backend/tests/middleware/verifyHiveSignature-replay-revocation-hardening.test.ts` — the existing mocked (tautological-for-round-trip) test.
- `agents/docs/ARCHITECTURE.md` § 6.7 — the session-invalidation overlay + round-trip "do not break" note.
- CLAUDE.md "Carve-out for deterministic edge-case coverage" clause (c).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>

## Backend completion note (2026-06-09)

**F1 (real-path round-trip).** Added `backend/tests/middleware/verifyHiveSignature-reissuedat-roundtrip.test.ts`. Against real app Postgres (no mocked pool) it seeds a light account + a `pending_recovery` row, drives a genuine `POST /api/auth/recover/verify` reissue, reads back `sessions_invalidated_at`, and asserts the reissued JWT's `reissuedAt === stored.getTime()`. It then presents the reissued token to the REAL `verifyHiveSignature` (SURVIVES, 200) alongside a pre-reset same-second token with no `reissuedAt` (REVOKED, 401 `SESSION_INVALIDATED`). Real middleware + real `jsonwebtoken`; no `MOCK_VERIFY_SIGNATURE`. Only `getRedis`/`isRedisAvailable` are stubbed to the in-memory fallback (enumerated carve-out scope) so the byIp `recoverLimiter` is process-local under cross-file Redis contention; `getAppPool` stays REAL — the round-trip is the point. Skips cleanly when Postgres is unreachable (mirrors `recover.test.ts`). A future `recover.ts` switch to SQL `NOW()` (microsecond) or seconds-rounding turns the decisive assertion AND the survive case red.

**F2 (doc comment).** Added a scope note beside the `iat <= invalidatedAtSec && reissuedAt !== invalidatedAtMs` comparison in `verifyHiveSignature.ts`: the exemption is keyed ONLY to the `recover.ts` reissue sites; `/api/auth/reset` (sets `sessions_invalidated_at`, returns no token) followed by a separate `/api/auth/login` relogin in the same integer second is revoked on its first request and self-heals on the next login (accepted sub-second residual). Anchored on stable symbols (no slug/line/SHA).

**Out of scope (left as-is per task):** the same-second `/reset`→`/login` logic edge (documented only), a `typeof` guard on `reissuedAt`, a size cap on `seenSignatures`.

**Verification:** `npm run typecheck` (src + tests) + `npm run lint` clean (the lone lint warning is a pre-existing unused-directive in `lib/author-supersession.ts`, untouched); `verifyHiveSignature-reissuedat-roundtrip.test.ts` + `verifyHiveSignature-replay-revocation-hardening.test.ts` green (6 tests).
