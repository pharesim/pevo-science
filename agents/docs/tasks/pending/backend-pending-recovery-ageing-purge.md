# BACKEND-PENDING-RECOVERY-AGEING-PURGE — TTL purge for the pending_recovery staging table

**Owner:** backend
**Created:** 2026-05-26 (architect, surfaced by /ce-code-review on backend-recover-email-verification-and-notify round-2, security persona — out of scope for that commit, pre-existing)
**Priority:** P3 (data minimization)

## Context

`pending_recovery` (migration 012) stages two-phase memo-key recovery requests. Each row carries a third-party plaintext `new_email` plus an offline-crackable argon2id `new_password_hash`. Rows are removed on account deletion (the round-2 GDPR sweep) and superseded on re-stage, but there is otherwise no ageing-purge: a consumed or never-verified/expired row persists indefinitely until the account is deleted.

Under CNPD/GDPR data-minimization, staged PII (plaintext new email + password hash) should not outlive its purpose. The verify token expires at `verify_expires_at` (~24h) and dispute at `dispute_expires_at` (~48h); after those windows the row's plaintext fields have no remaining function.

## Goal

Add a TTL-based ageing purge for `pending_recovery`, mirroring the bridge-queue ageing-purge job pattern (see the bridge-queue ageing-purge work for the established job shape). For the implementer to weigh:

1. A periodic job (the same scheduler the bridge ageing-purge uses) that DELETEs rows past a retention horizon (e.g., `dispute_expires_at < NOW() - <grace>`), OR NULLs only the plaintext fields (`new_email`, `new_password_hash`) while keeping any forensic timestamps/digests. Note: the recover-email round-3 hold (item 1) establishes the consumed row is NO longer the durable forensic record post-account-delete, which weakens the case for preserving anything — confirm whether forensic fields still carry value before choosing scrub-vs-delete.
2. Whether a consumed row should survive at all past the dispute window.

## Acceptance

- A purge mechanism removes (or scrubs the plaintext fields of) `pending_recovery` rows past the retention horizon.
- A test pins it: seed an expired row, run the purge, assert it is gone/scrubbed; seed a fresh row, assert it survives.
- Retention horizon and purge cadence documented.

## Non-goals

- The account-delete sweep (already landed in the recover-email task).
- Reworking the two-phase flow itself.

## Backend completion signal (2026-05-26)

Added a TTL ageing purge for `pending_recovery` mirroring the bridge-queue `purgeAgedTerminalEntries` job shape, in a self-contained `backend/src/recovery-purge.ts` (the `ipfs-cleanup.ts` standalone-job precedent).

**Decision: DELETE, not scrub.** The task flagged that the consumed row is no longer the durable forensic record post-account-delete; migration 012 confirms the dispute forensic signal lives in `custody_audit_log`, which survives independently. After `dispute_expires_at` (~48h) a row can neither be verified (phase 2) nor disputed, so its plaintext `new_email` + offline-crackable argon2id `new_password_hash` have no remaining function and nothing forensic is left to preserve in the staging row. So the purge DELETEs rather than scrubs.

**Retention horizon + cadence.** `purgeAgedPendingRecovery(graceMs = 24h)` deletes every row whose `dispute_expires_at < NOW() - grace`, uniformly across expired-unused, consumed, and disputed states (all three are terminal once the dispute window closes). The 24h grace buffers clock skew and an in-flight dispute click at the window edge. The threshold is computed in JS (not SQL interval math) to avoid int4 interval overflow, mirroring `purgeAgedTerminalEntries`. Runs hourly via `startRecoveryPurge` (a `setInterval` with `.unref()`), wired into `src/index.ts` boot alongside `startSignupCleanup`, with `stopRecoveryPurge` in the shutdown drain. Tick errors are swallowed as non-fatal maintenance.

**No migration.** This is a periodic DELETE job, not a schema change.

**Test** `tests/recovery-purge.test.ts` (real app Postgres, `describe.skipIf(!dbReachable)`): an expired row (dispute window closed 100d ago) is purged while a fresh row (window open) survives; a row whose window closed 1h ago survives the default 24h grace; a custom 1h grace purges a 2h-old row. Rows are isolated by a unique per-run username marker + tracked ids, so assertions never depend on other rows the shared dev DB carries.

**Verification.** `npm run typecheck` clean (src + tests); `npm run lint` clean on `recovery-purge.ts`, `index.ts`, and the test; scoped `npx vitest run tests/recovery-purge.test.ts` → 3/3 green. Self-audit on changed lines: no task-slug citations, round-N markers, line-number anchors, SHA refs, date anchors, or relative positional anchors in the source/test files.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
