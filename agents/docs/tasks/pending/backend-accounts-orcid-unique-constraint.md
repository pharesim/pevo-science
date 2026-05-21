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

## Backend implementer signal (2026-05-21)

Landed in three files:

- `backend/migrations/007_accounts_orcid_unique.sql` — adds the partial unique index `accounts_orcid_unique ON accounts (orcid) WHERE orcid IS NOT NULL`. Migration body opens with a DO block that scans for existing duplicate non-null ORCIDs and RAISES EXCEPTION with the dup count and a sample line of `orcid=… usernames=[…]` if any are found. The migration fails loud rather than silently producing a CREATE INDEX error, satisfying acceptance criterion 4.
- `backend/src/app-db.ts` — mirrors the partial unique index in `initAppDb()` so the fresh-container bootstrap path (dev, CI, new prod nodes before migration 007 runs) does not race the SQL migration runner and serve an unprotected schema briefly. Mirrors the pattern already used for migration 005 (the consent-op ALTER TABLE columns).
- `backend/tests/migrations/accounts-orcid-unique.test.ts` — new real-Postgres integration test covering: (a) index exists with the correct partial predicate, (b) SQLSTATE 23505 on duplicate non-null ORCID insert, (c) multiple NULL-ORCID rows allowed, (d) UPDATE self-bind reflexive case allowed, (e) the migration body's DO-block RAISE EXCEPTION fires when duplicates are present in the schema state (reproduced inside a transaction with DROP INDEX + dup-row INSERTs + apply migration body, then ROLLBACK to restore state).

Test DB had migration 007 applied via `docker exec pevo-postgres-1 psql -U pevo -d pevo_app_test -f 007.sql`. Production / live `pevo_app` DB was NOT applied (permission gate held); operator must run `./deploy.sh migrate` on the next deploy. The migration is idempotent (`CREATE UNIQUE INDEX IF NOT EXISTS`) so a re-apply is safe.

Acceptance criteria status:
- Goals 2 & 3 (HAF cross-check + 409 on re-link) were already implemented prior to this task via `findAccreditedAccountWithOrcid` in `backend/src/routes/orcid.ts` (verified during scoping). The existing `tests/routes/orcid.test.ts` "returns 409 ORCID_ALREADY_LINKED when the ORCID is bound to another account (accredit)" and "(link)" specs cover the route-layer 409 contract. This task closes the missing DB-layer defense.
- The new partial-unique index does not change wire-shape behavior on the happy path: route-layer HAF check fires first; the DB constraint only catches direct-DB-write bypasses, which surface as 502 POST_BROADCAST_OPERATOR_REQUIRED via the existing `isPermanentDbError` (SQLSTATE 23xxx) classification in `updateAccountOrcid`.

Test results:
- 5/5 new tests pass (`tests/migrations/accounts-orcid-unique.test.ts`).
- 94/94 existing orcid tests still pass (no regression).
- Typecheck (src): clean. Typecheck (tests): one pre-existing error in `tests/support/argon2-error-mocks.ts` (missing `isRetriableHafError` export — unrelated to this task).
- Lint (src/): clean (one pre-existing warning unrelated).
