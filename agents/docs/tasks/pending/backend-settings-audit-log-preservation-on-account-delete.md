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
