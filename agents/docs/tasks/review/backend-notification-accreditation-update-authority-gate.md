# BACKEND-NOTIFICATION-ACCREDITATION-UPDATE-AUTHORITY-GATE — authority-gate the accreditation_update notification feed

**Owner:** backend
**Created:** 2026-05-26 (backend, surfaced by the exhaustive call-site audit in `backend-claimer-orcids-accreditation-authority-gate`; user triaged to fix)
**Priority:** P2 (notification-integrity hygiene; nuisance spoof, no trust grant)

## Problem

The `accreditation_update` arm of the notifications feed (`fetchNotificationsFromHaf` in `backend/src/notification-queries.ts`) read `accredit`/`revoke` custom_json ops filtered only on `custom_id`, `account = $1`, `action`, and `block_num` — with **no `required_posting_auths` authority-signer gate**, unlike every trust read of accredit/revoke ops (`activeAccreditationsCteBody`, the per-account accreditation reads in `accreditations.ts` / `profile.ts` / `idempotency.ts`, and the reputation cycle's ORCID auto-accept source).

Consequence: anyone could self-broadcast a `custom_json { id: <appTag>, json: { action: 'accredit'|'revoke', account: <victim> } }` signed with their own posting key and push a spurious `accreditation_update` notification to the victim. No trust is granted (the victim's actual accreditation status is computed via the gated `active_accreditations`), so this is a nuisance-spam vector, not a privilege escalation — hence P2.

## Fix (landed)

Added the same authority gate the trust reads use to the `accreditation_update` arm:

```sql
AND cj.required_posting_auths ?| ${authoritiesParam}::text[]
```

The accreditation authorities array was **already bound** as the second param of `activeAccreditationsCteBody(4)` (the query already composes that CTE for arms 1b/2a/2b), so no new param was added — the arm reuses the in-scope authorities placeholder (`accredCte.nextIdx - 1`). Only authority-signed accredit/revoke ops now generate a notification. The vouch arm (arm 4) is intentionally left ungated: vouches are peer web-of-trust ops, not authority-signed.

## Test (landed)

`tests/routes/notifications-arm-sql-shape.test.ts` — new SQL-shape canary that isolates the `accreditation_update` arm (from its event-type tag to the next arm's `'new_vouch'` tag) and asserts it contains `required_posting_auths ?|`. The isolation is necessary because `required_posting_auths ?|` also appears in the `accred_ranked` CTE, so a bare substring check would pass even after a revert of this arm's gate. Mutation-kill: dropping the gate from the arm fails the canary. Real-corpus seeding of a forged self-signed op is impractical (can't insert into the HAF chain mirror), the same carve-out rationale the file's other arm canaries already document; the `?|` filtering behavior itself is proven behaviorally against real Postgres by the reputation authority-gate test and the `hafsql.test.ts` retraction-gate test.

## Verification

`npm run typecheck` (src + tests) clean; `npm run lint` clean on touched files (pre-existing `any` warnings at the hoisted mock factory unchanged). `notifications-arm-sql-shape.test.ts` (4 canaries incl. the new one) + `notification-queries-lateral-guard-canary.test.ts` (real-HAF, confirms the modified query still executes) green.

**Self-audit on added lines:** no task-slug citations, round-N markers, line-number anchors, SHA refs, date anchors, or relative positional anchors in production/test source. Comments anchor on stable symbols (`accred_ranked`, `activeAccreditationsCteBody`, `required_posting_auths`, the `accreditation_update` arm).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
