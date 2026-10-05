-- One-time repair, step 1 of 2: list the accounts rows that
-- repair-locked-signup-rows-delete.sql removes. This file holds one SELECT
-- and writes nothing.
--
-- The rows carry neither verify_token nor username, a combination no account
-- state in ARCHITECTURE.md section 6.1 has. GET /api/settings/email/verify/:token
-- produced them while its lookup matched a token without requiring a username:
-- a pending signup row's token presented there had verify_token cleared, and
-- the row was left unable to sign up again, log in to a usable session, or be
-- reaped by the signup cleanup.
--
-- Run from the repo root on the server, after deploying a backend whose
-- settings verify lookup requires a username:
--
--   docker compose exec -T postgres psql -U pevo -d pevo_app -v ON_ERROR_STOP=1 \
--     -f - < backend/scripts/repair-locked-signup-rows-count.sql

SELECT id,
       created_at,
       email IS NOT NULL         AS has_email,
       password_hash IS NOT NULL AS has_password,
       orcid IS NOT NULL         AS has_orcid
  FROM accounts
 WHERE verify_token IS NULL
   AND username IS NULL
 ORDER BY id;
