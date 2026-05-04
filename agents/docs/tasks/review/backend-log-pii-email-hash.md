# BE-LOG-PII-EMAIL-HASH — Replace plaintext email log fields with truncated SHA-256 hashes

**Owner:** backend
**Created:** 2026-04-22 (surfaced by BE-ORCID-BROADCAST-ABORT-TIMEOUT round-2 review)
**Priority:** P2

## Context

PEvO's root `CLAUDE.md` declares "Privacy by design" as a core principle. The `BE-ORCID-BROADCAST-ABORT-TIMEOUT` round-1 fix added structured error logging at `signup-verify.ts` `/confirm` and `/link` so operators see the full `BroadcastTimeoutError` class + `timeoutMs` on accreditation broadcast failure. The log shape is `{err, email, username, orcid}` — `email` is a plaintext user email address at error level.

Maintainability MAINT-004 (0.80) in the round-2 review flagged:

- `backend/src/routes/signup-verify.ts` `/confirm` (~278) and `/link` (~400) log `email: account.email` in plaintext.
- `backend/src/routes/accreditation.ts` (~216) has the same shape.

A persistent error log with plaintext emails gives anyone with log access a harvestable list of registered users. The tension is real: operators need enough context to correlate a log entry to a user (for incident response), but the full email is more than necessary. A stable identifier that can be cross-referenced against the user's row on request — without exposing the address directly in logs — satisfies both needs.

## Goal

1. Introduce a small helper `hashEmailForLogs(email: string): string` that returns a truncated SHA-256 hash (e.g., first 12 hex chars) suitable for log correlation.
2. Replace `email: account.email` / `email: account?.email` / similar plaintext fields at all structured-log call sites with `email_hash: hashEmailForLogs(email)`.
3. Audit the backend for other plaintext-PII log fields (ORCID iD, full name) while in the area — document findings as a re-review-signal hint for separate tasks, but do not expand scope beyond email.
4. Keep `username` in logs — it's the public Hive account name, not PII. Keep `orcid` for now, pending a separate decision on ORCID privacy.

## Non-goals

- Rotating or rehashing historical logs (they exist as-is until log retention rolls them off).
- Centralizing ALL logger calls through a schema — scope is PII fields only.
- Changing pino's error serializer config.
- Migrating debug-tier logs (those don't fire in production).

## Scope

Audit-and-migrate call sites in `backend/src/`:
- `routes/signup-verify.ts`
- `routes/accreditation.ts`
- `routes/auth.ts` (login, signup, recover, reset-request) — likely several sites
- `routes/orcid.ts` (any email in log context)
- `routes/bridge.ts`, `routes/papers.ts`, `routes/claims.ts` — only if email appears in log ctx
- `lib/` helpers that log on behalf of routes (e.g., `account-creation.ts`, `email-sender.ts`)

## Acceptance

- `backend/src/lib/pii-log.ts` (or equivalent) exports `hashEmailForLogs(email)` with a unit test covering stable hashing, case-insensitive normalization (emails normalized via the project's existing email-normalize helper before hashing), and the 12-hex-char truncation.
- Grep for `email: [a-zA-Z_.?]+email` inside `logger.error` / `logger.warn` / `logger.info` calls returns zero hits in `backend/src/`.
- Full backend vitest passes; `npx tsc --noEmit` clean.
- Surface a re-review-signal hint for any out-of-scope PII fields observed during the audit (ORCID iD, full name, session tokens) for follow-up.

## [TODO Architect]

- Confirm the 12-char truncation is adequate for operator correlation without reducing collision resistance to a concerning level (28 hex chars ≈ 112 bits of entropy; 12 hex ≈ 48 bits). For a per-user correlation hint against a bounded user set, 12 is fine. If the backend needs cross-referential uniqueness (e.g., incident forensics across years), 16–20 hex is safer. Decide at re-review.
- Confirm the logging PII posture policy overall — currently there is no single policy document; this task is a first pass on email specifically.

---

## Architect re-review (2026-05-04) — HELD PENDING FIXES (round 1)

`/ce-code-review` ran on commit `04e95e8` (introduce `hashEmailForLogs(email)`; migrate 4 plaintext `email:` log fields to `email_hash:`) with 7 personas (correctness, testing, maintainability, project-standards, learnings, security, kieran-typescript). Helper itself is correctly implemented (SHA-256 + lowercase+trim normalization + 12 hex truncation; thorough JSDoc). Migrated sites at `accreditation.ts /verify` and `auth.ts /signup` SMTP-not-configured branch are clean.

But the migration introduces a P1 latent crash on a real production path, the call-site coverage is mutation-blind, and the helper API is needlessly fragile against the nullable-email column shape that ORCID-only signups exercise. Three round-1 hold items below; #1 is the load-bearing fix and brings #2-#3 along structurally.

### Items to address

**1. (P1) `hashEmailForLogs(account.email)` throws TypeError on ORCID-only accounts in `/confirm` and `/link` broadcast catch paths**

- Files: `backend/src/routes/signup-verify.ts:239` + `:377` (pg query result generics) and `:324` + `:452` (catch-block log emissions)
- Cross-reviewer convergence: correctness 75 + kieran-typescript 90 + testing R2 → anchor 100. Same hazard class as the recently-completed `BACKEND-PASSWORD-HASH-NULL-TYPING-AUDIT`.
- Reachability: ORCID-only signups insert `account.email = NULL` plus a `confirmed:` verify_token (`auth.ts:491`). Both `/confirm` and `/link` look up by verify_token without filtering on email presence. At runtime `account.email` is `null`; TypeScript believes it's `string`. The catch block calls `hashEmailForLogs(account.email)`, which calls `null.trim()` and throws TypeError synchronously. The outer try at the route level converts a recoverable `logger.error + sendOk(jwt)` flow into a 500 INTERNAL_ERROR. End-user impact: ORCID-only user whose Hive account succeeded gets a 500, accounts row already activated, only operator recovery.
- Fix shape (combine with item 3):
  - Widen pg query result generics on `signup-verify.ts:239` and `:377` from `email: string` to `email: string | null`.
  - Add `safeHashEmailForLogs(email: string | null | undefined): string | null` companion in `backend/src/lib/log-pii.ts`. Strict `hashEmailForLogs(email: string): string` stays for `accreditation.ts /verify` (provably non-null).
  - Migrate the 3 nullable-email call sites — `auth.ts:480` (existing `?...:null` ternary), `signup-verify.ts:324`, `signup-verify.ts:452` — to the safe variant. Call sites collapse to `email_hash: safeHashEmailForLogs(account.email)` (or `normalizedEmail`).

**2. (P2) Zero call-site mutation coverage on the migrated emissions**

- Files: `backend/tests/routes/accreditation.test.ts`, `backend/tests/routes/auth.test.ts`, `backend/tests/routes/signup-verify.test.ts`
- Cross-reviewer convergence: testing T1 100, learnings researcher anchored on `tests-must-fail-on-mutation-of-code-under-test-2026-04-22.md`. None of the 3 route test files reference `email_hash` / `hashEmailForLogs` / `log-pii`. A revert mutation at any of 4 sites passes all tests.
- Concrete coverage gaps:
  - `accreditation.ts /verify`: handleBroadcastError-emitted log not asserted by the existing 502-BROADCAST_FAILED spec.
  - `auth.ts /signup` SMTP-not-configured branch: no test exercises the `else` branch where `config.smtpHost` is falsy on signup.
  - `signup-verify.ts /confirm` + `/link`: accreditation-broadcast catch blocks never entered in tests (broadcastJsonMock defaults to resolved).
- Fix: 4 spy assertions, one per call site. The /confirm and /link assertions need a broadcast-rejection harness which is a strict subset of what item 1's required test (`account.email = null` + broadcast rejection → 200 + JWT) needs — once the harness lands, the email_hash assertion is one extra line. Each spy asserts `email_hash` matches `/^[0-9a-f]{12}$/` and the log payload does NOT contain a top-level `email` key.

**3. (P2) Two vacuous tests in `backend/tests/lib/log-pii.test.ts`**

- File: `backend/tests/lib/log-pii.test.ts:36-50` (non-reversibility) and `:53-57` (does-not-leak)
- Reviewer: testing T2 + T3 both confidence 100. Both pass regardless of implementation.
  - The non-reversibility loop iterates 3-char substrings of `'alice@example.com'` and only fires `expect()` when the substring matches `/^[0-9a-f]{3}$/`. The email contains zero hex 3-char windows. The inner `expect()` never runs.
  - The does-not-leak test asserts `not.toContain('alice'|'example'|'com')` — these strings each contain non-hex characters, so they structurally cannot appear in a hex output.
- Fix: replace with a value-pinned hash assertion: `expect(hashEmailForLogs('alice@example.com')).toBe('<computed 12-hex>')`. Kills algorithm-swap, truncation-length-change, and normalization-removal mutations simultaneously.

### Items dismissed during architect triage (do NOT address)

- **Magic number `12` in `slice(0, 12)`** (maintainability MAINT-002 75) — JSDoc rationale is adjacent and thorough; const extract adds value when the literal is referenced multiple times, not for single use.
- **Empty-string input footgun** (correctness/testing low) — latent only; no production path reaches with empty string today (Zod rejects, ORCID-only inserts NULL, ternary at auth.ts:480 short-circuits). After item 1 lands, signup-verify.ts call sites are also guarded via `safeHashEmailForLogs`, closing the remaining surface.
- **Unkeyed SHA-256 vs HMAC** (security sec-1 60) — JSDoc explicitly accepts the log-access trust boundary; advisory only.
- **Out-of-scope ORCID iD plaintext at signup-verify.ts** (security sec-4) — task spec defers ORCID privacy as out-of-scope.
- **Out-of-scope contact.ts SMTP error message may leak email** (security sec-3) — pre-existing, file separately if material.

### Re-review signal

When items 1-3 land, `git mv` this file back to `tasks/review/`. The architect's next review pass picks it up; the move itself is the re-review signal.

---

## Backend re-review signal (2026-05-04, working tree before commit) — round 1

Items 1, 2, and 3 landed in this round. Per the carry-the-fix-evidence-in-the-commit-diff convention, the items below summarize what changed at each named site; the commit diff is the authoritative evidence.

**Item 1 (P1) — `safeHashEmailForLogs` companion + nullable-email migration:**
- `backend/src/lib/log-pii.ts`: added `safeHashEmailForLogs(email: string | null | undefined): string | null` with JSDoc documenting the ORCID-only-NULL hazard and the strict-vs-safe split (the strict `hashEmailForLogs` stays for `accreditation.ts /verify` where the column is provably non-null per `pending_accreditations.email NOT NULL`).
- `backend/src/routes/signup-verify.ts`: widened pg query result generics for `/confirm` (around `:243`) and `/link` (around `:383`) from `email: string` to `email: string | null`. Added inline comments at the query sites explaining the ORCID-only NULL invariant. Migrated catch-block log emissions at `:327` (`/confirm`) and `:457` (`/link`) from `hashEmailForLogs(account.email)` to `safeHashEmailForLogs(account.email)`.
- `backend/src/routes/auth.ts`: replaced the existing `normalizedEmail ? hashEmailForLogs(normalizedEmail) : null` ternary at the `/signup` SMTP-not-configured emission with `safeHashEmailForLogs(normalizedEmail)`.

**Item 2 (P2) — call-site mutation coverage on the migrated emissions (4 spy assertions across 3 test files):**
- `backend/tests/routes/accreditation.test.ts` — augmented the existing 502 BROADCAST_FAILED spec with a `vi.spyOn(logger, 'error')` assertion: filter by the structured `event: 'broadcast_failed'` discriminator (dashboard-keyable anchor; survives `routeLabel` renames), then assert `email_hash` matches `/^[0-9a-f]{12}$/` and the payload has no top-level `email` key. Existing 502 envelope + token-deletion invariants kept intact in the same test.
- `backend/tests/routes/auth.test.ts` — new `describe.skipIf(!dbReachable)` block at the bottom: posts a valid institutional-email + password signup body with `config.smtpHost` left at its empty test-env default, asserts 500 INTERNAL_ERROR, then filters `errorSpy.mock.calls` by `event: 'auth.signup.smtp_not_configured'` and asserts `email_hash` hex-12 + no `email` key. Added `dbReachable` probe + `getAppPool` + `logger` imports to support this.
- `backend/tests/routes/signup-verify.test.ts` — two new `describe.skipIf(!dbReachable)` blocks (one for `/confirm`, one for `/link`). Both seed an `accounts` row with `email = NULL`, `verify_token = 'confirmed:…'`, `orcid` set; force `broadcastJsonMock.mockRejectedValue(...)`; spy `logger.error`; assert (1) response is **200 + JWT**, **NOT 500** — this is the load-bearing item-1 invariant (pre-fix, `null.trim()` threw a TypeError that bubbled to the outer catch and produced 500); (2) the catch-block log payload carries `email_hash: null` (since `safeHashEmailForLogs(null) = null`) and no top-level `email` key. The `/link` spec uses real `verifyHiveSignature` (no mock-auth) with a deterministic test private key + `getAccountsMock` priming, matching the file-header convention.

**Item 3 (P2) — value-pinned hash assertion replacing the two vacuous tests:**
- `backend/tests/lib/log-pii.test.ts:37-58`: replaced the substring-walk "is not reversible" loop and the "does not leak" `not.toContain` triple with a single `expect(hashEmailForLogs('alice@example.com')).toBe('ff8d9819fc0e')`. Pre-test rationale captured in a leading comment. The pinned hex simultaneously kills algorithm-swap (sha256 → md5/sha1), truncation-length (12 → 16/8), and normalization-removal (drop trim/lowercase) mutations.

**Verification:**
- `npm run lint` (backend): clean (2 pre-existing warnings on `seed-phrase.ts:26-27`, unrelated).
- `npx tsc --noEmit -p .` (backend): clean.
- Targeted vitest run on the 4 modified files: **60 passed, 2 failed** — the 2 failures are pre-existing intentional reds in `accreditation.test.ts` (round-3 hold #5 decrement-failure spec + round-4 hold #1 cleanup-failure spec), documented as forcing functions for `backend-bridge-key-startup-validation-and-pino-redact.md` per the file's header docstring (`/^[0-9a-f]{64}/` redaction-negative against `err.command.args` raw-token leak). Do NOT fix these in this round.
- Item 1's load-bearing 200-not-500 invariant is verified end-to-end by the new `/confirm` and `/link` specs in `signup-verify.test.ts` — both pass against the real pg pool with `account.email = NULL` rows.
