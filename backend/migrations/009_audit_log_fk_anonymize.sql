-- Preserve `custody_audit_log` history across account deletion via anonymization
-- rather than wiping. Prior policy DELETEd all rows for the username in the same
-- transaction as the account delete; that destroyed the forensic trail at the
-- exact moment it became most useful (an attacker triggering `email_deleted` had
-- a one-call wipe of every recovery / upgrade / key-rotation event the operator
-- needed to triage the incident), and it also produced a weak GDPR posture (the
-- proof that deletion happened was itself deleted).
--
-- New policy: on account delete, UPDATE the audit rows to NULL out username and
-- the PII-derived columns (user_agent, session_id). The forensic columns
-- (operation_type, tx_id, block_num, created_at, auth_mechanism,
-- fresh_auth_outcome) survive. This satisfies both:
--
--   - GDPR Art. 17 right-to-erasure: no PII remains (the SHA-256 user-agent
--     hash and session id are both correlatable back to the original session,
--     so both are dropped; the bare operation_type + timestamp + mechanism
--     is anonymous activity metadata).
--   - Forensics: the row count and operation_type distribution survive
--     post-deletion, so an operator can still see "an `email_deleted` event
--     happened at T0 for a now-anonymized user" without re-identifying them.
--
-- The schema change this migration enforces is making `username` nullable.
-- The column was created NOT NULL in `001_schema.sql` (no FK to accounts;
-- the prior route handler's "Delete in FK-safe order" comment was misleading,
-- the DELETE ran for application-level cleanup, not FK-driven). Dropping the
-- NOT NULL constraint is the minimum change to let the anonymize-on-delete
-- UPDATE succeed. No new index is needed: the existing
-- `idx_custody_audit_username` btree is fine with NULL entries (NULLs are
-- indexed by default in btree and treated as distinct from other NULLs, so
-- anonymized rows co-exist with reused usernames without collision).
--
-- Idempotent: the ALTER COLUMN ... DROP NOT NULL is a no-op when re-applied
-- against a DB where the column is already nullable.

ALTER TABLE custody_audit_log
  ALTER COLUMN username DROP NOT NULL;

COMMENT ON COLUMN custody_audit_log.username IS
  'Hive username at the time of the operation. Nullable: rows whose owning '
  'account has been deleted are anonymized by NULLing this column (along with '
  'user_agent and session_id) in the same transaction as the account delete. '
  'See the DELETE /api/settings/email handler in backend/src/routes/settings.ts '
  'for the right-to-erasure path. The forensic columns (operation_type, tx_id, '
  'block_num, created_at, auth_mechanism, fresh_auth_outcome) survive the '
  'anonymization so post-deletion audit queries can still count operation_type '
  'distributions without re-identifying the deleted user.';

-- Supersede the user_agent column COMMENT installed by
-- `006_custody_audit_pii_annotation.sql`. The prior comment described the
-- right-to-erasure path as "DELETE FROM custody_audit_log WHERE username = $1
-- in the same transaction that drops the account row"; that path has been
-- replaced by the anonymize-on-delete UPDATE described above (the audit row
-- survives with user_agent NULLed). Comments are idempotent in PostgreSQL
-- (each COMMENT ON overwrites the prior comment on the same target), so this
-- migration applies cleanly against databases that already ran migration 006.
COMMENT ON COLUMN custody_audit_log.user_agent IS
  'PII-derived (GDPR / CNPD). SHA-256 hash of the HTTP User-Agent header '
  'captured when a fresh-auth challenge is answered for the broadcast. '
  'Hashed at insert via hashUserAgentForAudit in backend/src/routes/custody.ts '
  'to satisfy GDPR Art. 5(1)(c) data minimization: the forensic purpose '
  '(correlating UA changes across consent ops to prove session continuity) '
  'is satisfied by hash-equality without retaining the raw header. The '
  'column is still treated as PII-derived because an attacker with a '
  'candidate UA can confirm presence by recomputing the hash. '
  'Legal basis: legitimate interest in security audit, GDPR Art. 6(1)(f). '
  'Retention: 24 months from row insert (security-audit retention, balanced against '
  'GDPR data-minimization Art. 5(1)(c)/(e)); periodic cleanup job is a follow-up. '
  'Right-to-erasure deletion path: the account-deletion sweep inside the '
  'DELETE /api/settings/email handler in backend/src/routes/settings.ts runs '
  'UPDATE custody_audit_log SET username = NULL, user_agent = NULL, session_id = NULL '
  'WHERE username = $1 in the same transaction that drops the account row. The '
  'audit row itself survives with operation_type and timestamp intact; only the '
  'PII-derived columns and the username link are erased. '
  'Populated whenever a fresh-auth challenge has been answered for the broadcast, '
  'covering both consent-op signing (author_accept / author_resign) and non-consent '
  'broadcasts (e.g., vote, comment, custom_json) that answer a session-kind or '
  'consent_op-kind fresh-auth challenge. See the success-path auditExtras constructor '
  'inside the POST /api/custody/broadcast handler in backend/src/routes/custody.ts '
  'for the insert path. Rows persisted before the hash-at-insert change still hold '
  'raw UA strings and age out under the retention sweep without retroactive rewrite. '
  'Scope on the wider table: custody_audit_log also stores non-broadcast '
  'custody-audit events (e.g., login_failure, password_reset, account_recovery, '
  'recovery_failure, email_deleted, upgrade, upgrade_failure); these rows do not '
  'run the broadcast fresh-auth gate, so user_agent is written as NULL by default. '
  'A NULL on this column therefore means either (a) the row is a non-broadcast '
  'custody-audit event, (b) the row is a broadcast call but the HTTP client did '
  'not send a User-Agent header (or sent a non-string / empty one), or (c) the '
  'owning account has been deleted and the row was anonymized.';
