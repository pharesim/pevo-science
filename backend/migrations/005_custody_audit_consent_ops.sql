-- Migration 005: extend custody_audit_log so consent-op broadcasts
-- (author_accept / author_resign) carry the auth-mechanism, session, and
-- user-agent fields that ARCH.md "Light-account signing of consent ops"
-- requires.
--
-- Existing rows have NULL for the new columns. The custody-broadcast
-- success path keeps writing the same op_type / tx_id / block_num; new
-- columns are populated only when fresh-auth was required (i.e., for
-- consent-op operations).

ALTER TABLE custody_audit_log
  ADD COLUMN IF NOT EXISTS auth_mechanism TEXT,
  ADD COLUMN IF NOT EXISTS fresh_auth_outcome TEXT,
  ADD COLUMN IF NOT EXISTS session_id TEXT,
  ADD COLUMN IF NOT EXISTS user_agent TEXT;
