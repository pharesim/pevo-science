# BACKEND-SETTINGS-AUDIT-LOG-PRESERVATION-ON-ACCOUNT-DELETE — Don't wipe audit history in the same txn that records the delete

**Owner:** backend
**Created:** 2026-05-21 (surfaced by full-codebase audit 2026-04-21, `.context/audit-2026-04-21/chunk-3-data-integrity-guardian.md` + `chunk-4-correctness-reviewer.md`)
**Priority:** P1 (data integrity + forensics + GDPR tension)

## Context

`backend/src/routes/settings.ts` email-delete handler runs a single transaction that:

```ts
await client.query(
  'INSERT INTO custody_audit_log (username, operation_type) VALUES ($1, $2)',
  [username, 'email_deleted'],
);

// Delete in FK-safe order
await client.query('DELETE FROM custody_audit_log WHERE username = $1', [username]);
await client.query('DELETE FROM notification_preferences WHERE username = $1', [username]);
await client.query('DELETE FROM accounts WHERE username = $1', [username]);
```

The comment "Delete in FK-safe order" gives the game away: `custody_audit_log` has a FK to `accounts.username`, and the developer deleted the audit rows so the `accounts` delete wouldn't violate the FK. But this destroys the forensic trail at the exact moment it becomes most useful — the account is being deleted.

This was flagged by two independent reviewer personas. An attacker who triggers `email_deleted` wipes their entire `custody_audit_log` history with a single API call (recovery attempts, upgrade events, key rotations, …). It's also unhelpful for legitimate GDPR erasure: the deleted-rows-then-deleted-account shape destroys the proof that the deletion happened.

## Goal

Decouple the FK from the deletion order: keep the audit row, drop the account row.

Two viable designs:

**Option A — anonymize on delete.** Add a migration that:
1. Drops the FK from `custody_audit_log.username → accounts.username`.
2. Adds a UNIQUE / index on `custody_audit_log.username` so anonymized rows can co-exist with reused usernames.
3. On account delete: UPDATE `custody_audit_log` SET `username = NULL` (or a hashed anonymized form) WHERE `username = $1`. Then DELETE `accounts`.

The audit row for `email_deleted` survives with anonymized username, satisfying both GDPR (no PII) and forensics (the operation type and timestamp remain).

**Option B — separate audit-log lifetime.** Move the audit log to a write-only append store (S3, log aggregator, separate schema with restricted DELETE permissions). The application-side `custody_audit_log` table becomes a hot-recent-events index; the durable trail lives elsewhere.

Recommendation: Option A. It's a single migration plus one query change, and PEvO doesn't yet have a write-only audit destination.

## Non-goals

- Generalized GDPR-erasure-with-forensics framework. Scope to `custody_audit_log` for now.
- Backfilling anonymization for already-deleted accounts (the rows are gone — there's nothing to backfill).

## Acceptance

- Migration adds a path for `custody_audit_log` rows to survive account deletion (either FK drop + anonymize, or external store).
- Email-delete handler no longer issues `DELETE FROM custody_audit_log` in the same transaction.
- A test verifies that after `email_deleted`, the audit row exists with the operation type recorded (and PII appropriately anonymized).
- ARCHITECTURE.md `§ data lifecycle` notes the new policy.

## References

- Audit chunks:
  - `.context/audit-2026-04-21/chunk-3-data-integrity-guardian.md` (P1: audit log wiped by same transaction).
  - `.context/audit-2026-04-21/chunk-4-correctness-reviewer.md` (P1: same finding, correctness lens).
- Related: `backend-recover-email-verification-and-notify.md` (recovery logging depends on this surviving).

## Backend implementer signal

Option A taken (anonymize-on-delete).

Schema correction: the task Context described a FK from `custody_audit_log.username → accounts.username`, but no such FK exists in `001_schema.sql` or any later migration (confirmed via `\d custody_audit_log` against the running DB). The "Delete in FK-safe order" comment in the route handler was misleading — the DELETE was application-level cleanup, not FK-enforced. The substantive concern (audit history wipe at deletion time) was still real and is what this implementation addresses.

Changes landed:
- `backend/migrations/009_audit_log_fk_anonymize.sql` — drops the NOT NULL constraint on `custody_audit_log.username` so anonymized rows can co-exist with reused usernames; updates the column COMMENT on `username`; supersedes the COMMENT on `user_agent` (from migration 006) to reflect the new right-to-erasure path. Migration applied to both `pevo_app` and `pevo_app_test`.
- `backend/src/app-db.ts` — mirrors the DROP NOT NULL idempotently into the initAppDb bootstrap path so fresh-container boots before migration 009 runs (dev/CI) still see the nullable column.
- `backend/src/routes/settings.ts` — replaces `DELETE FROM custody_audit_log WHERE username = $1` with `UPDATE custody_audit_log SET username = NULL, user_agent = NULL, session_id = NULL WHERE username = $1`. Order preserved so the `email_deleted` INSERT happens before the anonymize UPDATE; the just-inserted row is then anonymized alongside all prior rows.
- `backend/tests/routes/settings.test.ts` — added a DB-backed test that seeds two prior audit rows (one consent-op with PII columns populated, one non-broadcast), triggers DELETE, and asserts (a) no row remains bound to the deleted username, (b) the accounts row is gone, (c) the three operation_type rows survive with username/user_agent/session_id all NULL.

Out of scope for backend zone:
- `agents/docs/ARCHITECTURE.md` § 4 (~line 240) currently documents the DELETE policy as the right-to-erasure path. This contradicts the new anonymize-on-delete behavior. **Architect: please update the trailing sentence ("the user's 'delete my account' path MUST `DELETE FROM custody_audit_log WHERE username = $1` inside the same transaction") to describe the anonymize UPDATE instead.** The migration COMMENTs and the route handler's comment block describe the new policy in full.

Verification:
- Lint: pass (one pre-existing warning in unrelated `author-supersession.ts`).
- Typecheck: pass (both src and tests).
- Targeted test: `settings.test.ts` 23/23 pass; full settings cluster 63/63 pass.

## Architect review (2026-05-26) — HELD PENDING FIXES

Reviewed via `/ce-code-review` on commit `8198de0d` (correctness, security,
adversarial, testing, maintainability, project-standards, data-migrations,
reliability, kieran-typescript, performance, learnings). The core change —
anonymize-on-delete instead of wiping `custody_audit_log` — is sound and
achieves the task goal. Seven items to land before archive (all triaged with
the user 2026-05-26):

1. **Reword the right-to-erasure claim; do NOT NULL `tx_id`/`block_num`.**
   The anonymize UPDATE correctly leaves `tx_id`/`block_num`, but migration
   009's COMMENT claims "GDPR Art. 17 right-to-erasure: no PII remains." For
   broadcast-type rows `tx_id` resolves on any public Hive node back to the
   signer, so that claim is inaccurate. Decision: on-chain references are
   inherently-public data the user themselves signed; they are retained by
   design. Correct the wording in migration 009's COMMENT(s) and the
   `settings.ts` handler comment to say the erasure covers the username link
   and the PII-derived columns (`user_agent`, `session_id`), NOT the
   public-ledger `tx_id`/`block_num`. The canonical wording now lives in
   `ARCHITECTURE.md` § 4 (architect corrected it this review) — mirror that.

2. **Assert forensic columns SURVIVE the anonymize.** The new test only reads
   back the NULLed columns, so a regression adding any forensic column to the
   `SET … = NULL` clause passes silently. Seed a known `tx_id` and
   `auth_mechanism` on the `author_accept` row and assert (after the delete)
   those forensic columns retain their seeded values. This is the guardrail
   for item 1's "tx_id survives by design" decision.

3. **Pin seeded rows by id.** Capture `RETURNING id` on the seed INSERTs and
   scope BOTH the survival query and the `finally` cleanup to `id IN (…)`
   instead of `operation_type IN (…) AND username IS NULL AND created_at >=
   NOW() - INTERVAL`. The current time-window/op-type identification is
   non-deterministic and the broad `finally` DELETE can clobber anonymized
   rows seeded by sibling tests running in parallel against the shared DB.
   Fixing this also lets the survival assertion be `=== expected` rather than
   `>= 3`, and removes the misleading "identify via tx_id markers" comment.

4. **Fix the inverted ordering comment.** The "Order matters:" block in the
   delete handler says the alternative order "would NULL the new row," but the
   current INSERT-first order is exactly what NULLs the just-inserted
   `email_deleted` row (intended). Reword so the rationale matches behavior;
   a maintainer must not be misled into reordering and breaking the
   email_deleted anonymization.

5. **Correct the "follow-up" cleanup comment.** Migration 009's COMMENT calls
   periodic cleanup "a follow-up," but `custody-audit-retention-sweep` already
   deletes by `created_at` and covers anonymized (NULL-username) rows. Update
   the COMMENT to reference the existing sweep.

6. **Drop the local-variable anchor.** Migration 009's `user_agent` COMMENT
   cites the `auditExtras` local variable as a navigation anchor. Replace it
   with the stable route-path anchor (the `POST /api/custody/broadcast`
   handler in `backend/src/routes/custody.ts`).

7. **Guard the ROLLBACK.** The bare `await client.query('ROLLBACK')` in the
   delete handler's `catch` can mask the original `txErr` if ROLLBACK itself
   throws. Add `.catch(() => {})`, matching the pattern in `recover.ts`.

When landed, `git mv` this file back to `tasks/review/` (the move is the
re-review signal). Re-review will scope to the commits since this hold block.
