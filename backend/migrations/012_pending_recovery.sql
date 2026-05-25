-- Two-phase memo-key account recovery: staging table.
--
-- Prior behavior: POST /api/auth/recover with a memo_key (seed-phrase) proof
-- swapped `email` and `password_hash` on the matching `accounts` row in a
-- single UPDATE, with NO verification that the new email is controlled by the
-- requester and NO notification to the previous email-holder. A seed-phrase
-- holder could silently rebind `email` to an attacker-controlled mailbox,
-- capturing all future password-reset links, account notifications, and the
-- GDPR contact path before the legitimate owner noticed.
--
-- The fix splits memo-key recovery into two phases:
--   Phase 1 (POST /api/auth/recover, memo_key path): verify the memo key,
--     then STAGE the requested swap here (new email + pre-hashed new password
--     + a verification token mailed to the NEW address + a dispute token
--     mailed to the OLD address). No mutation of `accounts` occurs.
--   Phase 2 (POST /api/auth/recover/verify): the requester clicks the link
--     from the NEW mailbox, proving control; the swap is applied to `accounts`
--     and the staging row is consumed.
--   Dispute (POST /api/auth/recover/dispute): the OLD email-holder clicks the
--     dispute link within the dispute window; the staging row is voided so the
--     swap can never apply (and, if already applied, the dispute path is the
--     forensic signal — the audit trail in custody_audit_log survives).
--
-- The ORCID-recovery path is NOT staged here: it already proves possession of
-- a registered factor via a fresh OAuth round-trip, and an upgraded account's
-- ORCID-recovery path is severed separately (gate on upgraded_at IS NULL in
-- the /recover handler). This table covers only the memo-key (seed-phrase)
-- phase-1 staging.
--
-- No FK to `accounts`: mirrors the `custody_audit_log` convention on this
-- schema (no FK; the username is a soft link). A staging row outliving its
-- account is harmless — it expires via `verify_expires_at` and the phase-2
-- handler re-resolves the account by username at apply time, rejecting if the
-- account has since vanished or upgraded.
--
-- Token storage: both tokens are stored as raw 32-byte SHA-256 digests (BYTEA),
-- not the plaintext token, mirroring `accounts.signup_binding_hash`. The
-- plaintext token travels only in the emailed link; a DB read does not yield a
-- usable token. The phase-2 / dispute handlers hash the presented token and
-- look up by digest.
--
-- Idempotent: CREATE TABLE IF NOT EXISTS + CREATE INDEX IF NOT EXISTS let this
-- re-apply cleanly.

CREATE TABLE IF NOT EXISTS pending_recovery (
  id                   SERIAL PRIMARY KEY,
  username             TEXT NOT NULL,
  new_email            TEXT NOT NULL,
  -- Pre-hashed (argon2id) new password staged at phase 1 so the plaintext is
  -- never persisted and the expensive hash is paid once. NULL is structurally
  -- impossible on the memo-key path (password is required there) but the
  -- column is nullable for forward-compatibility with a future passwordless
  -- staged-recovery shape.
  new_password_hash    TEXT,
  -- SHA-256 of the verification token mailed to new_email (proves control of
  -- the new mailbox). Raw 32 bytes, mirroring accounts.signup_binding_hash.
  verify_token_hash    BYTEA NOT NULL,
  verify_expires_at    TIMESTAMPTZ NOT NULL,
  -- SHA-256 of the dispute token mailed to the OLD email (lets the prior
  -- owner void the swap). Raw 32 bytes.
  dispute_token_hash   BYTEA NOT NULL,
  dispute_expires_at   TIMESTAMPTZ NOT NULL,
  -- SHA-256 digest of the requesting IP for forensic correlation without
  -- retaining the raw address (GDPR data minimization, mirrors the audit-log
  -- PII-hashing posture). Nullable: the IP may be unavailable behind some
  -- proxy shapes.
  request_ip_hash      TEXT,
  -- SHA-256 digest of the OLD email at staging time. Survives even if the
  -- swap later applies and the old address is gone, so the forensic trail is
  -- self-contained.
  old_email_hash       TEXT,
  -- Set when the OLD email-holder disputes; a disputed row can never apply.
  disputed_at          TIMESTAMPTZ,
  -- Set when phase 2 applies the swap; a consumed row is single-use.
  consumed_at          TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Phase-2 and dispute handlers look up by token digest; index both.
CREATE INDEX IF NOT EXISTS idx_pending_recovery_verify_token
  ON pending_recovery(verify_token_hash);
CREATE INDEX IF NOT EXISTS idx_pending_recovery_dispute_token
  ON pending_recovery(dispute_token_hash);
-- A staging request supersedes any prior un-applied request for the same
-- username; the handler deletes stale rows by username before inserting.
CREATE INDEX IF NOT EXISTS idx_pending_recovery_username
  ON pending_recovery(username);

COMMENT ON TABLE pending_recovery IS
  'Staging rows for two-phase memo-key (seed-phrase) account recovery. Phase 1 '
  '(/api/auth/recover memo_key path) inserts a row after verifying the memo '
  'key; no accounts mutation happens until phase 2 (/api/auth/recover/verify) '
  'proves control of the new email via the mailed verify token. The old email '
  'receives a dispute link (/api/auth/recover/dispute) that voids the row. '
  'Tokens are stored as raw SHA-256 digests (BYTEA), never plaintext. No FK to '
  'accounts (soft username link, mirroring custody_audit_log); the phase-2 '
  'handler re-resolves the account and rejects if it vanished or upgraded.';

INSERT INTO schema_migrations (filename) VALUES ('012_pending_recovery.sql')
  ON CONFLICT (filename) DO UPDATE SET applied_at = NOW();
