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

## Architect re-review (2026-06-09) — HELD PENDING FIXES:

`/ce-code-review` (correctness + security + adversarial on Opus; testing, maintainability, project-standards, kieran-typescript, learnings on Sonnet; ce-agent-native skipped per PEvO) on commit 7ba91d73. **F1 and F2 are largely correct and the core deliverable is sound:** the decisive round-trip assertion (`reissuedAt === stored.getTime()`) is genuinely mutation-killing — it reads `sessions_invalidated_at` back from real Postgres and goes RED on a `NOW()`/seconds-rounding regression in `recover.ts` (correctness, security, and testing all confirmed); the real `verifyHiveSignature` and real `jsonwebtoken` run (no `MOCK_VERIFY_SIGNATURE`); the F2 scope comment is factually accurate against `recover.ts` (both reissue sites write `sessions_invalidated_at` from a Node `Date` and embed `reissuedAt`) and the `/api/auth/reset` SQL-`NOW()`/no-token path. Two items before archive:

1. **Survive-case can pass for the wrong reason (P2; adversarial finding corroborated by correctness residual, conf 100).** The "reissued token SURVIVES" assertion is meant to prove survival comes from the `reissuedAt === invalidatedAtMs` identity match. But `invalidatedAt = new Date()` is captured in the `/recover/verify` handler BEFORE its DB transaction, and `jwt.sign` stamps the reissued token's `iat` AFTER the COMMIT — so if the reissue transaction crosses an integer-second boundary, the reissued token's `iat` becomes `invalidatedSec + 1` and it survives via the trivial `iat > invalidatedSec` branch, with `reissuedAt` never deciding. The test never establishes the same-second precondition its survive-case depends on, so on a boundary-crossing run the discrimination it claims is vacuous. (The decisive round-trip assertion does NOT read `iat`, so there is no false-green on the round-trip claim itself — only the survive-case's discrimination is occasionally non-load-bearing.) Fix: after decoding the reissued token, pin the same-second precondition with `expect(decoded?.iat).toBe(Math.floor(storedMs / 1000))`; OR make the discrimination deterministic by minting a control token carrying `iat: invalidatedSec` AND `reissuedAt: storedMs` and asserting it SURVIVES (200), alongside the existing pre-reset control (`iat: invalidatedSec`, no `reissuedAt`) that must be REVOKED — so survival is pinned to the `reissuedAt` identity at a fixed shared second rather than to the handler's nondeterministic sign-time `iat`.

2. **Account fixture seeds an off-§6.1 state (P3; learnings, per the `account-state-fixture-must-satisfy-all-dimensions` convention).** The `accounts` INSERT seeds `custody='light'`, `verify_token=NULL` but omits both `password_hash` and `orcid` (both end up NULL) — a combination no reachable account state has for a light account. It is green only because the `/recover/verify` apply path reads just `custody` and `upgraded_at`, but the fixture-reachability convention applies regardless of which dimensions the route happens to read. Fix: seed a reachable account state (add a sentinel `password_hash` so the row is a genuine light/password-set account) and name that state in the fixture comment by its dimension tuple (light, password-set, no ORCID, not upgraded) — NOT by a `§ N.M` section anchor, which the comment-anchor convention forbids in test source; the dimension description is the stable form. If an authless row is intentional for this specific test, document why explicitly instead.

Spun off as a separate follow-up (NOT held here): the ORCID-recovery reissue site in `recover.ts` (the other reissue writer, sharing the identical Node-`Date` + `reissuedAt` idiom) is not covered by a real-DB round-trip pin — only the memo-key `/recover/verify` path is. Four reviewers (correctness, security, testing, learnings) flagged this as a second-site coverage gap. Filed as `backend-reissuedat-roundtrip-orcid-site` in `tasks/pending/`.

Dismissed at triage: the F2 comment partly restating the same-second mechanism already in the comment block above it (the prose is accurate; re-splitting adds little); the test header citing the CLAUDE.md carve-out clause letters "(a)/(b)/(c)" as anchors (project-standards judged this is not a violation — the "Running Tests" section is named and the clause letters exist, so it is a stable reference today).

Move back to `tasks/review/` once items 1 and 2 land; the move is the re-review signal. The next review scopes to the fix commits only.
