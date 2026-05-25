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

---

## Architect re-review (2026-05-21, round-1 → round-2) — HELD PENDING FIXES

`/ce-code-review` ran with the always-on personas + security/adversarial/data-migrations/reliability/kieran-typescript conditional, plus the deployment-verification CE agent. Acceptance criteria 1 (partial unique index), 2 (HAF cross-check, already in place pre-task), 3 (409 on re-link, already in place pre-task), and 4 (fail-loud DO-block backfill scan) all land per the spec. Production paths are unaffected on the happy path (route-layer HAF check fires first); the DB constraint only catches direct-DB-write bypasses, which surface as 502 POST_BROADCAST_OPERATOR_REQUIRED via the existing 23xxx classification. Five new tests pass; no regression on 94 existing orcid tests. One item held — operator-message accuracy on the fail-loud branch.

### Item held (must fix before archive)

**1. (P2, conf 100, cross-reviewer — correctness + data-migrations) `dup_count` under-reports at >50 duplicate ORCIDs because the inner `LIMIT 50` caps the outer `COUNT(*)`.** The DO block's structure:

```sql
SELECT COUNT(*), COALESCE(string_agg(...), '')
INTO dup_count, dup_sample
FROM (
  SELECT orcid, string_agg(...) AS usernames
  FROM accounts WHERE orcid IS NOT NULL
  GROUP BY orcid HAVING COUNT(*) > 1
  LIMIT 50
) dups;
```

The `LIMIT 50` is inside the subquery to cap the sample-message size, but the outer `COUNT(*) INTO dup_count` then counts that capped result set — not the true count. If production has 60 duplicate-ORCID groups, the migration aborts with `dup_count=50` and a 50-line sample; the operator believes there are 50 to resolve when there are actually 60. Two-cycle resolution where one was expected.

Real-world impact on the beta accounts table is low (the route-layer HAF check prevents broadcast-time dupes; only ad-hoc operator UPDATE or data-import scripts can introduce dupes). But the operator-message accuracy on the fail-loud branch is the primary value of the DO block; getting it wrong is silently misleading.

Two acceptable fix shapes — implementer's choice:

- **Shape A — split queries.** Add an uncapped scalar `COUNT(*)` for the true magnitude, keep the existing capped subquery for the sample. Two passes over the small accounts table; trivial cost on PEvO's size.
- **Shape B — rephrase the RAISE.** Keep one query but phrase the message as `'at least % duplicate ORCID(s) found, showing first 50 in sample'` so the count is honest about being a cap. No SQL semantic change.

Test addition (mutation-kill the new shape): seed 51+ distinct duplicate ORCIDs in the existing migration-body RAISE test (`tests/migrations/accounts-orcid-unique.test.ts` sub-test (e)) and assert the RAISE message correctly reports the true magnitude (Shape A: exact 51; Shape B: contains the `at least` phrasing and a count ≥ 51).

### Items dismissed / deferred at architect triage

- **P2 (project-standards + maintainability + learnings) — migration header line 1 carries the task-slug citation `BACKEND-ACCOUNTS-ORCID-UNIQUE-CONSTRAINT`.** Deferred to a new umbrella sweep task `backend-anchor-rot-sweep-2026-05-21` (covers migrations 005/006/007 leading-title prefixes uniformly + sibling test-file anchor rot in the same convention class). Not held against this task to preserve the per-migration convention consistency across 005/006/007.
- **Implementer signal-block staleness — initAppDb mirror.** The signal at lines 62-66 claims the partial unique index is also mirrored in `initAppDb()`. The mirror was correct at this commit, but a later separate task (`backend-initappdb-schema-drift-fix`) removed all bootstrap DDL from `initAppDb()` — migrations are now sole schema authority. Note for the archive entry; no implementer action.
- Tests don't pin partial-WHERE necessity independently (test (a)'s indexdef regex is the canonical pin); RAISE message format payload only partially asserted; re-run-idempotency not separately covered. All dismissed per preemptive-test-hardening posture.
- CREATE UNIQUE INDEX (non-CONCURRENTLY) takes ACCESS EXCLUSIVE lock — accepted per single-instance posture + small accounts table.

### Re-review signal

When item 1 lands, `git mv` this file back to `tasks/review/`. The mv itself is the re-review signal. Round-2 architect review scopes `/ce-code-review` to the round-2 commit only.

Co-Authored-By: Claude Opus 4.7 (1M context) &lt;noreply@anthropic.com&gt;

---

## Backend re-review signal (2026-05-25, round-2 fix at branch HEAD)

Item 1 landed via **Shape A (split queries)**.

`backend/migrations/007_accounts_orcid_unique.sql` — the DO block now computes `dup_count` from a dedicated uncapped scalar `SELECT COUNT(*)` over the `GROUP BY orcid HAVING COUNT(*) > 1` duplicate-group set (no `LIMIT`), giving the TRUE magnitude. A second, separate `SELECT string_agg(...) ... LIMIT 50` builds only the bounded sample string. The `RAISE EXCEPTION` reports the uncapped `dup_count` and shows the first 50 groups in the sample, so the operator-facing fail-loud message no longer under-reports at >50 duplicate-ORCID groups. The `CREATE UNIQUE INDEX IF NOT EXISTS accounts_orcid_unique ... WHERE orcid IS NOT NULL` idempotency and the rest of the migration are unchanged.

`backend/tests/migrations/accounts-orcid-unique.test.ts` — the migration-body RAISE sub-test (formerly seeding one duplicate ORCID) now seeds 51 distinct duplicate-ORCID groups (each a pair of rows) inside the DROP-INDEX + INSERT + apply-migration-body transaction, then ROLLBACKs. It parses the integer the RAISE emits and asserts it equals 51 (and `> 50`), plus that the first (low-sorting) ORCID still appears in the capped sample. Mutation-kill: reverting to the single capped-COUNT query (`LIMIT 50` feeding the outer `COUNT(*)`) makes the reported count read 50, flipping the `toBe(51)` / `toBeGreaterThan(50)` assertions RED.

Verification:
- `cd backend && source ~/.nvm/nvm.sh && nvm use 20 && npm run typecheck && npm run lint` — both clean (lint's lone warning is the pre-existing unused-eslint-disable in `src/lib/author-supersession.ts`, untouched here).
- vitest NOT run in-worktree (the suite mutates the shared real-Postgres `accounts` table/index inside transactions; concurrent worktree runs would collide). Parent runs it serially after merge with:

  ```bash
  cd backend && source ~/.nvm/nvm.sh && nvm use 20 && \
  REDIS_URL="redis://:$(grep REDIS_PASSWORD ../.env | cut -d= -f2)@$(docker inspect pevo-redis-1 --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}'):6379" \
  APP_DATABASE_URL="postgresql://pevo:pevo_dev@$(docker inspect pevo-postgres-1 --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}'):5432/pevo_app" \
  npx vitest run tests/migrations/accounts-orcid-unique.test.ts
  ```

  Expected: 5/5 pass; the migration-body RAISE test reports a true count of 51 (not 50).

---

## Architect re-review (2026-05-25, round-2 → round-3) — HELD PENDING FIXES

`/ce-code-review` on commits `89f586b5..272b6401` (always-on personas + data-migrations conditional). The Shape A split-query restructure lands correctly: uncapped scalar `COUNT(*)` separately computed; capped `string_agg(...) LIMIT 50` query feeds only the sample-string; RAISE message reports the TRUE magnitude (verified at 60 dup groups, reported as 60 not "at least 50"). Test mutation-kill is sharp: `expect(reportedCount).toBe(51)` AND `expect(reportedCount).toBeGreaterThan(50)`, both flip RED on revert to the round-1 single-capped-COUNT shape. The 51 distinct duplicate-ORCID groups are seeded correctly (loop generates `0000`…`0050` third-segment with no collision). Idempotency preserved on `CREATE UNIQUE INDEX IF NOT EXISTS`. Sub-tests (a-d) untouched and unaffected. One item held — self-audit miss per the convention-enforcing-fix rule.

### Item held (must fix before archive)

**1. (P2, conf 75, project-standards) "Shape A: split queries" coordination-artifact anchor in the migration-body RAISE test comment.** Per `agents/docs/solutions/conventions/convention-enforcing-fix-must-audit-its-own-new-code-2026-05-17.md`, the round-2 fix introduced a new round-N-class anchor while addressing the round-1 hold. The comment in the new sub-test contains the architect's round-1 hold label ("Shape A: split queries"); once this task archives off the 250-line tasks-archive tail, "Shape A" has no referent. The neighboring sentences already convey the behavioral shape (uncapped scalar COUNT plus a separate LIMIT-50 sample-string query).

Fix: strip the parenthetical "(Shape A: split queries) " from the comment. The surrounding behavioral text remains. Audit-own-replacement: the rewrite MUST NOT introduce a new task-slug citation, round-N marker, line-number anchor, or SHA reference in its place.

### Items dismissed at architect triage

- Two-table-scan cost (Shape A scans `accounts` twice — once for the COUNT, once for the sample) accepted under PEvO accounts-table size + single-instance posture.
- TOCTOU between the two SELECTs (concurrent DELETE could make `dup_count > 0` with empty `dup_sample`) dismissed under migration-time + single-instance posture.
- Loop-index off-by-one comment phrasing in the test (cosmetic).
- Docblock mentions "SAVEPOINT-bracketed" but implementation uses BEGIN/ROLLBACK on a dedicated client connection; behavior is correct, vocabulary is doc-vs-code drift (deferable / fix-while-here at implementer's discretion).

### Re-review signal

When item 1 lands, `git mv` this file back to `tasks/review/`. The mv itself is the re-review signal. Round-3 architect review scopes `/ce-code-review` to the round-3 commit only.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>

---

## Backend re-review signal (2026-05-25, branch HEAD)

Round-3 hold item 1 landed.

**Item 1 (P2, project-standards) — coordination-artifact anchor in the migration-body RAISE test comment.** `backend/tests/migrations/accounts-orcid-unique.test.ts` — stripped the parenthetical that carried the architect's round-1 hold label from the comment above the `DUP_GROUP_COUNT` seed in the migration-body RAISE sub-test. The behavioral sentences are unchanged: the comment still states that the migration computes `dup_count` from an uncapped `COUNT(*)` over the `GROUP BY ... HAVING COUNT(*) > 1` set while only the sample string is LIMIT-50 capped, and that reverting to a single capped query flips the test RED. Audit-own-replacement clear: no task-slug citation, round-N marker, line-number anchor, or SHA introduced in place of the removed label. The dismissed SAVEPOINT-vocabulary docblock drift (a triage dismissal, not a held item) was left untouched to keep this round scoped to item 1.

**Verification:** `cd backend && npm run typecheck` clean; comment-only test change. Vitest run serially by the parent after the concurrent backend fan-out merges (the suite mutates the shared real-Postgres `accounts` table/index inside transactions; concurrent worktree runs collide). Expected: 5/5 in `tests/migrations/accounts-orcid-unique.test.ts` unaffected (comment-only edit, no assertion or seed change).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
