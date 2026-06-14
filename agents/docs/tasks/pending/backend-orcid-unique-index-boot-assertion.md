# Boot assertion that the accounts_orcid_unique index physically exists (backend)

**Owner:** backend
**Created:** 2026-06-14

The `/signup` path writes `accounts.orcid` with **no application-level
ORCID-uniqueness check** — its only protection against a duplicate-ORCID row is the
partial unique index `accounts_orcid_unique` (`migrations/007`). But the boot-time
migration probe verifies the migration **filename was recorded**, not that the
**index physically exists**. If the index is ever absent while the migration row
survives, signup silently creates duplicate-ORCID rows with zero backstop.

From a 2026-06-14 adversarial audit of the ORCID-uniqueness invariant.

## Root cause

`verifyAppDbMigrations` (`backend/src/app-db.ts`) checks `to_regclass` for
`schema_migrations` and that the table carries a row per on-disk `*.sql` file. It
never checks `to_regclass('public.accounts_orcid_unique')`. Migration `008` backfills
the `007` row **unconditionally** (it does not gate on index existence), so the
"row present ⇒ index created" coupling holds only under the exact `deploy.sh`
runner (`set -euo pipefail` + per-file `psql -v ON_ERROR_STOP=1`, so a `RAISE` in
`007` aborts before `008` records its row). Any path that decouples them passes the
boot probe green with no index:

- a hand-run `DROP INDEX accounts_orcid_unique;` (perf experiment, incident cleanup);
- a `pg_dump`/restore that ships table rows (so the `schema_migrations` rows return)
  but omits or fails the post-data index section;
- migrations hand-applied out of order or without `ON_ERROR_STOP`.

With the probe green and the index gone, `/signup` (`auth.ts`) and
`updateAccountOrcid` (`orcid.ts`) silently create/rebind duplicate-ORCID rows.

## Acceptance criteria

1. In the boot-time DB verification (`verifyAppDbMigrations` /
   `verifyAppDbMigrationsWith`, `backend/src/app-db.ts`), add a check that
   `to_regclass('public.accounts_orcid_unique') IS NOT NULL`. On failure, throw the
   same `BootFatalError` path the existing probe uses so the backend refuses to
   start (mirrors the existing `schema_migrations`-missing behavior).
2. Keep the check cheap and idempotent; it runs once at boot. Do not widen it into a
   general "verify every index" sweep — scope to this one sole-guard index.
3. Test coverage: a boot-probe test that fails when the index is absent but the
   `007` `schema_migrations` row is present (the exact decoupled state above).

## Context / out of scope

- This is defense-in-depth for the sole-guard dependency, not the only fix. The
  companion app-level guard work for the signup/finalize paths is tracked
  separately (`backend-signup-confirm-orcid-binding-guard`).
- The check belongs in the same boot phase that already aborts on missing
  migrations (`index.ts` wires `verifyAppDbMigrations()`; `BootFatalError` →
  `flushAndExit()`), so a missing index fails fast at startup rather than at first
  duplicate write.
