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
