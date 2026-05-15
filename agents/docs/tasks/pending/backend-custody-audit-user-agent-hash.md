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
