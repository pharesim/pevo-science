# BACKEND-BROADCAST-ATTEMPTS-KEY-IMPORT-SWEEP-REST-OF-TEST-SUITE — Migrate remaining test files to imported `broadcastAttemptsKey`

**Owner:** Backend
**Created:** 2026-05-19 (architect, from verify-cluster review triage on commits `12e12f7` + `ccfc614`)
**Priority:** P3 (maintainability follow-up; no behavioral defect)

## Why now

The round-3 hold on `backend-verify-cap-redis-flap-recovery` migrated `backend/tests/lib/pending-decrement-queue.test.ts` from a local `counterKey` helper to the imported `broadcastAttemptsKey` exported from `backend/src/routes/accreditation.ts`. `backend/tests/routes/admin.test.ts` was already on the import. Two test files were NOT in that round's scope and still construct the broadcast-attempts Redis key inline as `${config.appTag}:pending_accred_broadcast_attempts:${token}`:

- `backend/tests/routes/accreditation.test.ts` — 5 inline copies (one at the `broadcastAttemptCount` helper around line 514, plus several local `counterKey` assignments around lines 552, 713, 790, 980, 1225). Exact site list to be confirmed from current file state at implementation time.
- `backend/tests/routes/accreditation-idempotency.test.ts` — 6 inline copies (around lines 124, 143, 231, 499, 735, 827). Site list to be confirmed.

Surfaced as a P3 maintainability + project-standards finding in the verify-cluster `/ce-code-review` triage. Filed as a separate task rather than expanded round-N scope because the work is pre-existing (not introduced by either reviewed commit) and naturally batches with sibling test-file cleanups.

## Goal

Replace every inline template-string copy of the broadcast-attempts key in the two cited test files with `broadcastAttemptsKey(token)` imported from `../../src/routes/accreditation.js`. Single source of truth for the key string lives in `accreditation.ts` after this sweep.

## Acceptance

### 1. `backend/tests/routes/accreditation.test.ts`

- Add `import { broadcastAttemptsKey } from '../../src/routes/accreditation.js';` at the existing import block (no fan-out — one import line).
- Replace every inline `${config.appTag}:pending_accred_broadcast_attempts:${token}` template literal and every local `counterKey(token)` helper call with `broadcastAttemptsKey(token)`. Verify by grep that no inline form survives.
- If the inline `broadcastAttemptCount` helper (around line 514) is locally defined and uses the template string, replace its body to call `broadcastAttemptsKey(token)`. If the helper is now redundant (single call site, no other logic), inline-substitute at the call sites and remove the helper — judgment call.
- Remove the `config` import if no other usage remains after the substitution (mirror the `pending-decrement-queue.test.ts` round-3 cleanup pattern).

### 2. `backend/tests/routes/accreditation-idempotency.test.ts`

- Add `import { broadcastAttemptsKey } from '../../src/routes/accreditation.js';` (if not already present from a future merge with sibling tasks).
- Replace every inline template-string copy with `broadcastAttemptsKey(token)`. Verify by grep.
- If a `readBroadcastAttemptsCounter` helper or similar (around line 124) wraps the key construction, update its body to call `broadcastAttemptsKey(token)`.
- Remove `config` import if redundant after the substitution.

### 3. Out of scope

- `backend/tests/logger-redact.test.ts` — the inline `pevo-test:pending_accred_broadcast_attempts:*` or `pevotest:...` literals there assert the serialized string shape at the pino boundary; those tests pin the redaction behavior at the log boundary, not live Redis-key construction. Do NOT substitute these — the test is asserting against the exact emitted string.
- Production code (`backend/src/`) — already single-source-of-truth post-round-3 cap-redis-flap-recovery.
- The `${config.appTag}:pending_accred_broadcast_attempts:*` AOF cleanup in `tests/support/` setup/teardown if any — out of scope unless it cleanly substitutes (some teardown patterns use the key as a glob prefix where the helper-call shape doesn't fit). Judgment call at implementation time.

### 4. Verification

- `npm run typecheck` (backend `:src` and `:tests`): clean.
- `npm run lint`: clean.
- `npx vitest run tests/routes/accreditation.test.ts tests/routes/accreditation-idempotency.test.ts` (with Docker IP env overrides per root CLAUDE.md "Running Tests"): no new failures introduced. Pre-existing failures noted in prior task signal blocks (free-email-provider 500, yahoo 500, round-4 hold #2 503-vs-502 SMTP-shape, BE-ACCRED-REQ-LIMITER, etc.) are still in scope for separate cleanup; do not chase them here.

## Source

- `/ce-code-review` cluster pass on verify cluster (commits `12e12f7` + `ccfc614`), 2026-05-19. Maintainability + project-standards residuals on the two test files. Filed at architect's discretion rather than folded into either reviewed task's hold block (round-N scope = round-N diff).

## Cross-references

- `backend/src/routes/accreditation.ts` — `export function broadcastAttemptsKey(token: string)` (the single source of truth).
- `backend/tests/routes/admin.test.ts` and `backend/tests/lib/pending-decrement-queue.test.ts` — already migrated; use as the pattern reference.
- `agents/docs/solutions/conventions/docblock-anchor-stable-symbols-not-line-numbers-2026-05-15.md` — the stable-symbol-anchoring convention this sweep continues to apply.
