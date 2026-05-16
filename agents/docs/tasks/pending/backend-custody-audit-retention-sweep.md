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

---

## Architect re-review (2026-05-16, round-1 → round-2) — HELD PENDING FIXES

`/ce-code-review` ran on commit `fb9ecc8` (round-1 implementation). The SOT-from-COMMENT design holds, the regex matches migration 006's text cleanly, the DELETE shape is GDPR-adequate, and the boot wiring placement is correct. Four items surface — two P1 (one cross-reviewer-promoted to conf 100, one with prior-precedent in `agents/docs/solutions/conventions/`) and two P2.

### Items to address

**1. (P1, conf 100) Boot-fatal path lets `index.ts` continue past `await startRetentionSweep` to `bootedApp.listen()` while `flushAndExit` runs async.** `backend/src/jobs/custody-audit-retention-sweep.ts:163-187` — the internal `try { runSweep } catch { logger.fatal; flushAndExit(); return }` block catches the SOT-parse throw, calls `flushAndExit()` (async — process.exit fires after the flush callback or 2s watchdog), and returns. The awaiting caller at `backend/src/index.ts:102` continues past `await startRetentionSweep(getAppPool())` to `bootedApp.listen(config.port, ...)` on line 104. The backend accepts traffic for up to 2 seconds during what should be a hard boot-fatal SOT-parse failure.

Prior precedent: `agents/docs/solutions/conventions/boot-fatal-call-stack-unwind-and-rethrow-trap-2026-05-11.md` documents exactly this trap (the "catch-rethrow re-entry" failure mode + the `BootFatalError`-call-stack-unwind correct pattern). The fix: drop the internal try/catch and the explicit `flushAndExit()` call inside the helper; throw `BootFatalError` (or a plain Error and let the boot pipeline route it). The existing outer catch at `backend/src/index.ts:156-162` already invokes the canonical `flushAndExit()` without ever calling `listen()`, gated by the `if (app)` positive guard. Pattern reference: `backend/src/startup-checks.ts` for the `BootFatalError` shape used by `validateConfig` / `initBridgePostingKeyCache`.

**2. (P1, conf 100 cross-reviewer) Test (c) ROLLBACK is inside the try body, not in `finally`.** `backend/tests/jobs/custody-audit-retention-sweep.test.ts:175-204` — both (c) subtests (`null-comment-via-rollback` and `malformed-comment`) issue `await client.query('ROLLBACK')` as the last statement in the try block, with `client.release()` in `finally`. If `await expect(readRetentionMonths(client)).rejects.toThrow(...)` mismatches (future error-text drift or refactor changes the throw shape), Vitest rethrows; the ROLLBACK is skipped; the `finally` releases the client back to the pool with an open transaction; the next test borrowing that client inherits the cleared COMMENT — silently strips the production SOT from the live test database. Cross-reviewer agreement: testing T1 conf 90 + data-migrations DM-1 conf 75 → promoted to conf 100.

Fix: wrap the ROLLBACK in a nested `finally` block before `client.release()`. ~6 lines:

```typescript
const client = await pool.connect();
try {
  await client.query('BEGIN');
  try {
    await client.query(`COMMENT ON COLUMN custody_audit_log.user_agent IS NULL`);
    await expect(readRetentionMonths(client)).rejects.toThrow(/missing or empty/i);
    const months = await readRetentionMonths(pool);
    expect(months).toBeGreaterThanOrEqual(1);
  } finally {
    await client.query('ROLLBACK');
  }
} finally {
  client.release();
}
```

Apply to both subtests.

**3. (P2, conf 75) Boot DELETE has no statement_timeout or AbortController; collisions with `VACUUM FULL`, `pg_dump`, or large first-boot backfill can hang the boot indefinitely with no fatal log.** `backend/src/jobs/custody-audit-retention-sweep.ts` boot path — the startup sweep DELETE inherits the pool's default behavior, which is unbounded query wait. A degraded DB state during boot blocks the backend from accepting traffic AND from emitting the boot-fatal log (the boot is hung, not errored). Orchestrator healthcheck eventually kills the process; restart loop.

Recommended fix: split the SOT-parse from the backfill DELETE. Boot path runs `readRetentionMonths(pool)` ONLY — fail-loud on parse error (the current boot-fatal semantics), proceed without blocking on a DELETE. Move the first-sweep DELETE behind `listen()` so it runs as the first scheduled tick (still serves as backfill since the DELETE is idempotent and stateless). Alternatively (b) wrap the boot DELETE in an AbortController with a finite deadline + `SET LOCAL statement_timeout` inside a transaction; less clean but works.

**4. (P2, conf 75) Phantom `(?:\s+period)?` regex variant never appears in the live COMMENT.** `backend/src/jobs/custody-audit-retention-sweep.ts:70` — the optional capture group accepts "Retention period: <N> months" as a wording variant. Migration 006 writes "Retention: 24 months from row insert"; the "Retention period" form has never appeared in any live `COMMENT ON COLUMN`. The corresponding test case at `backend/tests/jobs/custody-audit-retention-sweep.test.ts` (the "wording variant" assertion) exercises a path the SOT never produces.

The in-code justification ("absorb minor future copy edits without forcing a code change") contradicts the module's fail-loud SOT philosophy: if a future migration changes the wording, the right outcome is a deliberate code change to the parser, not silent regex-tolerance of an unverified variant. Fix: tighten the regex to `/Retention\s*:\s*(\d+)\s+months/i`. Remove the corresponding test case.

### Items dismissed during architect triage

- Adversarial "boot hangs indefinitely when retention DELETE blocks on table-level lock" overlap with item 3 — bundled into the same fix; same root cause.
- Adversarial "first-match regex returns wrong retention if comment mentions earlier value" (e.g., a future "Historical retention: 60 months. Current Retention: 24 months." annotation) — does not apply to migration 006 today; revisit if a future migration adds a multi-Retention COMMENT. Below the gate at this confidence (75 + speculative trigger).
- Tick-pile-up at sustained DELETE >24h — speculative at PEvO volume (single-instance, low audit-log write rate). Documented residual; revisit at scale.
- Reliability "silent skip on pool null" — design choice mirroring `signup-cleanup`'s pattern; `initAppDb()` already warns at the misconfiguration point. Surfaced as documented residual risk, not blocking.
- All preemptive test-hardening findings per `feedback_dismiss_preemptive_test_hardening`.

### Re-review signal

When items 1-4 land, `git mv` this file back to `tasks/review/`. Round-2 architect review scopes `/ce-code-review` to the round-2 commit.
