-- One-time repair, step 2 of 2: delete the accounts rows that carry neither
-- verify_token nor username. Run repair-locked-signup-rows-count.sql first and
-- check its list; that file says what these rows are. Each deleted row's email
-- and ORCID iD become free to sign up again.
--
--   docker compose exec -T postgres psql -U pevo -d pevo_app -v ON_ERROR_STOP=1 \
--     --single-transaction -f - < backend/scripts/repair-locked-signup-rows-delete.sql
--
-- Not a migration: ./deploy.sh migrate re-applies every file under
-- backend/migrations on each deploy, which would make this a standing sweeper.

DELETE FROM accounts
 WHERE verify_token IS NULL
   AND username IS NULL
RETURNING id;
