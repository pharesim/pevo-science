-- Bind the signup auth_token to the browser session that initiated it.
--
-- Possession of an `accounts.verify_token` value (random hex during the
-- pre-email-verify window, `confirmed:…` after `/api/auth/verify`) was the
-- sole credential for `/api/auth/confirm` and `/api/auth/link`. That made
-- the token capability-equivalent to a password: anyone who could read a
-- mailbox, observe a Referer header, or pull the token out of a login
-- error body could complete the signup with their own browser-controlled
-- Hive keys.
--
-- The fix binds the auth_token to the browser session that initiated the
-- signup. The session-binding secret is a 32-byte random value stored in an
-- httpOnly cookie (`pevo_signup_session`); the SHA-256 of that value is
-- written to `signup_binding_hash` on the same `accounts` row at the
-- ceremony that mints the auth_token (`/signup`, `/verify`, `/resume-signup`,
-- and the `PENDING_SIGNUP` login branch). `/confirm` and `/link` then require
-- both the cookie AND a matching DB hash before proceeding.
--
-- The column is nullable for two reasons:
--   1. Backfill: existing pending-signup rows have no cookie minted; they
--      cannot bind retroactively. Letting the column be NULL on those rows
--      means /confirm and /link can keep treating them as "no binding
--      present" rather than crashing the migration. The route handlers
--      reject NULL-binding rows for new requests; the legacy in-flight rows
--      time out via their existing 24h `expires_at` and never complete.
--   2. ORCID-only and email-skipping ceremonies that never set
--      `verify_token` need not pay the binding cost. The column being
--      nullable keeps the schema honest about state.
--
-- No new index: the column is only ever read by `id` lookups (the row is
-- already located via `verify_token` or `username`), so the existing
-- `idx_accounts_verify_token` and `idx_accounts_username` indexes cover the
-- query plans. A dedicated index on `signup_binding_hash` would help a
-- "find row by binding alone" lookup; no such lookup exists by design (the
-- binding is verified against the row found via auth_token, not the
-- primary discovery key).
--
-- BYTEA over TEXT: SHA-256 outputs 32 raw bytes; storing as bytea avoids
-- the hex-encode + 64-char TEXT overhead and matches the existing
-- `posting_key_enc` / `iv_*` columns on this table.

ALTER TABLE accounts ADD COLUMN IF NOT EXISTS signup_binding_hash BYTEA;

COMMENT ON COLUMN accounts.signup_binding_hash IS
  'SHA-256 of the `pevo_signup_session` httpOnly cookie value minted at every '
  'auth_token-issuing ceremony (signup, verify, resume-signup, and the '
  'PENDING_SIGNUP login branch). The /confirm and /link handlers reject any '
  'request whose cookie hash does not equal this column. NULL means no '
  'binding was minted for this row — pre-migration in-flight signups, '
  'ORCID-only rows that never reached a binding ceremony, or post-completion '
  'rows. Stored as raw bytes (BYTEA, 32 bytes) rather than hex TEXT to mirror '
  'the encrypted-key columns on this table.';

INSERT INTO schema_migrations (filename) VALUES ('010_accounts_signup_binding_hash.sql')
  ON CONFLICT (filename) DO UPDATE SET applied_at = NOW();
