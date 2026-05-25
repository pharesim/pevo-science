# BACKEND-EXTRACT-RECOVER-FROM-AUTH-TS — Split recover/verify/dispute handlers + helpers into routes/recover.ts

**Owner:** backend
**Created:** 2026-05-25 (architect, surfaced by /ce-code-review on backend-recover-email-verification-and-notify; kieran-typescript + maintainability persona)
**Priority:** P3 (organizational; deferred from recover-email closure)

## Problem

`backend/src/routes/auth.ts` grew substantially after the recover-email landing — the file is now ~1700 lines. The `/recover`, `/recover/verify`, `/recover/dispute` handlers form a coherent ~565-line subdomain that shares its own constants (`RECOVERY_VERIFY_TOKEN_EXPIRY_MS`, `RECOVERY_DISPUTE_TOKEN_EXPIRY_MS`), schemas (`RecoverBodySchema`, `RecoverTokenBodySchema`), rate limiter (`recoverLimiter`), helpers (`forensicDigest`, `emailDomain`), and the new `pending_recovery` DB shape.

A `routes/recover.ts` split would cap `auth.ts` size, keep the recovery state machine co-located with the code that enforces it, and reduce navigation cost in `auth.ts`.

## Goal

Extract the recovery trio + their owned helpers / schemas / constants into a new module `backend/src/routes/recover.ts`. Mount under the same `/api/auth/` path prefix in the route registration.

## Acceptance

- `backend/src/routes/recover.ts` contains the three handlers (`/recover`, `/recover/verify`, `/recover/dispute`) + recover-specific schemas + expiry constants + `recoverLimiter`.
- `backend/src/routes/auth.ts` no longer contains recover-specific code or helpers; imports nothing from `recover.ts`.
- Wherever routes are registered, both files mount under `/api/auth/`.
- Existing test files (`recover.test.ts`, `recover-two-phase.test.ts`) pass without modification — the wire-shape is identical.
- No behavior change. Verified by full test run on the affected suites + typecheck + lint clean.

## Dependencies / coordination

- Best done AFTER `backend-log-pii-helper-consolidation` lands (so `forensicDigest` is already in `lib/log-pii.ts`). The order is not strict — both can land in either sequence — but `recover.ts` inherits the consolidated import path cleanly if log-pii lands first.

## Non-goals

- Behavioral changes inside the handlers. Any defect repairs are out of scope; file as separate tasks.
- Renaming the routes or response shapes.
- Splitting tests further. Existing test files stay where they are.

## References

- `backend/src/routes/auth.ts` — extraction source (the recover trio is the bottom third of the file)
- `backend/migrations/012_pending_recovery.sql` — companion schema (unchanged by this work)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
