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

## Architect re-review (2026-05-26) — HELD PENDING FIXES:

`/ce-code-review` (correctness, data-integrity, reliability, security, testing, project-standards, learnings) on the implementation. The core logic is correct: the NULL-`dispute_expires_at`-escapes-the-predicate hazard is structurally impossible (migration 012 declares the column `NOT NULL` and the staging INSERT always supplies a value), the threshold math and the start/stop/`.unref()` lifecycle mirror the bridge-queue purge faithfully, and the DELETE-vs-scrub decision is sound (the durable forensic record is `custody_audit_log`). Three items to land before archive:

1. **Run the first purge at boot, not only after the first 1h interval.** `startRecoveryPurge` registers the `setInterval` but fires no immediate tick, so a deploy or restart leaves rows already past their grace in the table for up to an hour. The sibling jobs `startSignupCleanup` and the custody-audit retention sweep both run an immediate first pass at boot precisely to clear backlog on restart. These rows hold the most sensitive deferred PII of any sibling job (plaintext new email + offline-crackable argon2id hash), so the up-to-1h wait is a concrete data-minimization gap, not a theoretical one. Fire the purge tick once before registering the interval, matching the signup-cleanup shape. Safe — the start call runs after the app DB pool is initialized.

2. **Drop the boot-time `recovery.purge_started` info log.** No sibling maintenance ticker emits a structured start log (the retention sweep emits nothing at start). Per the project's log-volume guidance, prune it while you are in the file. Keep the `deleted > 0` info and the failure warn.

3. **Pin the state-uniform deletion contract with a test.** The module docblock and the DELETE both assert rows are purged "regardless of consumed/disputed/expired state," but every current test row is expired-unused. Seed a consumed row and a disputed row whose dispute window closed beyond the grace and assert both are deleted, so a future mutation narrowing the predicate (e.g. adding `AND consumed_at IS NULL`) is caught.

Dismissed / not blocking: no index on `dispute_expires_at` (acceptable at beta volume, same posture the bridge-queue purge accepts; revisit before production volume above roughly 10k rows); `request_ip_hash` / `old_email_hash` not preserved past the purge (accepted minimization trade-off — an optional `COMMENT ON TABLE` noting it would close the doc gap); the ~72h total retention window (defensible CNPD balancing of clock-skew and edge-of-window dispute clicks).

## Backend re-review signal (2026-05-26)

All three round-1 items landed in `backend/src/recovery-purge.ts` + `backend/tests/recovery-purge.test.ts`:

- **Item 1 (boot-time first tick).** `startRecoveryPurge` now fires `void runPurgeTick()` once before registering the `setInterval`, matching the `startSignupCleanup` immediate-first-pass shape, so backlog rows past their grace are cleared at boot rather than waiting up to an hour. The tick swallows its own errors, so a boot-time DB hiccup cannot disturb startup.
- **Item 2 (drop start log).** The `recovery.purge_started` boot-time info log is removed. The `deleted > 0` info log and the failure warn are kept.
- **Item 3 (state-uniform deletion test).** A new spec seeds a consumed row and a disputed row, both with dispute windows closed beyond the grace, and asserts both are deleted — so a future predicate narrowing (e.g. `AND consumed_at IS NULL`) is caught. The `insertRow` helper gained optional `consumedAt`/`disputedAt` state columns; the existing per-run marker + tracked-id isolation is preserved.

Verification: `npm run typecheck` clean (src + tests); `npm run lint` clean on the touched files; targeted `npx vitest run tests/recovery-purge.test.ts` green against real app Postgres.

Note: the code landed via an isolated-worktree worker whose branch was stale-based; the parent merged the verified diff onto current `main` by cherry-pick (the worker's own commit SHA was never pushed and is not in `main` history — the merged content is what matters). Moves the task back to review/.
