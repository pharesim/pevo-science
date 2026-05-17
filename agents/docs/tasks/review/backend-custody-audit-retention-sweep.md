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

---

## Backend re-review signal (2026-05-16, round-2 fix commit)

Round-1 hold items 1-4 landed in `backend/src/jobs/custody-audit-retention-sweep.ts`, `backend/src/index.ts`, and `backend/tests/jobs/custody-audit-retention-sweep.test.ts`.

- **Item 1 (P1 boot-fatal call-stack unwind)** — Dropped the helper's internal `try { runSweep } catch { logger.fatal; flushAndExit(); return }` block at the old line range 163-187. `startRetentionSweep(pool)` now reads the SOT via `readRetentionMonths(pool)` and re-throws as `BootFatalError` (`custody-audit-retention-sweep.ts:180-200`). The throw propagates out of the awaited call inside `initAppDb().then(...)` at `backend/src/index.ts:102` into the sibling `.catch` at `index.ts:156-162`, which routes through `flushAndExit()` before `bootedApp.listen()` ever runs. Removed the now-unused `flushAndExit` import. Followed `agents/docs/solutions/conventions/boot-fatal-call-stack-unwind-and-rethrow-trap-2026-05-11.md`; `BootFatalError` shape mirrors `backend/src/startup-checks.ts`.
- **Item 2 (P1 test (c) ROLLBACK placement)** — Wrapped `await client.query('ROLLBACK')` in a nested `finally` block inside both (c) subtests (`backend/tests/jobs/custody-audit-retention-sweep.test.ts:174-185` for the null-comment subtest, `194-209` for the malformed-comment subtest). If the inner `expect(...).rejects.toThrow(...)` assertion ever mismatches, the ROLLBACK now runs before `client.release()` returns the connection to the pool, so a stale BEGIN with the cleared COMMENT cannot leak across tests.
- **Item 3 (P2 split SOT-parse from backfill DELETE on boot)** — `startRetentionSweep(pool)` now only validates the SOT at boot (no DELETE). Added `startRetentionSweepTicker(pool)` at `custody-audit-retention-sweep.ts:218-236` that runs the first sweep DELETE immediately (preserving the "backfill on first deploy" acceptance — DELETE is idempotent and stateless) and schedules the 24h `setInterval`. Wired the ticker inside the `bootedApp.listen(...)` callback at `backend/src/index.ts` alongside `startSignupCleanup` / `startBatchReputation` / sibling jobs. `stopRetentionSweep()` stays as-is (still clears the same module-scoped `sweepTimer`).
- **Item 4 (P2 tighten regex, drop phantom variant)** — Tightened the regex at `custody-audit-retention-sweep.ts:82` to `/Retention\s*:\s*(\d+)\s+months/i` (dropped the `(?:\s+period)?` capture group that never matched migration 006's live SOT). Updated the parser docstring (`custody-audit-retention-sweep.ts:53-62`) and inline regex comment (`77-81`) to reflect the single-wording stance. Removed the corresponding `'Retention period: 36 months'` test case at `backend/tests/jobs/custody-audit-retention-sweep.test.ts:68-70`.

**Verification gates run.**
- `npm run lint`: clean (only pre-existing `seed-phrase.ts` warnings, unrelated).
- `npx tsc --noEmit`: clean.
- Tests not run in worktree per fan-out protocol; parent serializes after merge.

---

## Architect re-review (2026-05-16, round-2 → round-3) — HELD PENDING FIXES

`/ce-code-review` ran on commit `d0a8e22` (9 reviewers: correctness/adversarial on Opus; testing, maintainability, project-standards, learnings-researcher, reliability, data-migrations, kieran-typescript on Sonnet; `ce-agent-native-reviewer` skipped per project CLAUDE.md). All four round-1 hold items land in intent (BootFatalError throws, ROLLBACK nested-finally, split SOT-validate from first-tick DELETE, tightened regex). Seven items held; zero dismissed; zero routed to follow-ups.

### Items held (must fix before archive)

**1. (P1, conf 90 — cross-reviewer-promoted: adversarial adv-1 P1 + kieran-typescript KT-1 P2) BootFatalError thrown inside `initAppDb().then(...)` routes to the `'Failed to initialize app database'` `.catch` — convention's own constraint comment warns against this.** `backend/src/index.ts:106` (the `await startRetentionSweep(...)` call) is inside `initAppDb().then(async () => { ... })`. When it throws BootFatalError, the rejection propagates to the sibling `.catch` at `index.ts:166-172`, which unconditionally logs `logger.fatal({err}, 'Failed to initialize app database')` — no `instanceof BootFatalError` discrimination on that path.

  The constraint comment at `index.ts:61-65` explicitly warns: "Introducing await or moving these into a .then chain would route BootFatalError to the wrong handler (e.g. initAppDb().catch logged as Failed to initialize app database), defeating the structured boot-fatal path." The round-2 fix does EXACTLY that — adds the BootFatalError throw inside the .then chain.

  `flushAndExit` does fire before `listen()` (stated round-2 goal met), but the operator-alerting contract is degraded: a retention SOT-parse failure ships an alert labeled "app DB init failed" — wrong subsystem, on-call triage is misdirected, CNPD-readiness signal is muddled.

  Fix shape (architect call between two options):
  - **Option A — discriminate in the async .catch:** at `index.ts:166`, mirror the synchronous catch's pattern: `if (err instanceof BootFatalError) { logger.fatal({err}, err.message); } else { logger.fatal({err}, 'Failed to initialize app database'); } await flushAndExit();`. One file edited; preserves the .then-chain structure.
  - **Option B — move readRetentionMonths into the module-evaluation try/catch alongside validateConfig:** the synchronous try/catch at `index.ts:80-84` already discriminates BootFatalError correctly. Move `readRetentionMonths(pool)` validation to a function callable from the sync path (it needs the pool, so this means either deferring pool init to sync, or accepting that this routing is best in the existing async path with Option A).
  - Architect recommendation: Option A. The async path is the right place for pool-dependent boot checks; the fix is a single-file `instanceof` discriminator that brings the alert labeling into spec.

**2. (P2, conf 75, maintainability M1) Function name `startRetentionSweep` is now a misnomer after the round-1 boot/ticker split.** `backend/src/jobs/custody-audit-retention-sweep.ts:182` — the function now only validates the SOT (reads the COMMENT via `col_description`, parses retention months); the actual sweep is started by `startRetentionSweepTicker`. A reader seeing `await startRetentionSweep(getAppPool())` at `index.ts:106` reasonably expects a DELETE to run. The docblock corrects this, but the name is the first-read interface.

  Fix shape: rename to a name that matches behavior. Options: `validateRetentionSweepConfig`, `assertRetentionSweepReady`, `readAndValidateRetentionSOT`. Architect recommendation: `validateRetentionSweepConfig` (matches the validation-only semantics + boot-fatal-on-failure shape, parallel to `validateConfig`). Update the call site at `index.ts:106` and any exports/test imports.

**3. (P2, conf 100 — cross-reviewer-promoted: maintainability M3 + kieran-typescript KT-2) Comment claims "cause chain via `{cause: err}`-style logging" but `BootFatalError` constructor takes only `message: string`.** `backend/src/jobs/custody-audit-retention-sweep.ts:193-200` — the comment block at lines 193-195 says "The original throw's message is preserved in the cause chain via `{cause: err}`-style err logging at the catch site." The `new BootFatalError(...)` call at lines 196-200 passes only a message string interpolating the original error's message; no `{ cause: err }` second argument exists in BootFatalError's constructor. There is no `.cause` property on the thrown BootFatalError; only the `.message` substring survives. Future readers attempting to access `err.cause` or add structured cause logging will be misled.

  Fix shape (architect call):
  - **Option A — update BootFatalError to accept an ErrorOptions argument** so the comment becomes accurate. Touches `backend/src/startup-checks.ts` (or wherever BootFatalError is defined). Three callsites today (`validateConfig`, `initBridgePostingKeyCache`, and now this); updating the class is cheap, and the .cause property is the standard ES2022 way to preserve cause chains.
  - **Option B — rewrite the comment to match the current flat-message implementation.** "The original throw's message is template-interpolated into the BootFatalError message string at the catch site; no `.cause` property is preserved." Honest but admits a hole vs the standard pattern.
  - Architect recommendation: Option A. Standardize on `{ cause: err }` across the three boot-fatal sites; preserves stack-trace context that's lost today; aligns with ES2022 conventions.

**4. (P2, conf 75, maintainability M2) Docblock has raw line-number anchor `(lines 156-162)` referencing `index.ts`.** Same `backend/src/jobs/custody-audit-retention-sweep.ts:169`. Per convention `agents/docs/solutions/conventions/docblock-anchor-stable-symbols-not-line-numbers-2026-05-15.md`, raw line numbers rot on any insertion above the cited range. Fix: replace with a behavioral/symbol anchor — e.g., `the .catch of the initAppDb().then(...) chain in index.ts`. (Becomes especially relevant when item 1's discrimination fix lands and the catch range shifts.)

**5. (P2, conf 90, testing T1+T2+T3) No test pins `startRetentionSweep` throwing `BootFatalError` on missing/malformed COMMENT + no test for `startRetentionSweepTicker` at all + test file header is stale.** Three subgaps in `backend/tests/jobs/custody-audit-retention-sweep.test.ts`:

  - (a) `startRetentionSweep`'s catch-and-rethrow-as-BootFatalError branch (round-2 item 1) is untested. The (c) subtests pin `readRetentionMonths` throwing, but no test asserts `startRetentionSweep.rejects.toThrow(BootFatalError)` or instance-checks the thrown error. A mutation replacing `throw new BootFatalError(...)` with a bare `throw` or `return` in the catch block would ship green.

  - (b) `startRetentionSweepTicker` is a new exported function with three branches (null-pool early-return, immediate `runSweep().catch()` fire-and-forget, 24h `setInterval` scheduling). No test imports or calls it. A regression dropping the first-tick `runSweep` call (or accidentally swapping the order with the setInterval registration) would not be caught.

  - (c) Test file header comment (lines 13-22) still describes the OLD `flushAndExit` mechanism as the coverage rationale and points to `flush-and-exit.test.ts`. After round-2 item 1, the mechanism is BootFatalError rethrow caught by `index.ts`'s outer .catch — flush-and-exit.test.ts does NOT cover that rethrow path. Header rationale is now incorrect.

  Fix shape:
  - Add a `startRetentionSweep` direct-call test (small `pg.Pool` mock returning `{rows: []}` is acceptable under the carve-out — clause (b) doesn't apply since this isn't an auth-focused suite; the documented carve-out justification covers it) and assert `rejects.toThrow(BootFatalError)`.
  - Add a `startRetentionSweepTicker(null)` smoke test (null-pool early-return; no throw, no setInterval registered).
  - Update the test file header (lines 13-22) to describe the actual BootFatalError mechanism. Either reference the new test (5a) or note explicitly that the function-level rethrow IS pinned in this file.

**6. (P2, conf 75, reliability R1) First-tick gating design choice is undocumented.** `backend/src/jobs/custody-audit-retention-sweep.ts:220-238` — `startRetentionSweepTicker` fires `runSweep(pool).catch(...)` as a floating promise, then immediately calls `setInterval` without waiting for the first sweep. For 24h cadence on single-instance this is safe (a second tick at +24h won't collide with the first). For shorter cadences or under DB contention the design needs to be a deliberate choice, not an inferred one.

  Fix shape: add a docblock comment above the immediate first-tick / setInterval block: "First tick fires immediately (un-awaited) so the DELETE backfill runs at boot without blocking the ticker's interval registration. The next setInterval tick fires at +24h; for the configured cadence (FRESH_AUTH_TTL... no wait, RETENTION_SWEEP_INTERVAL_MS = 24h), even a slow first sweep cannot collide with the next tick. If the cadence is ever shortened, add an in-flight guard before scheduling subsequent ticks." Documents the design rationale + flags the future-shortening risk in code.

**7. (P3, conf 75, maintainability M4) Task-slug citations in module-header docblocks.** `backend/src/jobs/custody-audit-retention-sweep.ts:6` (module header) and `:76` (`parseRetentionMonthsFromComment` docblock) both cite `BACKEND-CUSTODY-AUDIT-RETENTION-SWEEP`. Per `task-slug-citations-in-comments-go-stale-on-archive-2026-05-15.md`, slugs become dead pointers on archive. The module-header slug doubles as an op-grep token; if that's its load-bearing role, a durable replacement is a stable module-identity string (e.g., the module path `custody-audit-retention-sweep.ts` itself as the canonical name) or a citation to the GDPR Art. 5(1)(e) anchor already in the module. The function-docblock slug at line 76 adds nothing the function description doesn't already cover — drop it.

### Items dismissed during architect triage

- None at confidence ≥75. Three adversarial residuals at lower confidence (SIGTERM-during-first-tick race, post-boot COMMENT corruption silent error, setInterval re-entrancy guard absence) all bounded by single-instance topology + the existing `.catch` error logs; below the actionable gate.

### Routed to follow-up tasks (not held here)

- None — all items are within this task's scope and code surface.

### Architect-zone work landing at archive (not held)

- None — sweep r2 is entirely backend-zone code; no architect-doc updates needed at archive.

### Re-review signal

When items 1-7 land, `git mv` this file back to `tasks/review/`. Round-3 architect review scopes `/ce-code-review` to the round-3 commit only.

Note for the implementer: items 1, 2, 4, 5 cluster on the same file group (custody-audit-retention-sweep.ts + index.ts + the test file) and can be addressed in a single fix commit. Items 3 (BootFatalError + cause), 6, 7 are minor independent edits. Recommend: one focused commit for items 1+4+5 (BootFatalError routing + line-anchor + test gap), a second commit for item 2 (rename), a third for item 3 if Option A is chosen (BootFatalError class update touches startup-checks.ts), and one final commit folding items 6+7 (docblock cleanup). Or any logical grouping the implementer prefers — the architect re-review will scope `/ce-code-review` to the full commit range from this hold to the next `git mv` to review/.

---

## Backend re-review signal (2026-05-16, round-3 fix commit)

Round-2 hold items 1-7 landed across `backend/src/index.ts`, `backend/src/startup-checks.ts`, `backend/src/jobs/custody-audit-retention-sweep.ts`, and `backend/tests/jobs/custody-audit-retention-sweep.test.ts`.

- **Item 1 (P1 boot-fatal call-stack unwind)** — Updated the `.catch` of the `initAppDb().then(...)` chain in `backend/src/index.ts` (the async-arm catch) to discriminate `instanceof BootFatalError`. When the `validateRetentionSweepConfig` throw routes here (the SOT-parse failure path), the catch logs `{err}` with `err.message` as the message rather than the mislabelled `'Failed to initialize app database'`; otherwise the legacy `'Failed to initialize app database'` message stays. Mirrors the sync top-level catch pattern at `index.ts:80-85`. `flushAndExit()` still runs unconditionally.
- **Item 2 (P2 rename)** — Renamed `startRetentionSweep` to `validateRetentionSweepConfig` across `backend/src/jobs/custody-audit-retention-sweep.ts` (export + docblock cross-references), `backend/src/index.ts` (import + call site + log comment), and `backend/tests/jobs/custody-audit-retention-sweep.test.ts` (header reference + new direct-call tests). Name now reflects validation-only semantics (no DELETE at boot — that work lives in `startRetentionSweepTicker`).
- **Item 3 (P2 BootFatalError {cause} mismatch, Option A)** — Updated `BootFatalError` constructor in `backend/src/startup-checks.ts` to accept `ErrorOptions` (`message: string, options?: ErrorOptions`) and forward via `super(message, options)`. Updated the new throw site at `backend/src/jobs/custody-audit-retention-sweep.ts` (`validateRetentionSweepConfig`'s catch) to pass `{cause: err}` and rely on the actual `.cause` property (dropped the manual `: ${err.message}` interpolation). Existing boot-fatal sites (`validateConfig`, `initBridgePostingKeyCache`) currently throw without a cause; adopting the `{cause: err}` form there is a separate refactor and is noted in the BootFatalError docblock — this commit only adopts at the new site.
- **Item 4 (P2 line-anchor → behavioral anchor)** — Replaced the `(lines 156-162)` line-number anchor in the `validateRetentionSweepConfig` docblock with the behavioral anchor "the `.catch` of that `initAppDb().then(...)` chain, which discriminates `instanceof BootFatalError`". Per `agents/docs/solutions/conventions/docblock-anchor-stable-symbols-not-line-numbers-2026-05-15.md`.
- **Item 5 (P2 test gaps)** —
  - (a) Added `validateRetentionSweepConfig` direct-call tests in a new `describe('validateRetentionSweepConfig — boot-fatal rethrow contract')` block: asserts `rejects.toBeInstanceOf(BootFatalError)` on missing comment, on malformed comment (no Retention line), AND a third subtest pinning that the underlying parse Error survives on `.cause`. Tiny inline `pg.Pool`-shaped mock per the test-mock carve-out (clause a — determinism; clause c real-path companion is the (c) integration subtest already in this file against live Postgres).
  - (b) Added a `startRetentionSweepTicker(null)` null-pool smoke test: asserts no throw on null pool input; setInterval is not registered because the early-return fires first.
  - (c) Rewrote the test file header to describe the BootFatalError mechanism (call-stack unwind into `index.ts`'s `.catch` with `instanceof` discrimination → `flushAndExit()`) instead of the obsolete `flushAndExit`-from-inside-the-helper mechanism. The header explicitly notes that the function-level rethrow IS pinned in this file (the new test (d)), and acknowledges the mock-carve-out justification under clause (a) per CLAUDE.md "Running Tests".
- **Item 6 (P2 first-tick gating docblock)** — Added a multi-line `// First-tick gating design (round-3 item 6)` block above the un-awaited `runSweep(pool).catch(...)` call in `startRetentionSweepTicker`. Explains the three reasons the first tick fires un-awaited (backfill semantics + ticker-registration independence + failure containment) and flags the future-shortening risk (sub-24h cadence could permit overlapping runSweep invocations).
- **Item 7 (P3 task-slug citations)** — Dropped the `BACKEND-CUSTODY-AUDIT-RETENTION-SWEEP` slug from the module-header docblock (line 6 in the round-2 file) — the module path itself + the GDPR Art. 5(1)(e) anchor carry the meaning. Dropped the slug from the throw message in `parseRetentionMonthsFromComment` (line 76 in the round-2 file) — the function description + the migration filename already pin the context.

**Verification gates run.**
- `npm run lint`: clean (only pre-existing `seed-phrase.ts` warnings, unrelated).
- `npm run typecheck`: clean (zero errors on `src/`).
- `npm run typecheck:tests`: 242 errors, identical to baseline pre-edit (verified via `git stash + typecheck:tests` reflecting 242). All 242 are pre-existing CommonJS-top-level-await flags across unrelated test files; the new test additions in `backend/tests/jobs/custody-audit-retention-sweep.test.ts` introduce zero new errors.
- Tests not run in worktree per fan-out protocol; parent serializes after merge.

---

## Architect re-review (2026-05-17, round-3 → round-4) — HELD PENDING FIXES

`/ce-code-review` on commit 0cafb3a (5 reviewers). All 7 round-2 hold items land in INTENT. However, round-3 ITSELF introduced new violations of the conventions items 4 and 7 were addressing — the "convention-enforcing fix must audit its own new code" pattern (commit 717f990). Four items held.

### Items held (must fix before archive)

**1. (P2, conf 100, maintainability M1) Item 7 incomplete — round-3 introduced 2 NEW task-slug citations.** Round-3 dropped slugs from the module-header and parseRetentionMonthsFromComment throw, but its own new comments re-introduced the pattern:
- `backend/src/startup-checks.ts:277` — new BootFatalError docblock opens with `BACKEND-CUSTODY-AUDIT-RETENTION-SWEEP round-3 item 3:`.
- `backend/src/index.ts:171` — new `.catch` block comment opens with `BootFatalError discrimination (BACKEND-CUSTODY-AUDIT-RETENTION-SWEEP round-3 item 1):`.

Suggested fix:
- `startup-checks.ts:277-284`: replace with behavioral prose. E.g., "Accepts `ErrorOptions` so re-throw sites can pass `{cause: err}` to preserve the underlying error chain (ES2022 native; pino's err serializer walks `.cause` recursively)."
- `index.ts:171-172`: replace with `BootFatalError discrimination:`.

**2. (P3, conf 85, maintainability M2 + correctness corr-1 cross) Item 4 incomplete — NEW line-number anchor at `backend/src/index.ts:175`.** The `.catch` comment says "The sync top-level catch in `index.ts` (lines 80-85) already discriminates this class". Same convention `docblock-anchor-stable-symbols-not-line-numbers-2026-05-15.md` item 4 was fixing.

Suggested fix: replace `(lines 80-85)` with "The synchronous top-level try/catch wrapping `validateConfig()` / `createApp()`".

**3. (P3, conf 70, correctness corr-2) The "mirror that pattern" claim at `index.ts:175` misleads** — sync and async catch paths diverge on logging behavior. Sync pre-logs validateConfig context; async logs the BootFatalError message.

Suggested fix: replace "mirror that pattern" with "discriminate on `instanceof BootFatalError` to log the error's own message rather than the generic 'Failed to initialize app database' label".

**4. (P3, conf 90, testing T1 + correctness corr-3) Item 5(b) null-pool smoke test under-asserts.** `backend/tests/jobs/custody-audit-retention-sweep.test.ts:170` asserts only `not.toThrow()`. Advertised contract is "no setInterval registered". A mutation moving `if (!pool) return` past setInterval would survive (setInterval doesn't throw).

Suggested fix: add `vi.spyOn(global, 'setInterval')` before the call, assert `expect(setInterval).not.toHaveBeenCalled()`, then restore.

### Items dismissed during architect triage

None below the actionable bar.

### Re-review signal

When items 1-4 land, `git mv` this file back to `tasks/review/`. All four items can land in a single focused commit; fix shape is byte-trivial at each site.

---

## Backend re-review signal (2026-05-17, round-4 fix commit)

Round-3 hold items 1-4 landed in a single focused commit across `backend/src/startup-checks.ts`, `backend/src/index.ts`, and `backend/tests/jobs/custody-audit-retention-sweep.test.ts`.

- **Item 1 (P2 task-slug citations introduced by round-3)** — Two sites cleaned:
  - `backend/src/startup-checks.ts` BootFatalError docblock: replaced the opening "BACKEND-CUSTODY-AUDIT-RETENTION-SWEEP round-3 item 3:" with behavioral prose explaining the `ErrorOptions` rationale (ES2022 `.cause`, pino's err serializer walks it recursively). The closing note about other boot-fatal sites being a separate refactor is retained without the slug reference.
  - `backend/src/index.ts` `.catch` block comment: replaced the opening "BootFatalError discrimination (BACKEND-CUSTODY-AUDIT-RETENTION-SWEEP round-3 item 1):" with the bare "BootFatalError discrimination:" label.
- **Item 2 (P3 line-number anchor `(lines 80-85)`)** — Replaced with "The synchronous top-level try/catch wrapping `validateConfig()` / `createApp()`" per convention `docblock-anchor-stable-symbols-not-line-numbers-2026-05-15.md`. Same edit chunk as item 3 (adjacent prose).
- **Item 3 (P3 "mirror that pattern" misleading parity claim)** — Replaced "mirror that pattern here" with "discriminate on `instanceof BootFatalError` here too so the async path's fatal log carries the BootFatalError's own message rather than the generic 'Failed to initialize app database' label". Names the actual behavior rather than implying byte-equivalent symmetry with the sync catch (which the architect's hold note flagged as misleading because sync pre-logs validateConfig context).
- **Item 4 (P3 null-pool smoke test under-asserts)** — `backend/tests/jobs/custody-audit-retention-sweep.test.ts` null-pool subtest now wraps the call in a `vi.spyOn(global, 'setInterval')` + `try { ... expect(setInterval).not.toHaveBeenCalled(); } finally { setIntervalSpy.mockRestore(); }`. A mutation moving the `if (!pool) return` early-return past `setInterval` registration would now fail the assertion. `mockRestore()` lives in `finally` so the global spy is cleaned up even if the inner expectations throw.

**Verification gates run.**
- `npm run lint`: clean.
- `npm run typecheck`: clean (both `typecheck:src` and `typecheck:tests` exit 0).
- `npx vitest run tests/jobs/custody-audit-retention-sweep.test.ts` against real Postgres + Redis: 14/14 pass (1.03s).

