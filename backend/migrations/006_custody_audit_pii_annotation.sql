-- BACKEND-CUSTODY-AUDIT-PII-ANNOTATION — annotate `custody_audit_log.user_agent`
-- as PII per GDPR / CNPD (Portugal). The column was added in
-- `005_custody_audit_consent_ops.sql` to satisfy ARCH.md "Light-account signing
-- of consent ops" (auth_mechanism + session_id + user_agent for consent-op
-- broadcasts). The raw HTTP `User-Agent` header can carry OS version, browser
-- version, and in some mobile apps a username or device ID, which constitutes
-- personal data under GDPR.
--
-- This migration adds a `COMMENT ON COLUMN` annotation documenting:
--   - PII status (the column stores a raw User-Agent header).
--   - Legal basis: legitimate interest in security audit (GDPR Art. 6(1)(f)).
--     Consent-op broadcasts are signed with the platform-held posting key, so
--     the operator must be able to prove a fresh-auth challenge was answered
--     by a real session at a specific user agent — anti-abuse / forensic.
--   - Jurisdiction: CNPD (Portugal). PEvO operates from Portugal; supervisory
--     authority is the Comissão Nacional de Proteção de Dados.
--   - Retention period: 24 months from row insert. Industry-standard for
--     security-audit log retention, balanced against GDPR data-minimization
--     (Art. 5(1)(c) and (e)). Long enough to support post-incident forensics
--     beyond a typical breach-discovery window; short enough that we are not
--     hoarding PII indefinitely. A periodic cleanup job that drops rows older
--     than 24 months is OUT OF SCOPE for this migration and tracked as a
--     follow-up TODO inside the task file.
--   - Deletion path on user request: the account-deletion sweep inside the
--     `DELETE /api/settings/email` handler in `backend/src/routes/settings.ts`
--     runs `DELETE FROM custody_audit_log WHERE username = $1` inside the same
--     transaction that drops the account row, satisfying GDPR right-to-erasure
--     (Art. 17). No separate per-row scrub endpoint is needed; the column is
--     erased in full when the user deletes their account.
--
-- Idempotent: `COMMENT ON COLUMN` is unconditional and overwrites any prior
-- comment on the same column, so re-applying this migration is safe.
--
-- Insert path reference: the success-path `auditExtras` constructor inside
-- the `POST /api/custody/broadcast` handler in `backend/src/routes/custody.ts`
-- populates `user_agent` from `req.headers['user-agent']` and passes it to
-- `logCustodyBroadcast`. The constructor is reached whenever a fresh-auth
-- challenge has been answered for the broadcast, covering both consent-op
-- signing (`author_accept` / `author_resign`) and non-consent broadcasts
-- (e.g., vote, comment, custom_json) that answer a session-kind or
-- consent_op-kind fresh-auth challenge.

COMMENT ON COLUMN custody_audit_log.user_agent IS
  'PII (GDPR / CNPD). Raw HTTP User-Agent header captured when a fresh-auth '
  'challenge is answered for the broadcast. '
  'Legal basis: legitimate interest in security audit, GDPR Art. 6(1)(f). '
  'Retention: 24 months from row insert (security-audit retention, balanced against '
  'GDPR data-minimization Art. 5(1)(c)/(e)); periodic cleanup job is a follow-up. '
  'Right-to-erasure deletion path: the account-deletion sweep inside the '
  'DELETE /api/settings/email handler in backend/src/routes/settings.ts runs '
  'DELETE FROM custody_audit_log WHERE username = $1 in the same transaction that '
  'drops the account row. '
  'Populated whenever a fresh-auth challenge has been answered for the broadcast, '
  'covering both consent-op signing (author_accept / author_resign) and non-consent '
  'broadcasts (e.g., vote, comment, custom_json) that answer a session-kind or '
  'consent_op-kind fresh-auth challenge. See the success-path auditExtras constructor '
  'inside the POST /api/custody/broadcast handler in backend/src/routes/custody.ts '
  'for the insert path.';
