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

---

## Architect re-review (2026-05-25, round-1) — HELD PENDING FIXES

`/ce-code-review` on commits `b3c1a46b..59ba977c` (10 reviewers: correctness + security + adversarial on Opus; testing / reliability / data-migrations / maintainability / project-standards / kieran-typescript / api-contract / learnings-researcher on Sonnet; `ce-agent-native-reviewer` skipped per PEvO CLAUDE.md). All four acceptance criteria — two-phase memo-key, notify-old-email + dispute, audit-log forensics, ORCID-after-upgrade severance via gate — land in intent. Five items held; many race / oracle findings dismissed under the unifying rationale that a seed-phrase holder already has full account access via client-derived owner/active keys (per ARCHITECTURE.md § 6.1 light-account key derivation), so the dispute defense is best-effort recoverability UX, not a load-bearing security boundary; race-class hardening against an attacker who already controls the account does not change the threat picture. API-contract doc updates filed as a separate architect-self-task at `tasks/review/architect-recover-email-api-contract-update.md`. Two organizational follow-ups filed at `tasks/pending/backend-log-pii-helper-consolidation.md` and `tasks/pending/backend-extract-recover-from-auth-ts.md`.

### Items held (must fix before archive)

**1. (P1, GDPR/CNPD, 3 reviewers: security + adversarial + correctness) `pending_recovery` rows survive account deletion with plaintext `new_email` + argon2 hash; `DELETE /api/settings/email` does not sweep the table.** PEvO operates in Portugal under CNPD supervision. An un-consumed staging row at email-delete time leaves a third-party plaintext email (the would-be new email) persisting indefinitely, soft-linked to the deleted username. The argon2id hash on the row is also offline-crackable if the DB leaks. The original implementer signal claimed the consumed staging row is the durable forensic record and that the email-delete sweep does not touch `pending_recovery` by design — but the reasoning only covers *consumed* rows. Un-consumed rows hold the plaintext new_email + new_password_hash with no completed swap to record.

Two acceptable fix shapes — implementer's choice:

- **Shape A — DELETE in the email-delete tx.** Add `DELETE FROM pending_recovery WHERE username = $1` to the email-delete transaction in `backend/src/routes/settings.ts`. Removes the staging row entirely. Simpler; an un-consumed row has no forensic value (no swap completed), so the original signal's forensic-survival claim still holds for consumed rows that happen to be in the same username scope (assuming the username is reused by a different account, but in practice consumed rows for a deleted username are themselves audit-only).
- **Shape B — NULL plaintext fields, preserve timestamps + digests.** Add an UPDATE that NULLs `new_email` + `new_password_hash` for the deleted-username rows while keeping the forensic timestamps + `request_ip_hash` + `old_email_hash` digests. Preserves the "forensic survival" claim from the original signal for ALL rows (consumed and un-consumed alike).

This fix also closes the **stale-bind hijack** secondary finding (a deleted username could be re-signed-up via the light-account flow, then phase-2 verify applies the staged swap to the new account — no longer possible if the staging row is gone or its plaintext fields are NULL).

**Tests**: assert the email-delete tx clears (Shape A) or NULLs (Shape B) the `pending_recovery` rows for the deleted username, AND that subsequent phase-2 verify on the now-deleted/scrubbed row returns 400 INVALID_TOKEN with `accounts.email` unchanged. Mutation-kill: reverting the new DELETE/UPDATE leaves the row intact; the post-delete state assertion fails.

**2. (P3, conf 75, correctness) `RecoverBodySchema.new_email` lacks `isEmail` validation.** Pre-existing in `/recover` before this task, but the two-phase staging makes the path more reachable. A non-email string passes phase-1 validation, gets staged, the verify-mail send throws inside the catch (route still 200s), and a forged phase-2 token would set `accounts.email = 'not-an-email'`. Fix: add an `isEmail` (or Zod `email()`) check at the same point signup does it, returning 400 VALIDATION_ERROR on mismatch.

This also closes the **`emailDomain('@evil.com')` returns `'evil.com'`** secondary finding (if `isEmail` rejects malformed input upstream, the helper never sees it).

**3. (P3 cosmetic, conf 80) Migration 012 header sentence references "ADD COLUMN IF NOT EXISTS guards" that do not exist in the body.** Copy-paste residue from migration 011. Strip the sentence. The migration IS idempotent via `CREATE TABLE / INDEX IF NOT EXISTS` — header should match.

**4. (P3 style) `token2` local-var naming in `/recover/verify` and `/recover/dispute` JWT-mint sites.** Disambiguation-shaped name (every other JWT binding in `auth.ts` uses `const token = jwt.sign(...)`). Rename to `sessionJwt` and keep the response field name `token` so the wire shape is unchanged. 30-second rename.

**5. (testing) Two coverage pins on the supersession + dispute-window invariants.**

  a. **Supersession contract test**: phase-1, then phase-1 again with a different `new_email`; phase-2 with the FIRST verify token should return 400 INVALID_TOKEN, `accounts.email` unchanged, exactly one `pending_recovery` row present for the username. Pins the documented supersession invariant. Mutation-kill: dropping the supersession DELETE leaves the first row alive; the first verify token still applies and the swap lands.

  b. **Dispute-window expiry, symmetric to verify-expiry test**: force-expire `dispute_expires_at`, click dispute → 400 INVALID_TOKEN, `disputed_at` still NULL. Mirrors the existing verify-expiry test. Mutation-kill: removing the expiry gate accepts the expired dispute click and stamps `disputed_at`.

### Items dismissed at architect triage

Many race / oracle findings dismissed under the unifying rationale stated above (seed-phrase holder already controls the account):

- Phase-1 supersession DELETE clobbers in-flight DISPUTED rows (defeats dispute by re-staging).
- Phase-2 double-consume race (concurrent same-token clicks → duplicate audit row; account UPDATE idempotent).
- Phase-2 upgrade TOCTOU (SELECT-then-UPDATE without `AND upgraded_at IS NULL` in the WHERE).
- Dispute-vs-verify TOCTOU (dispute lands between phase-2 SELECT and UPDATE).
- Concurrent phase-1 supersession at READ COMMITTED can leave 2 un-consumed rows (both still require valid memo-key proof; loser expires).
- Phase-2 409 DUPLICATE / upgraded / deleted branches leave the verify token valid until expiry (token-holder can retry once external state flips, within ~48h TTL).
- ORCID-then-seed chain — dispute mail goes to the attacker after a prior ORCID-recover rebound the account's email field (attacker already won via the prior step).
- Phase-2 message-body distinguishability (consumed vs invalid-or-expired; only observable to legit token-holder at 256-bit entropy).
- Dispute audit-row INSERT is not idempotent (double-click writes two rows; staging-row UPDATE itself is idempotent via COALESCE) — minor forensic noise.

### Filed as new tasks (out of scope for this archive)

- `tasks/review/architect-recover-email-api-contract-update.md` — architect-self-task bundling `/api/auth/recover` memo-key breaking response shape, the two new endpoint contracts, ARCHITECTURE.md § 6.4 Recover row, and the dispute-mail PII convention.
- `tasks/pending/backend-log-pii-helper-consolidation.md` — `forensicDigest` belongs in `lib/log-pii.ts` alongside `hashUserAgentForAudit` (currently duplicated body-for-body).
- `tasks/pending/backend-extract-recover-from-auth-ts.md` — `auth.ts` at ~1700 lines after this landing; the recover trio (~565 lines) is the natural extraction.

### Re-review signal

When items 1-5 land, `git mv` this file back to `tasks/review/`. The mv itself is the re-review signal. Round-2 architect review scopes `/ce-code-review` to the round-2 commit only.

Recommendation: item 1 is the load-bearing item; items 2-4 are small and natural to bundle in the same commit; item 5 is one test file. Implementer's call on commit shape — either one bundled commit or two (code + tests).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>

## Backend re-review signal (2026-05-25, worktree)

**Item 1 (Shape A chosen) — `backend/src/routes/settings.ts`.** The `DELETE /api/settings/email` transaction now runs `DELETE FROM pending_recovery WHERE username = $1` alongside the existing audit-anonymize + notification_preferences + accounts deletes. Shape A over Shape B: the email-delete path deletes the whole `accounts` row, so a surviving consumed staging row's username link is orphaned anyway and carries no forensic value once the account is gone — a single DELETE fully removes the GDPR-sensitive plaintext new_email + argon2 hash with no migration change and no NULL-column handling. Test in `backend/tests/routes/settings.test.ts`: seeds an account + a pending_recovery row, deletes the email, asserts the staging row is gone and a phase-2 `/recover/verify` on the (now-swept) verify token returns 400 INVALID_TOKEN with no account recreated. Mutation-kill: reverting the DELETE leaves the row alive and the `after.rows.length === 0` assertion fails.

**Item 2 — `backend/src/routes/recover.ts`.** `RecoverBodySchema.new_email` is now `z.string().min(1).email()`, matching the change-email schema in `settings.ts`. A malformed address now 400s VALIDATION_ERROR at parse time before any staging. This also closes the `emailDomain('@evil.com')` secondary finding since the helper never sees malformed input. (Covered behaviorally by the existing schema-parse-failure path; no new dedicated spec — the email-format reject shares the generic "Invalid request body" 400 envelope already asserted on the schema.)

**Item 3 — `backend/migrations/012_pending_recovery.sql`.** Stripped the stale "ADD COLUMN IF NOT EXISTS guards" sentence (copy-paste residue from migration 011); the header now reads "CREATE TABLE IF NOT EXISTS + CREATE INDEX IF NOT EXISTS", matching the actual idempotency mechanism in the body.

**Item 4 — `backend/src/routes/recover.ts`.** Renamed the `token2` local var at the `/recover/verify` JWT-mint site to `sessionJwt`; the response FIELD name stays `token` (wire shape unchanged). `/recover/dispute` has no JWT mint, so it had no `token2` to rename.

**Item 5 — `backend/tests/routes/recover-two-phase.test.ts`.** (a) Supersession contract test: phase-1, capture the first verify token, phase-1 again with a different new_email, assert exactly one pending_recovery row remains and the FIRST verify token → 400 INVALID_TOKEN with `accounts.email` unchanged. Mutation-kill: dropping the supersession DELETE leaves the first row alive and the first token applies. (b) Dispute-window expiry test (symmetric to the verify-expiry test): force-expire `dispute_expires_at`, click dispute → 400 INVALID_TOKEN, `disputed_at` stays NULL. Mutation-kill: removing the dispute expiry gate accepts the expired dispute and stamps `disputed_at`.

`npm run typecheck` (src + tests) and `npm run lint` (src) both clean; the only lint output is the pre-existing unrelated warning in `src/lib/author-supersession.ts` (untouched). Per the worktree instruction, vitest was NOT run here (real shared Postgres/Redis — the parent runs it serially after merge). Migration 012 must be applied to the test DB before that run (it already is on this branch; the new settings + supersession/dispute specs query the `pending_recovery` table).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
