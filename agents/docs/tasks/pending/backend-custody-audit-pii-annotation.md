# BACKEND-CUSTODY-AUDIT-PII-ANNOTATION — annotate user_agent column as PII; document retention + deletion path

**Owner:** Backend Agent
**Created:** 2026-05-05 (architect, surfaced by `/ce-code-review` on `backend-coauthor-trust-model` rounds 1+3)
**Priority:** P2

## Problem

Migration `005_custody_audit_consent_ops.sql` (commit `b9b3b3b`, round 3 of `backend-coauthor-trust-model`) added a `user_agent` column to `custody_audit_log`. The column stores the raw HTTP `User-Agent` header per `routes/custody.ts:282-289`, which can carry OS version, browser version, and in some mobile apps a username or device ID — data that constitutes personal data under GDPR / CNPD.

PEvO operates under Portuguese jurisdiction (CNPD). The project already hashes emails before writing to pino logs (`lib/log-pii.ts`, `routes/auth.ts:919`). The `user_agent` column is the first DB-persisted PII column added since the jurisdiction was set, and the migration does not document its PII status, retention period, or scrubbing policy.

## What's already correct

- The account-deletion sweep at `backend/src/routes/settings.ts:312` (`DELETE FROM custody_audit_log WHERE username = $1`) covers GDPR right-to-erasure for these rows. No new code path needed.
- The column is nullable; non-consent broadcasts write NULL (no PII for non-consent flows).

## What's missing

- A `COMMENT ON COLUMN custody_audit_log.user_agent IS '...'` annotation documenting the PII status, the legal basis (legitimate interest in security audit), the retention policy, and the deletion path.
- An ARCHITECTURE.md or `agents/docs/api-contracts/custody.md` operator note pointing at the audit-log retention policy. PEvO does not currently have a documented retention period for `custody_audit_log`; this task should either pick one (e.g., 24 months for security audits) or hand off to the architect to choose.

## Acceptance

- New migration `006_custody_audit_pii_annotation.sql` (or whatever the next number is) adding `COMMENT ON COLUMN` for `user_agent` with the PII annotation.
- Inline note in the migration referencing the deletion path at `routes/settings.ts:312`.
- A retention policy decision: either picked here (with rationale) or escalated to the architect via `[TODO Architect]` marker in the migration file.
- If a retention policy is picked, a follow-up task to implement the periodic cleanup job (out of scope for this task).

## Out of scope

- Scrubbing other audit columns (`session_id` is already a one-way SHA-256 hash; `tx_id` and `block_num` are public on-chain).
- Implementing a periodic retention sweep — that's a follow-up if the retention policy is set.
- Other tables with potential PII columns — file separately if found.

## Source

`/ce-code-review` (rounds 1+3) on 2026-05-05: data-migrations reviewer (P2, conf 50). Surfaced as a CNPD jurisdiction concern; the deletion path is already in place, the documentation gap is the actionable item.

## Implementation note (2026-05-06, backend)

Landed `backend/migrations/006_custody_audit_pii_annotation.sql` adding the `COMMENT ON COLUMN custody_audit_log.user_agent` annotation. SQL parsed cleanly against the dev `pevo_app` Postgres in a rolled-back transaction; comment is readable via `col_description('custody_audit_log'::regclass, attnum)`. `COMMENT ON COLUMN` is unconditional, so the migration is idempotent.

**Retention decision: 24 months from row insert.** Rationale documented inline in the migration's SQL comment block — industry-standard for security-event log retention, long enough for post-incident forensics beyond a typical breach-discovery window, short enough to honor GDPR data-minimization (Art. 5(1)(c)/(e)). Legal basis for keeping the column at all is legitimate interest in security audit (GDPR Art. 6(1)(f)).

**No periodic cleanup job in this task — see follow-up TODO below.**

[TODO Architect] The migration's SQL comment now carries the operator-facing retention + deletion semantics, but PEvO's integrator-facing surface does not yet document either. Two contract additions are needed; both are out of scope for the backend role's zone (api-contracts/* and ARCHITECTURE.md are architect-owned):

1. **`agents/docs/api-contracts/custody.md`** — add an "Audit log retention" subsection under the consent-ops broadcast surface, stating: "Successful `author_accept` / `author_resign` broadcasts are recorded in `custody_audit_log` with the auth mechanism, hashed session id, and raw `User-Agent` header. Rows are retained for 24 months from insert (security-audit retention, GDPR Art. 6(1)(f) legitimate interest, CNPD jurisdiction). Rows are erased immediately on account deletion via the settings.ts:312 sweep (GDPR Art. 17 right-to-erasure). The `User-Agent` field is the only persisted PII column on this surface; `session_id` is a one-way SHA-256 hash, `tx_id`/`block_num` are public on-chain references." Avoid the emdash in the user-facing copy.
2. **`agents/docs/ARCHITECTURE.md`** — under the "Light-account signing of consent ops" section (or wherever the audit-log surface is referenced), add a one-line cross-reference: "Audit-log retention is 24 months for consent-op rows; PII annotation is documented inline at `backend/migrations/006_custody_audit_pii_annotation.sql`. Right-to-erasure path is `backend/src/routes/settings.ts:312`."

These additions complete the documentation chain (DB column → contract → ARCH) so a future operator or fork-maintainer reading any of the three lands on the same retention number.

## Follow-up TODO (out of scope, file separately)

- **`backend-custody-audit-retention-sweep`**: implement a periodic job that drops `custody_audit_log` rows where `created_at < now() - interval '24 months'`. Decisions deferred to that task: cron vs. on-demand trigger, batch size, whether to scrub PII columns in-place before deletion (probably unnecessary — full-row delete satisfies GDPR), and whether to emit a pino summary line for ops visibility. The retention number lives in the SQL comment on `custody_audit_log.user_agent` (see migration 006); the sweep should reference that as the authority rather than hard-coding 24 months in two places.

---

## Architect re-review (2026-05-15) — HELD PENDING FIXES

`/ce-code-review` on commit `fdca2eb` (8 reviewers: correctness on Opus; testing, maintainability, project-standards, data-migrations, security, schema-drift-detector, learnings-researcher on Sonnet; `ce-agent-native-reviewer` skipped per project CLAUDE.md). User-triaged session 2026-05-15. Three items held; six items routed to separate follow-up work and not re-reviewed here.

### Items held (must fix before archive)

1. **Wrong line number for `settings.ts` deletion path** — file `backend/migrations/006_custody_audit_pii_annotation.sql`. The migration's SQL header comment AND the `COMMENT ON COLUMN` string both cite `settings.ts:312` as the right-to-erasure DELETE sweep (4 occurrences: lines 24-29, 44-45, 65, 85). Actual line is **338**. Line 312 is `const row = rows[0];` — unrelated row read. Cross-corroborated by correctness + maintainability (both conf 100). Operationally load-bearing for GDPR audit: a CNPD inspector reading `\d+ custody_audit_log` follows this breadcrumb. Suggested shape: prefer symbol-anchored reference ("the account-deletion sweep that runs `DELETE FROM custody_audit_log` inside the account-deletion transaction") over a bare line-number update — same lesson as the `BE-P3-CLEANUP-SWEEP` round-2 M-01 fix.

2. **Wrong line number for `custody.ts` insert path** — same migration file. Both header comment and `COMMENT ON COLUMN` string cite `custody.ts:282-289` as the `user_agent` insert path (4 occurrences: lines 34-37, 46-47, 74, 87). Actual line is **573-580**, specifically `user_agent:` at 579. Lines 282-289 are the `multiple_consent_ops_rejected` pino log block — a rejection path, not the insert path. Cross-corroborated by correctness + maintainability (both conf 100). Same fix shape recommendation as item 1: prefer symbol-anchored ("the fresh-auth-answered consent-op insert at `custody.ts`'s `logBroadcastAttempt` audit-extras") over a bare line-number update.

3. **Coupling claim "Populated only on consent-op broadcasts" anchored to route-level branching** — same migration file's closing comment paragraph (the `Insert path reference:` sentence). The "only when a fresh-auth challenge was answered" claim is currently correct (gated by `freshAuthMechanism === null` discriminator at `custody.ts:573`) but couples the column-level GDPR documentation to a route-level branching invariant. A future change setting `freshAuthMechanism` outside the consent branch would silently invalidate the doc claim. Surfaced by correctness conf 75. Suggested rewrite: anchor on the WHAT-triggers-population invariant ("populated only when a fresh-auth challenge has been answered for the broadcast — i.e., the consent-op signing flow; other broadcasts write NULL") rather than the WHERE-the-branch-lives shape. Removes the file:line coupling. Same shape lesson as items 1+2 (the cross-references should anchor on stable conceptual invariants, not on rotted line ranges or branch-location coupling).

### Recommended approach

The migration's own "Idempotent: `COMMENT ON COLUMN` is unconditional and overwrites any prior comment on the same column, so re-applying this migration is safe" framing allows editing migration 006 in place rather than writing migration 007 with the corrected comment. Implementer's call. If edited in place, the SQL-comment-block ABOVE the `COMMENT ON COLUMN` statement should also be rewritten consistently (it's read by anyone running the migration via `./deploy.sh migrate`).

### Dismissed at triage (recorded for transparency)

- **`COMMENT ON COLUMN` emdash applicability** (project-standards RR-1, conf 50) — no live violation; definitional gap only.
- **No automated test for the column comment surviving migration replay** (data-migrations TG-1, conf low) — preemptive test hardening per memory `feedback_dismiss_preemptive_test_hardening`.

### Routed to separate follow-up work (not held; not re-reviewed here)

- **Retention enforcement** (security SEC-1 P1 + data-migrations RR-1 P2, cross-corroborated) — filed as `backend-custody-audit-retention-sweep.md` in `tasks/pending/` with PRE-LAUNCH BLOCKER priority. Pre-launch readiness item; tracked separately so this annotation task can archive cleanly after the held fixes land.
- **LIA documentation** (security SEC-2 P2) — bundled into the existing `[TODO Architect]` block at `agents/docs/api-contracts/custody.md`. Architect lands during the convention-doc/contract pass when this task archives.
- **User-Agent hashing for Art. 5(1)(c) data minimization** (security SEC-3 P2) — filed as `backend-custody-audit-user-agent-hash.md` in `tasks/pending/`. Pre-launch GDPR-readiness companion to the retention sweep.
- **GDPR Art. 15 data-export endpoint** (security SEC-4 P2) — DISMISSED at triage as out of scope for this review (future PM/launch decision).

When all three held items land, `git mv` this file back to `tasks/review/` for re-review and archive.

## Backend re-review signal (2026-05-15, commit SHA `62fd447`)

All three held items landed via in-place edit of `backend/migrations/006_custody_audit_pii_annotation.sql` (migration is idempotent per its own header; no migration 007 needed).

**Item 1 (settings.ts:312 -> symbol-anchored).** Replaced both occurrences (header comment block lines 24-29, COMMENT ON COLUMN string) with: "the account-deletion sweep inside the `DELETE /api/settings/email` handler in `backend/src/routes/settings.ts` runs `DELETE FROM custody_audit_log WHERE username = $1` inside the same transaction that drops the account row". Anchor is the HTTP verb + route + file, not a line number. Verified `settings.ts` line 338 currently holds the DELETE inside the `router.delete('/email', ...)` handler; the anchored reference survives further drift because the handler symbol is stable.

**Item 2 (custody.ts:282-289 -> symbol-anchored).** Replaced both occurrences (header comment block lines 34-40, COMMENT ON COLUMN string trailing sentence) with: "the success-path `auditExtras` constructor inside the `POST /api/custody/broadcast` handler in `backend/src/routes/custody.ts` ... populates `user_agent` from `req.headers['user-agent']` and passes it to `logCustodyBroadcast`". Anchor is the constructor + handler + helper, not a line number. Verified `custody.ts` line 579 currently holds `user_agent:` inside the `auditExtras` constructor at the success path of `router.post('/broadcast', ...)`.

**Item 3 (coupling claim rewrite).** Closing comment-block paragraph + COMMENT ON COLUMN trailing sentence rewritten from "Populated only on consent-op broadcasts (author_accept / author_resign); NULL for all other custody-broadcast rows" to "Populated only when a fresh-auth challenge has been answered for the broadcast, i.e., the consent-op signing flow (author_accept / author_resign); other broadcasts write NULL". Anchor is now the WHAT-triggers-population invariant (a fresh-auth challenge was answered) rather than the WHERE-the-branch-lives shape (the `freshAuthMechanism === null` discriminator call site). No emdashes in the new text; ", i.e., " used where the prior intent was an elaboration.

**Verification gates run.**
- `cd backend && npx tsc --noEmit`: clean (no unrelated regressions; migrations are SQL so no direct typecheck coverage, run as sanity).
- `./deploy.sh migrate` applied 006 to live dev DB; `SELECT col_description('custody_audit_log'::regclass, attnum) FROM pg_attribute WHERE attrelid = 'custody_audit_log'::regclass AND attname = 'user_agent';` returns the new comment text cleanly.
- `grep -nE 'settings\.ts:|custody\.ts:' backend/migrations/006_custody_audit_pii_annotation.sql` returns no matches: every line-number citation in the migration is gone, replaced by symbol-anchored references.

---

## Architect re-review (2026-05-16, round-2 → round-3) — HELD PENDING FIXES

`/ce-code-review` ran on commit `62fd447` (round-2 symbol-anchor fix). All three held items land cleanly (settings.ts symbol anchor verified at the `DELETE /api/settings/email` handler; custody.ts symbol anchor verified at the success-path `auditExtras` constructor inside `POST /api/custody/broadcast`; coupling claim rewritten from route-branch shape to fresh-auth-answered invariant).

However: a cross-task interaction surfaced via the parallel review of `backend-custody-broadcast-orcid-fresh-auth` round-1 (commit `84602f8`, landed before this review). That task extended fresh-auth to non-consent broadcasts, which changed the underlying invariant the round-2 rewrite anchored on. The migration's new wording is now factually stale.

### Item to address

**1. (P1, conf 100) The "i.e., the consent-op signing flow (author_accept / author_resign); other broadcasts write NULL" parenthetical and trailer are factually wrong at HEAD.** `backend/migrations/006_custody_audit_pii_annotation.sql` — both the SQL header comment block (lines ~34-40) and the `COMMENT ON COLUMN` body (lines ~50-54). After commit `84602f8` landed, the non-consent broadcast path at `backend/src/routes/custody.ts:373-400` also sets `freshAuthMechanism = result.mechanism` (line 399) via `consumeSessionFreshAuthToken`. So the `auditExtras` gate at line 614 (`freshAuthMechanism === null ? undefined : {...}`) is now reached on BOTH consent and non-consent broadcasts that pass fresh-auth — `user_agent` populates for non-consent broadcasts too (votes, comments, custom_json).

The round-2 hold #3 anchored the doc on "a fresh-auth challenge has been answered" (correct WHAT), but then narrowed it parenthetically to "i.e., the consent-op signing flow" (wrong scope). The architect's own hold-block warning ("A future change setting `freshAuthMechanism` outside the consent branch would silently invalidate the doc claim") materialized faster than expected — the parallel task 4 implementation landed before this task's annotation was re-validated.

GDPR/CNPD audit-trail impact: a CNPD inspector reading `\d+ custody_audit_log` would believe `user_agent` is consent-op-only, but in fact it covers all fresh-auth-answered broadcasts. The 24-month retention policy and Art. 6(1)(f) legitimate-interest basis apply to a broader rowset than documented.

Suggested fix: drop the `i.e., the consent-op signing flow (author_accept / author_resign)` parenthetical entirely; rewrite the trailer. New wording:

```
Populated whenever a fresh-auth challenge has been answered for the broadcast,
i.e., the consent-op signing flow (author_accept / author_resign) OR any
non-consent broadcast (vote, comment, custom_json) that submits a session-kind
or consent_op-kind fresh-auth proof. Broadcasts that do not answer a fresh-auth
challenge (none exist at HEAD — every /api/custody/broadcast call now requires
fresh-auth) would write NULL.
```

Or, more compactly:

```
Populated whenever a fresh-auth challenge has been answered for the broadcast.
At HEAD every /api/custody/broadcast call requires a fresh-auth proof
(see backend-custody-broadcast-orcid-fresh-auth), so this column is populated
on every successful broadcast row.
```

Apply the rewrite to both occurrences (SQL header block + `COMMENT ON COLUMN` string). The migration's idempotency claim still holds — in-place edit is appropriate; no migration 007 needed.

### Items dismissed during architect triage

- Maintainability "transactional-coupling assertion in DB string" residual (conf 50): the inline COMMENT string asserting "in the same transaction that drops the account row" is technically coupled to the route implementation but the assertion is durable (transactional behavior is a load-bearing GDPR property; a refactor that breaks it is a regression that should be caught at code review, not via DB-comment drift detection). Below the gate.

### Re-review signal

When item 1 lands, `git mv` this file back to `tasks/review/`. Round-3 architect review scopes `/ce-code-review` to the round-3 commit.
