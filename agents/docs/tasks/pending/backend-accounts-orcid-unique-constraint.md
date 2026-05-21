# BACKEND-ACCOUNTS-ORCID-UNIQUE-CONSTRAINT — Enforce single Hive-account binding per ORCID iD

**Owner:** backend
**Created:** 2026-05-21 (surfaced by full-codebase audit 2026-04-21, `.context/audit-2026-04-21/chunk-1-security-reviewer.md` + chunk-1-adversarial-reviewer.md + chunk-1-correctness-reviewer.md + chunk-3-data-migrations-reviewer.md)
**Priority:** P1 (security + data integrity)

## Context

`backend/migrations/001_schema.sql` defines `accounts.orcid TEXT` with no UNIQUE constraint. `backend/src/routes/orcid.ts` ORCID-login lookup uses `SELECT ... WHERE orcid = $1 LIMIT 1` without a uniqueness assumption, and `updateAccountOrcid` blindly overwrites whatever was there.

Consequences:
- ORCID login may return the wrong account if two accounts share the same ORCID (race or accidental dual-link).
- An attacker who establishes a link path to a victim's ORCID can silently rebind which Hive account that ORCID resolves to.
- HAF-side accreditation attestations and the DB-side `accounts.orcid` column drift apart.

This was flagged by four independent reviewer personas in the audit.

## Goal

Make ORCID-to-Hive-account binding 1:1 at every layer:

1. **Add a partial unique index** in a new migration:

   ```sql
   CREATE UNIQUE INDEX accounts_orcid_unique
     ON accounts (orcid)
     WHERE orcid IS NOT NULL;
   ```

   Partial so NULL-ORCID accounts (light + self-custody without ORCID link) don't collide.

2. **HAF cross-check on link/accredit broadcast.** Before broadcasting `accredit` or `link` for a username, query HAF for any prior accreditation attestation under the same ORCID. If one exists and refers to a different Hive account, refuse with 409.

3. **Return 409 on attempted re-link** instead of overwriting. The handler should never silently move an ORCID binding from account A to account B; ORCID transfer requires explicit revocation of the prior binding first.

4. **Backfill check** during migration: if any existing DB has duplicate ORCIDs, the migration must surface them (raise NOTICE or fail loud) so they can be resolved manually before the unique index is enforced.

## Non-goals

- ORCID-to-Hive-account-list (1:N), e.g. allowing the same researcher to have a personal and an institutional account. Out of scope; if needed later, the constraint becomes a more complex partial unique.
- Cross-instance ORCID uniqueness (different PEvO deploys). The chain attestation under the platform admin's signature is the cross-instance source of truth; DB constraint protects within-instance.

## Acceptance

- New migration adds the partial unique index on `accounts.orcid`.
- ORCID `link` / `accredit` paths check HAF before broadcast and refuse 409 on conflict.
- A test creates an account with ORCID X, then attempts to link a second account to ORCID X, and asserts 409.
- A test exercises the migration on a backfilled DB with deliberate duplicate ORCIDs to verify the surface-or-fail behavior.

## References

- Audit chunks:
  - `.context/audit-2026-04-21/chunk-1-security-reviewer.md`
  - `.context/audit-2026-04-21/chunk-1-adversarial-reviewer.md`
  - `.context/audit-2026-04-21/chunk-1-correctness-reviewer.md`
  - `.context/audit-2026-04-21/chunk-3-data-migrations-reviewer.md`
