# BACKEND-CUSTODY-AUDIT-USER-AGENT-HASH — hash the User-Agent at insert per GDPR Art. 5(1)(c) data minimization

**Owner:** Backend Agent
**Created:** 2026-05-15 (architect, surfaced by `/ce-code-review` on `backend-custody-audit-pii-annotation` — security SEC-3 P2 anchor 75)
**Priority:** P2 (pre-launch GDPR-readiness item, alongside `backend-custody-audit-retention-sweep`)

## Problem

`backend/src/routes/custody.ts:579` stores `req.headers['user-agent']` verbatim into `custody_audit_log.user_agent`. The stated forensic purpose for retaining the User-Agent (per migration 006's column comment) is: correlating UA changes between consent ops to prove session continuity. That purpose is fully satisfied by a one-way hash — "did the UA change between op N and op N+1" answers identically against hashed values. The raw User-Agent can leak OS version, browser version, and in some mobile apps a device identifier or username substring; a DB dump exposing raw UA strings is meaningfully worse than exposing hashes.

GDPR Art. 5(1)(c) (data minimization) requires processing be "limited to what is necessary." Storing raw where a hash suffices is the textbook minimization gap. PEvO's sibling column `session_id` on the same table is already hashed for exactly this reason (see `custody.ts:53-59` for the existing pattern).

## Why now

Pre-launch readiness item. The annotation migration (parent task) made the raw-UA storage explicit and documented; this task brings the code in line with the data-minimization argument that the LIA documentation will inevitably reach. Landing this BEFORE first real-user onboarding avoids the awkward retrofit of hashing existing rows.

## Goal

Hash the User-Agent at the insert site so the column stores a one-way hash instead of the raw header. Apply the same pattern already used for `session_id`.

## Acceptance

1. **Hash applied at insert** at `backend/src/routes/custody.ts:579`. Use SHA-256 via `crypto.createHash('sha256').update(ua).digest('hex')` (or HMAC-SHA-256 with a site-specific key if the LIA balancing test prefers keyed hashing to defeat rainbow-table attacks on common UA strings). Match the existing `session_id` hashing pattern from `custody.ts:53-59`.

2. **NULL handling unchanged**: non-consent broadcasts continue to write NULL into `user_agent` (no hash of an absent value); empty-string or non-string `req.headers['user-agent']` also writes NULL. The narrowing at line 579 must guard against non-string values (header arrays from crafted requests).

3. **Migration update**: amend migration 006's `COMMENT ON COLUMN` text to reflect that the column stores a hash, not a raw header. Either edit 006 in place (idempotency promise allows this) or write migration 007 with the corrected comment. Implementer's call; if 007, sequence per existing migration numbering.

4. **Test coverage**: real-DB integration test asserting (a) UA hashed correctly on consent-op success, (b) NULL written for non-consent broadcasts, (c) NULL written for non-string `User-Agent` headers, (d) identical UAs produce identical hashes (correlation-across-ops invariant), (e) different UAs produce different hashes.

5. **No retroactive hashing of existing rows**: if any real-user rows exist by the time this lands, they are NOT migrated — the column will hold a mix of raw-PII rows (pre-task) and hashed rows (post-task). The retention sweep (`backend-custody-audit-retention-sweep`) ages the raw rows out over 24 months. This is the standard pattern for PII reductions; backfilling would itself require a one-off data migration that's its own compliance reasoning.

## Coordination

- **Depends on parent task `backend-custody-audit-pii-annotation` archiving first** so the migration 006 comment update is sequenced cleanly. Backend can pick this up as soon as the parent's round-2 hold-block fixes land and the architect archives it.
- **Companion GDPR work**: `backend-custody-audit-retention-sweep` (also pre-launch). Both should land before real-user onboarding.
- **LIA documentation** lands in architect-zone (`agents/docs/api-contracts/custody.md`) when parent task archives. Once the LIA's balancing test is documented, this task's "hash suffices" argument is the operative compliance claim; if the LIA somehow defends raw UA as necessary (operator argues some forensic case that hash-equality can't satisfy), this task is dismissable. Default assumption: LIA concludes hash suffices.

## Out of scope

- Hashing other request-context fields (referrer, IP, etc.). PEvO doesn't currently log those to DB; if any are added later, this task's pattern applies.
- Logging-side User-Agent appearance. Verified at parent-task review: pino-http request serializer (`backend/src/logger.ts:476-483`) explicitly excludes the User-Agent header from log streams. The DB column is the sole persistent PII surface today.

## Source

- Parent task: `backend-custody-audit-pii-annotation`.
- `/ce-code-review` security SEC-3 (P2 anchor 75, 2026-05-15). Triaged at architect session 2026-05-15.

## Cross-references

- `backend/src/routes/custody.ts:53-59` — existing `session_id` SHA-256 hashing pattern; the canonical shape to mirror.
- `backend/src/routes/custody.ts:579` — current raw-UA insert site.
- `backend/migrations/006_custody_audit_pii_annotation.sql` — column comment to amend.
- Sibling pre-launch GDPR work: `backend-custody-audit-retention-sweep.md`.

---

## [BLOCKED by Architect] (backend startup triage 2026-05-15)

This task is blocked on the architect archiving its parent (`backend-custody-audit-pii-annotation`). Per the Coordination section above and the parent task file: "Depends on parent task `backend-custody-audit-pii-annotation` archiving first so the migration 006 comment update is sequenced cleanly. Backend can pick this up as soon as the parent's round-2 hold-block fixes land and the architect archives it."

The parent task is currently in `tasks/pending/` carrying a round-2 architect hold-block (three line-number / symbol-anchor fixes on the migration 006 comments). Backend's round-2 fix commit + the architect's re-review and archive must both complete before this task's Acceptance #3 ("amend migration 006's `COMMENT ON COLUMN` text to reflect that the column stores a hash") can proceed without conflicting on migration 006's comment block.

What backend needs from architect to unblock:
- Re-review and archive `backend-custody-audit-pii-annotation` after backend's round-2 fix commit lands.

Once the parent archives, architect (or backend at next startup) moves this file back to `tasks/pending/` for normal pickup.

**Unblocked 2026-05-18 (architect at `070ef5af`).** Parent task `backend-custody-audit-pii-annotation` archived; this task moved back to `tasks/pending/` for backend pickup. Backend implementation landed at commit `60b9093b` and the file was moved to `tasks/review/` without an explicit signal block — implementation details captured in the commit message.

---

## Architect re-review (2026-05-21, round-1 → round-2) — HELD PENDING FIXES

`/ce-code-review` on commit `60b9093b` (9 reviewers — correctness, security, adversarial on opus; testing, maintainability, project-standards, data-migrations, kieran-typescript on sonnet; learnings-researcher unstructured; `ce-agent-native-reviewer` skipped per project CLAUDE.md). Helper `hashUserAgentForAudit(value: unknown)` lands as a sibling of `bearerSessionId` with correct narrowing (`typeof !== 'string' || length === 0 → undefined`). Insert-site swap preserves NULL semantics for non-consent broadcasts (auditExtras constructor is unreachable on that path). Migration 006 in-place edit is COMMENT-only (verified: no row-mutating SQL, no DDL beyond `COMMENT ON COLUMN`); `deploy.sh migrate_db` unconditional re-apply is idempotent against `COMMENT ON COLUMN`. Retention sweep's regex still parses the updated COMMENT body. Pinned-digest mutation-kill is tight (`f166f6db…` verifies against `SHA-256('PEvO-Test/1.0')`).

Two items held. Both are one-line edits on rot-class anchors that the convention `convention-enforcing-fix-must-audit-its-own-new-code-2026-05-17.md` warns against — the parent task's round-3 hold-block specifically purged the same rot class on the same migration file, and this child task reintroduced one instance on the same migration and one on the new test file.

### Items held (must fix before archive)

**1. (P1, conf 90, maintainability M1) Migration 006 preamble carries a "see the task file" task-slug-citation pointer that rots on archive.** The migration preamble edited by this commit contains the line `"…tracked as a follow-up TODO inside the task file."` Per `agents/docs/solutions/conventions/task-slug-citations-in-comments-go-stale-on-archive-2026-05-15.md`: "the task file" is a dead pointer the moment this task archives (`tasks-archive.md` trims from the bottom at 250 lines; older entries fall off entirely). The migration is the long-lived artifact — it survives archive and SHA churn indefinitely.

  Fix: replace `"…tracked as a follow-up TODO inside the task file."` with a stable behavioral anchor. The sibling retention-sweep job exists at `backend/src/jobs/custody-audit-retention-sweep.ts` and is the natural cross-reference. Suggested rewrite: `"…tracked as a follow-up TODO for the custody-audit retention-sweep job (backend/src/jobs/custody-audit-retention-sweep.ts), which ages pre-hash rows out under the 24-month retention window."` Or any equivalent that names a stable symbol instead of "the task file."

  Per `convention-enforcing-fix-must-audit-its-own-new-code-2026-05-17.md`, the replacement must not violate any of the anchor-hygiene rules — verify the new text uses a file path + symbol name (stable), not a task slug (rots) or line number (drifts).

**2. (P1, conf 80, kieran-typescript KT-1) Non-null assertion in `custody-user-agent-hash.test.ts` bypasses the `string | undefined` return type of the helper under test.** In the distinct-input invariance check, `inputs.map((ua) => hashUserAgentForAudit(ua)!)` strips `undefined` from `string | undefined` and pushes the result into a `Set`. All inputs are non-empty strings today so the assertion holds, but the `!` is a type-narrowing bypass on the test whose explicit purpose is to mutation-kill changes to the helper's return shape. If the predicate ever tightens (e.g., adds a length cap that returns `undefined` for long UAs), the `!` silently coerces `undefined` into the Set, the size check passes, and the regression false-greens.

  Fix: replace `!` with a guarded form that keeps the type checker engaged. Two acceptable shapes — implementer's call:
  - `const h = hashUserAgentForAudit(ua); if (h === undefined) throw new Error(\`unexpected undefined for input: ${JSON.stringify(ua)}\`); return h;` (loud failure on regression)
  - `expect(h).toBeDefined()` before pushing into the Set (test failure on regression)

  Either form converts "future undefined" into a loud test failure rather than a false-green. The fix is one line.

### Items dismissed during architect triage

- **(P2, conf 85, testing T1)** No integration assertion that non-consent broadcasts write NULL to `custody_audit_log.user_agent` (task acceptance (b)). Structural defense IS in place — the `auditExtras` constructor is unreachable on the non-consent code path (verified by correctness reviewer trace). Missing test is preemptive coverage of a "future refactor extends auditExtras to non-consent path" scenario. Dismissed per `feedback_dismiss_preemptive_test_hardening`. Documented residual.
- **(P2, conf 80, adversarial adv-2)** Empty-string `User-Agent` is hashed to `undefined → NULL`, conflating with both "absent header" and "non-broadcast event" on the forensic detection axis. Wire-driveable (single `curl -H "User-Agent: "` from a JWT holder) — an attacker can spray empty-UA consent broadcasts to defeat continuity-change detection queries that key on "count DISTINCT user_agent per username." Bounded by PEvO single-instance beta scale and the absence of any live continuity-detection query today; if such a query is built later, the empty-UA-collapse residual should be revisited (the cheapest fix is to hash empty string to the canonical SHA-256-of-empty sentinel `e3b0c442…` which globally distinguishes empty-UA broadcasts from absent/non-broadcast NULLs). Documented residual; not held.
- Below-anchor and other low-confidence findings (cross-deployment rainbow-table on AGPL forks, mixed raw/hashed forensic transition window during the 24-month retention period, dead non-string-header branch unreachable via Node's HTTP parser) suppressed by the anchor-75 gate per skill default.

### Re-review signal

When items 1 and 2 land, `git mv` this file back to `tasks/review/`. Round-2 architect review scopes `/ce-code-review` to the round-2 commit only.

Both items are one-line edits in two different files (`backend/migrations/006_custody_audit_pii_annotation.sql` and `backend/tests/routes/custody-user-agent-hash.test.ts`). Single focused commit expected.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
