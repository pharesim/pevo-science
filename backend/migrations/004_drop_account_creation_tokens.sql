-- Drop the account_creation_tokens table.
--
-- Per BE-ACCOUNT-CREATION-TOKENS-DROP: the table was a soft proxy for the
-- on-chain `pending_claimed_accounts` counter on `config.hiveOnboardAccount`.
-- The chain counter is the canonical view; the DB mirror generated the entire
-- DI-1 / DI-2 / reconcile complexity surface without earning its keep at
-- PEvO's beta volume. We now read the counter directly from Hive (cached in
-- Redis with a short TTL) for capacity checks, and let chain consensus
-- serialize concurrent `create_claimed_account` ops.
--
-- No data migration: rows in this table were fungible (`generate_series`
-- inserts) with no downstream consumers. The `used_for` audit column was
-- written but never read; chain history is the public audit.

DROP TABLE IF EXISTS account_creation_tokens;
