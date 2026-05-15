# BACKEND-CUSTODY-AUDIT-RETENTION-SWEEP — implement the 24-month time-based retention enforcement for `custody_audit_log`

**Owner:** Backend Agent
**Created:** 2026-05-15 (architect, surfaced by `/ce-code-review` on `backend-custody-audit-pii-annotation` — security SEC-1 P1 + data-migrations RR-1 P2 cross-corroborated)
**Priority:** P1 (PRE-LAUNCH BLOCKER — must land before real-user onboarding)

## Why pre-launch blocker

Migration 006 (`backend/migrations/006_custody_audit_pii_annotation.sql`) documents a 24-month retention period for `custody_audit_log.user_agent` in the column comment, but no periodic cleanup job exists. Under GDPR Art. 5(1)(e) storage limitation, a retention policy that lives only in a SQL comment and is not mechanically enforced is legally equivalent to indefinite retention. CNPD enforcement treats this as a documentation gap that becomes a concrete compliance breach the moment the first production row ages past 24 months. PEvO operates under Portuguese jurisdiction (memory `project_jurisdiction_portugal`).

This task must land BEFORE PEvO onboards real users, not just before the first row ages out. The compliance clock starts on first-row-insert; the enforcement clock has to be ticking by then.

## Problem

The right-to-erasure path on account deletion (`backend/src/routes/settings.ts:338` running `DELETE FROM custody_audit_log WHERE username = $1`) satisfies GDPR Art. 17 individual requests, but NOT the bulk time-based purge obligation under Art. 5(1)(e). Rows accumulate forever today.

## Goal

Implement a periodic job that drops `custody_audit_log` rows older than the retention period documented in the column comment on `custody_audit_log.user_agent`.

## Acceptance

1. **Sweep job lands** that runs `DELETE FROM custody_audit_log WHERE created_at < now() - interval '<retention>'` periodically. The `<retention>` value MUST be derived from a single source-of-truth — read the column comment via `col_description('custody_audit_log'::regclass, <attnum>)` at startup, parse the "Retention period: <N> months" line, and fail loud (boot-fatal) if the comment is missing or unparseable. Hardcoding `'24 months'` in two places (the migration comment AND the sweep) is forbidden per the migration's own "single retention number" framing.

2. **Trigger shape**: TBD by implementer — defensible options include (a) on-demand startup sweep on every process boot, (b) a `setInterval` periodic sweep on a daily/weekly cadence, (c) a one-shot sweep run via npm script invoked by external cron. Pick the simplest that meets the compliance requirement. **No new logging unless absolutely necessary** (per memory `feedback_pevo_logging_minimal` — PEvO is over-logged; don't add ops-visibility pino events without a concrete operator failure mode they catch).

3. **Backfill pass**: the first sweep run after deployment MUST drop pre-existing rows older than the retention period — not just newly-aged rows. The compliance gap pre-dates the sweep landing.

4. **Test coverage**: real-DB integration test asserting (a) rows newer than the retention period survive, (b) rows older than the retention period are deleted, (c) the SOT-from-COMMENT parse fails loud on missing/malformed comment. Per the project's test-mock carve-out, tests run against real Postgres.

5. **No PII scrubbing before delete**: per the parent task's analysis, full-row delete satisfies GDPR Art. 5(1)(c) and (e); in-place column scrub before delete is unnecessary overhead.

## Out of scope

- Retention sweeps on other tables. File separately if other audit tables surface PII columns; the column-level annotation pattern from migration 006 is the prerequisite.
- Reducing the retention period below 24 months. If 24 months proves too long for security-audit purposes the column comment is the right place to change the policy (migration 007 with the new retention SOT); the sweep inherits via the COMMENT-parse.

## Source

- Parent task: `backend-custody-audit-pii-annotation` (archive entry pending — task currently held for backend round-2 line-number + abstraction fixes).
- `/ce-code-review` on parent task (2026-05-15): security SEC-1 P1 anchor 100 + data-migrations RR-1 P2 anchor 75 cross-corroborated. Discussed at architect triage (architect session 2026-05-15).

## Cross-references

- `backend/migrations/006_custody_audit_pii_annotation.sql` — the SQL COMMENT carrying the retention SOT.
- `backend/src/routes/settings.ts` — the Art. 17 right-to-erasure path (lives at line 338 per architect re-verification).
- Sibling pre-launch GDPR follow-ups: `backend-custody-audit-user-agent-hash.md` (Art. 5(1)(c) data minimization); the LIA documentation update lands in architect-zone (`agents/docs/api-contracts/custody.md`) when parent task archives.
