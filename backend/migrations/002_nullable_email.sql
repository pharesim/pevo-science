-- Allow NULL email for ORCID-only accounts
ALTER TABLE accounts ALTER COLUMN email DROP NOT NULL;
