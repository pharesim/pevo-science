# BACKEND-CUSTODY-AUDIT-PII-ANNOTATION — annotate user_agent column as PII; document retention + deletion path

**Owner:** Backend Agent
**Created:** 2026-05-05 (architect, surfaced by `/ce-code-review` on `backend-coauthor-trust-model` rounds 1+3)
**Priority:** P2

## Problem

Migration `005_custody_audit_consent_ops.sql` (commit `b9b3b3b`, round 3 of `backend-coauthor-trust-model`) added a `user_agent` column to `custody_audit_log`. The column stores the raw HTTP `User-Agent` header per `routes/custody.ts:282-289`, which can carry OS version, browser version, and in some mobile apps a username or device ID — data that constitutes personal data under GDPR / CNPD.

PEvO operates under Portuguese jurisdiction (CNPD). The project already hashes emails before writing to pino logs (`lib/log-pii.ts`, `routes/auth.ts:919`). The `user_agent` column is the first DB-persisted PII column added since the jurisdiction was set, and the migration does not document its PII status, retention period, or scrubbing policy.

## What's already correct

- The account-deletion sweep at `backend/src/routes/settings.ts:312` (`DELETE FROM custody_audit_log WHERE username = $1`) covers GDPR right-to-erasure for these rows. No new code path needed.
- The column is nullable; non-consent broadcasts write NULL (no PII for non-consent flows).

## What's missing

- A `COMMENT ON COLUMN custody_audit_log.user_agent IS '...'` annotation documenting the PII status, the legal basis (legitimate interest in security audit), the retention policy, and the deletion path.
- An ARCHITECTURE.md or `agents/docs/api-contracts/custody.md` operator note pointing at the audit-log retention policy. PEvO does not currently have a documented retention period for `custody_audit_log`; this task should either pick one (e.g., 24 months for security audits) or hand off to the architect to choose.

## Acceptance

- New migration `006_custody_audit_pii_annotation.sql` (or whatever the next number is) adding `COMMENT ON COLUMN` for `user_agent` with the PII annotation.
- Inline note in the migration referencing the deletion path at `routes/settings.ts:312`.
- A retention policy decision: either picked here (with rationale) or escalated to the architect via `[TODO Architect]` marker in the migration file.
- If a retention policy is picked, a follow-up task to implement the periodic cleanup job (out of scope for this task).

## Out of scope

- Scrubbing other audit columns (`session_id` is already a one-way SHA-256 hash; `tx_id` and `block_num` are public on-chain).
- Implementing a periodic retention sweep — that's a follow-up if the retention policy is set.
- Other tables with potential PII columns — file separately if found.

## Source

`/ce-code-review` (rounds 1+3) on 2026-05-05: data-migrations reviewer (P2, conf 50). Surfaced as a CNPD jurisdiction concern; the deletion path is already in place, the documentation gap is the actionable item.
