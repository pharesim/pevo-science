# BACKEND-RECOVER-EMAIL-VERIFICATION-AND-NOTIFY — Memo-key recovery must verify new email and notify old

**Owner:** backend
**Created:** 2026-05-21 (surfaced by full-codebase audit 2026-04-21, `.context/audit-2026-04-21/chunk-1-security-reviewer.md` + `chunk-1-adversarial-reviewer.md`)
**Priority:** P1 (security)

## Context

`backend/src/routes/auth.ts` `/recover` (memo-key seed-phrase path) currently:

- Accepts proof of seed-phrase possession (memo-key signature).
- Swaps `email = $2` and `password_hash = $3` in `accounts` for the matching username in a single UPDATE.
- Returns success.

Two defects, both P1:

1. **No email-verification challenge** on the new email. A seed-phrase holder rebinds `email` to anything they want, no confirmation, no token round-trip. Whoever holds the seed phrase silently captures all future password resets, account notifications, GDPR contact paths, and audit trails.

2. **No notification to the old email**. The previous email-holder has no idea the rebinding happened. By the time they notice (next login attempt, next notification not arriving), the attacker has rotated keys and possibly upgraded to self-custody.

Plus an adjacent defect from `chunk-1-adversarial-reviewer.md`: **ORCID recovery still works after the account upgraded to self-custody** (`backend/src/routes/custody.ts:195-203`). Upgrade-to-self-custody doesn't sever the ORCID-recovery path, so an attacker with the original ORCID link can still trigger recovery on an account that is no longer under platform control.

## Goal

Treat memo-key recovery as a sensitive operation that requires email-side proof and full notification:

1. **Two-phase recovery.**
   - Phase 1: caller submits seed-phrase signature + new email. Server stages the request (no swap yet), issues a verification token to the new email.
   - Phase 2: caller hits the verification link from the new mailbox; server applies the swap.
2. **Notify old email** synchronously during Phase 2 (or sooner, at Phase 1). The notification should describe the change, name the new email's domain (not full address), and include a 24-48h dispute link that reverses the swap.
3. **Log recovery success** to `custody_audit_log` (or equivalent) including timestamp, requesting IP, and old-email digest. Forensic trail must survive even the email-delete path (see related task `backend-settings-audit-log-preservation-on-account-delete.md`).
4. **Sever ORCID recovery after upgrade.** In `custody.ts` upgrade path, either:
   - Delete the `orcid` column for upgraded accounts.
   - Or gate `/recover` on `upgraded_at IS NULL` for the ORCID-branch only.

   The audit recommends deleting `orcid`; that's cleaner, but if other surfaces depend on the column (e.g., display purposes), the gate path is acceptable.

## Non-goals

- Adding a recovery cooldown / per-account counter. Audit P2; separate task if pursued.
- Rotating posting + memo keys automatically on recovery. The current swap-email-and-password flow is the minimum; key rotation is a follow-on UX.

## Acceptance

- `/recover` does not commit `email` / `password_hash` swap until the new email proves possession of a server-issued token.
- Old email receives a notification with dispute link.
- ORCID-recover path is gated on `upgraded_at IS NULL` (or `orcid` is cleared on upgrade).
- A test exercises the full flow: recover request → new-email token → swap, plus failure path where new-email token is never opened (state expires).
- A test verifies that an upgraded self-custody account cannot be recovered via the original ORCID link.

## References

- Audit chunks:
  - `.context/audit-2026-04-21/chunk-1-security-reviewer.md` (P1: memo-key recovery bypasses email verification).
  - `.context/audit-2026-04-21/chunk-1-adversarial-reviewer.md` (P1: ORCID recovery still works after upgrade).
- Related: `backend-settings-audit-log-preservation-on-account-delete.md`, `backend-auth-token-session-binding.md`.

## Backend implementer signal (2026-05-25)

Implemented in an isolated worktree branched from backend `main`. Typecheck (`npm run typecheck`) and lint (`npm run lint`) both clean (lint shows one pre-existing unrelated warning in `src/lib/author-supersession.ts`, 0 errors — untouched by this work). Per the task's instruction, vitest was NOT run in the worktree (real-infra, collides with the parent's serial run).

### Per-acceptance-item disposition

1. **Two-phase memo-key recovery — DONE.** `/recover` memo_key path no longer swaps `email`/`password_hash`. After verifying the memo key (real `decryptKey` + constant-time compare, unchanged), it now: hashes the new password once (argon2id), mints a verify token + a dispute token (stored as raw SHA-256 digests, never plaintext), inserts a `pending_recovery` staging row (supersedes any prior un-consumed row for the username in one transaction), and returns `{ recovery: 'pending_verification' }` with NO JWT and NO account mutation. The swap applies only at phase 2 via new `POST /api/auth/recover/verify` (looks up the staging row by verify-token digest, re-resolves the account, re-checks email-free + not-disputed + not-expired + not-consumed + not-upgraded, applies swap + consumes row + audit row in one transaction, returns the JWT). Modeled on the `settings.ts` `pending_email` two-phase pattern and the signup-verify token shape (TTL + single-use).

2. **Notify the OLD email — DONE.** Phase 1 mails the OLD email a notification naming ONLY the new email's DOMAIN (via `emailDomain()`, never the full address or local-part) plus a 48h dispute link (`/recover/dispute?token=`). `POST /api/auth/recover/dispute` marks the staging row `disputed_at` (idempotent); phase-2 verify then refuses to apply. SMTP failures on BOTH the verify mail and the dispute mail log `warn` and the route still returns its success envelope (no 500), per the timing-equalization SMTP-failure-mode convention. Old-email notification is skipped when the account had no email (ORCID-only origin — no prior owner).

3. **Audit log — DONE, with a design note.** Phase-2 success writes an `account_recovery` row to `custody_audit_log` (matching the existing operation_type). The forensic digests (requesting-IP SHA-256 digest, old-email SHA-256 digest, timestamp) are stored on the `pending_recovery` row at phase 1 and survive on the CONSUMED row. I deliberately did NOT stuff them into `custody_audit_log.session_id`/`user_agent`: migration 009's account-delete anonymizer NULLs those columns, which would defeat the "trail must survive the email-delete path" requirement. The account-delete sweep (settings.ts DELETE /email) touches only custody_audit_log/notification_preferences/accounts, NOT pending_recovery, so the consumed staging row is the durable forensic record. New `recovery_dispute` operation_type also added on the dispute path.

4. **Sever ORCID recovery after upgrade — DONE via the gate (preferred) approach.** The ORCID branch of `/recover` is gated on `upgraded_at IS NULL` (state D excluded), returning a generic 401 (matching the no-ORCID branch so it is not an upgrade-state oracle) + an operator `warn`. Phase-2 verify also re-checks `upgraded_at IS NULL` so a stale staged memo-key swap cannot apply to an account that upgraded between phase 1 and phase 2. Did NOT clear the `orcid` column: ARCHITECTURE.md § 6.1 state D explicitly says `orcid` is **preserved** on upgrade, so deleting it would contradict the documented state machine. The gate was the task's preferred option and is the only § 6.1-consistent one. The fix lives in `auth.ts` `/recover`, not `custody.ts`: the defect (ORCID recovery firing post-upgrade) is in the `/recover` handler; the task's "custody.ts:195-203" line cite is stale (custody.ts is ~1337 lines now and the upgrade handler does not branch on ORCID-recovery). `custody.ts` was NOT modified.

### Files added/changed

- `backend/migrations/012_pending_recovery.sql` (NEW) — staging table + 3 indexes + table comment + schema_migrations self-record.
- `backend/src/routes/auth.ts` (CHANGED) — `/recover` memo-key path → two-phase staging; ORCID branch gated on `upgraded_at IS NULL`; ORCID path now applies immediately (it already proves a registered factor via fresh OAuth); added `forensicDigest()` + `emailDomain()` helpers + recovery-window constants; new `POST /recover/verify` and `POST /recover/dispute` handlers.
- `backend/tests/routes/recover.test.ts` (CHANGED) — two existing memo-key tests rewritten to assert phase-1 staging (no immediate swap); cleanup + afterAll now also clear `pending_recovery`.
- `backend/tests/routes/recover-two-phase.test.ts` (NEW) — full phase-1→phase-2 apply, never-verified expiry, old-email dispute, and upgraded-account ORCID-severance. Mocks the SMTP transporter to capture emailed tokens (carve-out clause (a)/(c) documented in the file header; no auth middleware mocked — `/recover*` is unauthenticated).

### Migration number + why

`012` — `ls backend/migrations/` showed `011_accounts_signup_binding_hash.sql` as the highest; 012 is the next free sequential number, no collision on this branch.

### Expected test behavior + mutation-kills

- `recover.test.ts` "correct memo key STAGES the swap (phase 1)": asserts 200 + `recovery: 'pending_verification'`, NO token, account email/password UNCHANGED, old password still logs in, one un-consumed `pending_recovery` row. Mutation-kill: reverting to immediate-swap fails the "email unchanged / old password still works" assertions.
- `recover.test.ts` null-hash seed-phrase staging: asserts `password_hash` stays NULL at phase 1, staged row carries the pre-hashed password.
- `recover-two-phase.test.ts` full flow: phase-1 mails verify (to new) + dispute (to old, naming only the new DOMAIN, not the local-part); phase-2 applies the swap, returns a JWT, writes one `account_recovery` audit row; verify token is single-use (replay → 400). Mutation-kill: dropping the phase-2 swap fails the "email == newEmail" assertion; dropping single-use consume fails the replay assertion.
- never-verified expiry: force-expire `verify_expires_at`, phase-2 → 400 INVALID_TOKEN, email unchanged. Mutation-kill: removing the expiry check passes the swap.
- dispute: old-email dispute → 200, phase-2 then refuses (400), email unchanged, one `recovery_dispute` audit row. Mutation-kill: removing the `disputed_at` gate in phase-2 lets the disputed swap apply.
- upgraded-account ORCID severance: a state-D account (custody='self', upgraded_at set, orcid preserved) with a VALID matching ORCID nonce → 401 UNAUTHORIZED, email unchanged. Mutation-kill: removing the `upgraded_at` gate flips this to a 200 recover (the exact P1 defect).

### [TODO Architect] — api-contract.md / api-contracts/*.md prose

This task adds two new routes and changes the `/recover` response contract; per the agent boundary I did not edit `agents/docs/api-contracts/*.md`. Architect updates needed:
- `POST /api/auth/recover` (memo_key path) now returns `{ recovery: 'pending_verification', message }` (200, NO token) instead of `{ token, expires_at, custody, username }`. The ORCID path is UNCHANGED (still returns the JWT envelope immediately).
- NEW `POST /api/auth/recover/verify` — body `{ token }`; 200 → `{ token, expires_at, custody, username }`; 400 INVALID_TOKEN (invalid/expired/disputed/consumed/upgraded/account-gone); 409 DUPLICATE (new email taken since phase 1).
- NEW `POST /api/auth/recover/dispute` — body `{ token }`; 200 → `{ disputed: true, message }`; 400 INVALID_TOKEN (invalid/expired).
- § 6.4 "Recover" row: the memo-key (seed-phrase) factor now requires a SECOND proof — control of the new mailbox (mailed verify token) — before the swap applies. ORCID recovery is now documented as severed for state D (`upgraded_at IS NOT NULL`). § 6.5 invariant #3 ("Recovery proof must match a registered factor") is unaffected; this adds an email-control proof on top of the seed-phrase proof for the rebind specifically.

### Note for the parent's serial run

`backend/migrations/012_pending_recovery.sql` must be applied to the test DB (`./deploy.sh migrate`) before running the new `recover-two-phase.test.ts` and the updated `recover.test.ts` — they query/cleanup the `pending_recovery` table. The migration probe (`verifyAppDbMigrations`) runs only at production boot (`index.ts`), NOT in `createApp()`, so it will not fail the test suite, but the table must exist for the assertions.
