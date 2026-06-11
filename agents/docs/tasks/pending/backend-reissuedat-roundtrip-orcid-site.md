# BACKEND-REISSUEDAT-ROUNDTRIP-ORCID-SITE — extend the reissuedAt round-trip pin to the ORCID-recovery reissue writer

**Owner:** Backend Agent
**Created:** 2026-06-09 (architect review of backend-reissuedat-roundtrip-realpath-test, commit 7ba91d73)
**Priority:** P3 (second-site test-coverage gap; no current defect)

## Background

`backend-reissuedat-roundtrip-realpath-test` added a real-DB round-trip test pinning that a recover-reissued JWT's `reissuedAt` claim equals `sessions_invalidated_at.getTime()` read back from Postgres, so the same-second JWT-revocation exemption in `verifyHiveSignature` survives a real recover -> Postgres -> middleware path. That test drives the **memo-key `/api/auth/recover/verify`** reissue site only.

`recover.ts` has a **second** reissue writer: the ORCID-recovery path (the `/api/auth/recover` ORCID branch), which writes `sessions_invalidated_at` from a Node `Date` and embeds `reissuedAt` using the **identical idiom**. Four reviewers (correctness, security, testing, learnings) flagged that a `NOW()`/seconds-rounding regression isolated to the ORCID branch would NOT turn the existing memo-key test red. This is a defense-in-depth gap, not a current defect: both sites share one idiom, and the dominant path is pinned.

## Goal

Add a real-DB round-trip pin for the ORCID-recovery reissue site, mirroring the memo-key test's decisive assertion: drive a genuine ORCID-path reissue, read back `sessions_invalidated_at`, and assert the reissued token's `reissuedAt === stored.getTime()` (and that the token survives the real `verifyHiveSignature` same-second gate while a pre-reset same-second token without `reissuedAt` is revoked).

## Notes / approach hint

- The ORCID branch normally depends on a verified-ORCID nonce. In the existing memo-key test, `getRedis`/`isRedisAvailable` are stubbed to the in-memory fallback (enumerated carve-out), which makes `recover.ts` fall through to the `orcidVerified` in-memory map from `orcid.js`. Investigate seeding an `orcidVerified` entry so the ORCID branch is reachable deterministically in a test, OR document why the real path is impractical and satisfy the carve-out clause (c) via a reasoned dismissal.
- Reuse the existing test's structure (`verifyHiveSignature-reissuedat-roundtrip.test.ts`): real `getAppPool`, real `verifyHiveSignature` + real `jsonwebtoken` (auth-focused, no `MOCK_VERIFY_SIGNATURE`), skip cleanly when Postgres is unreachable.
- Anchor any new comments on stable symbols (no line numbers, task slugs, SHAs, or `§ N.M` anchors), per the comment-anchor convention.

## Acceptance

1. A real-DB (or carve-out-justified) test drives the ORCID-recovery reissue and asserts `reissuedAt === stored.getTime()` from a read-back; the assertion goes RED on a `recover.ts` ORCID-branch switch to SQL `NOW()` or seconds-rounding.
2. Real `verifyHiveSignature` + real crypto on the auth assertions; the mock carve-out (if any) is documented in the test header per clause (a)/(b)/(c).
3. `npm run typecheck` + `npm run lint` clean; the new test green.

## References

- `backend/src/routes/recover.ts` — the ORCID-recovery reissue site (writes `sessions_invalidated_at` from a Node `Date`, embeds `reissuedAt`).
- `backend/tests/middleware/verifyHiveSignature-reissuedat-roundtrip.test.ts` — the memo-key companion to mirror.
- `agents/docs/ARCHITECTURE.md` § 6.7 — the session-invalidation overlay + round-trip "do not break" note.
- CLAUDE.md "Carve-out for deterministic edge-case coverage" clause (c).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>

## Backend completion note (2026-06-09)

Added `backend/tests/middleware/verifyHiveSignature-reissuedat-orcid-roundtrip.test.ts`, the ORCID-branch companion to the memo-key round-trip test. Against real app Postgres (no mocked pool) it seeds a reachable `(custody=light, password-unset, ORCID-set, not upgraded)` account, stubs `getRedis`/`isRedisAvailable` to the in-memory fallback (enumerated carve-out) so the recover ORCID branch reads `orcid.js`'s in-memory `orcidVerified` map, seeds a verified-ORCID nonce there, drives a genuine `POST /api/auth/recover` ORCID reissue, reads back `sessions_invalidated_at`, and asserts the reissued JWT's `reissuedAt === stored.getTime()`. A `NOW()`/seconds-rounding regression isolated to the recover.ts ORCID branch turns the decisive assertion red. The same-second survival is pinned deterministically with the control-token pair (one with `reissuedAt === storedMs` survives, one without at the same integer second is revoked), matching the memo-key companion's discrimination shape; real `verifyHiveSignature` + real `jsonwebtoken`, no `MOCK_VERIFY_SIGNATURE`. Skips cleanly when Postgres is unreachable.

Verification: `npm run typecheck` (src + tests) + `npm run lint` clean (lone pre-existing `author-supersession.ts` warning untouched); the new test green against real app Postgres (1 passed).

## Architect re-review (2026-06-11) — HELD PENDING FIXES (1 item)

First review of commit `ca28def2` via `/ce-code-review` (correctness + security + adversarial on the session model; testing/maintainability/project-standards/learnings on Sonnet; ce-agent-native skipped per PEvO). **The test is verified SOUND on substance — zero findings from all five code reviewers; do not redo it:** the request body makes the memo-key branch unreachable and the ORCID reissue is the only token-bearing 200 on `/recover`, with the status asserted before the decisive assertion; the in-memory `orcidVerified` fallback is a genuine production path (`orcid.ts` writes it Redis-down, `recover.ts` reads it Redis-down) and the `sessions_invalidated_at` write + `reissuedAt` embed sit unconditionally downstream of the nonce-store branch merge, so the pin is not fallback-vacuous; the direct nonce seeding bypasses only non-load-bearing surface (account lookup, severance gate, nonce expiry, ORCID-match all run real) and the header documents it under clause (a); the fixture is a reachable ORCID-only light state with the enumerated recover transition; mutation coverage of the NOW()-switch / seconds-rounding / re-derived-Date / write-but-no-embed regressions confirmed; carve-out clauses (a)/(b)/(c) present; anchors clean. One item before archive:

1. **(P2, process; quotable convention) Add the revert-probe attestation.** The completion note CLAIMS "a NOW()/seconds-rounding regression isolated to the recover.ts ORCID branch turns the decisive assertion red" but does not attest a performed probe. Per `tests-must-fail-on-mutation-of-code-under-test` (How to apply #1-2): mutate the `recover.ts` ORCID-branch reissue (e.g. seconds-round the embedded `reissuedAt`, or switch the `sessions_invalidated_at` write to SQL `NOW()`), run the suite, confirm the decisive assertion goes red, restore, confirm green, and state "confirmed the spec fails on revert of <stable symbol>" in the re-review signal block.

No action sought (advisory, fold in only if touching the file anyway): rename `preReset` -> `controlWithoutReissue` (same naming-axis asymmetry as the memo-key sibling; rename both files or neither — the sibling's hold carries the same advisory). Residuals recorded, no action: the nonce single-use replay assertion is owned by `recover.test.ts`; the Redis-backed nonce arm is exercised real-path there too; the same-second wrong-ms exemption pin is homed in the mocked hardening sibling per the memo-key task's hold (do not duplicate it here).

When the item lands, `git mv` this file back to `tasks/review/`; the move is the re-review signal, scoped to the fix commit only. Do not edit this hold block — the commit diff is the evidence; the architect updates it at re-review.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
