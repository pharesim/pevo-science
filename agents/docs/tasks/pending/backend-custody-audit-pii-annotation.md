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

## Implementation note (2026-05-06, backend)

Landed `backend/migrations/006_custody_audit_pii_annotation.sql` adding the `COMMENT ON COLUMN custody_audit_log.user_agent` annotation. SQL parsed cleanly against the dev `pevo_app` Postgres in a rolled-back transaction; comment is readable via `col_description('custody_audit_log'::regclass, attnum)`. `COMMENT ON COLUMN` is unconditional, so the migration is idempotent.

**Retention decision: 24 months from row insert.** Rationale documented inline in the migration's SQL comment block — industry-standard for security-event log retention, long enough for post-incident forensics beyond a typical breach-discovery window, short enough to honor GDPR data-minimization (Art. 5(1)(c)/(e)). Legal basis for keeping the column at all is legitimate interest in security audit (GDPR Art. 6(1)(f)).

**No periodic cleanup job in this task — see follow-up TODO below.**

[TODO Architect] The migration's SQL comment now carries the operator-facing retention + deletion semantics, but PEvO's integrator-facing surface does not yet document either. Two contract additions are needed; both are out of scope for the backend role's zone (api-contracts/* and ARCHITECTURE.md are architect-owned):

1. **`agents/docs/api-contracts/custody.md`** — add an "Audit log retention" subsection under the consent-ops broadcast surface, stating: "Successful `author_accept` / `author_resign` broadcasts are recorded in `custody_audit_log` with the auth mechanism, hashed session id, and raw `User-Agent` header. Rows are retained for 24 months from insert (security-audit retention, GDPR Art. 6(1)(f) legitimate interest, CNPD jurisdiction). Rows are erased immediately on account deletion via the settings.ts:312 sweep (GDPR Art. 17 right-to-erasure). The `User-Agent` field is the only persisted PII column on this surface; `session_id` is a one-way SHA-256 hash, `tx_id`/`block_num` are public on-chain references." Avoid the emdash in the user-facing copy.
2. **`agents/docs/ARCHITECTURE.md`** — under the "Light-account signing of consent ops" section (or wherever the audit-log surface is referenced), add a one-line cross-reference: "Audit-log retention is 24 months for consent-op rows; PII annotation is documented inline at `backend/migrations/006_custody_audit_pii_annotation.sql`. Right-to-erasure path is `backend/src/routes/settings.ts:312`."

These additions complete the documentation chain (DB column → contract → ARCH) so a future operator or fork-maintainer reading any of the three lands on the same retention number.

## Follow-up TODO (out of scope, file separately)

- **`backend-custody-audit-retention-sweep`**: implement a periodic job that drops `custody_audit_log` rows where `created_at < now() - interval '24 months'`. Decisions deferred to that task: cron vs. on-demand trigger, batch size, whether to scrub PII columns in-place before deletion (probably unnecessary — full-row delete satisfies GDPR), and whether to emit a pino summary line for ops visibility. The retention number lives in the SQL comment on `custody_audit_log.user_agent` (see migration 006); the sweep should reference that as the authority rather than hard-coding 24 months in two places.
