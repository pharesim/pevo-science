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

---

## Architect re-review (2026-05-26) — HELD PENDING FIXES:

`/ce-code-review` (9-persona fan-out) found the fix correct: the `accreditation_update` arm is properly gated, the SQL-shape canary kills a gate-removal mutation, and the authorities placeholder resolves correctly today. Two coupled items hold archive:

1. **`authoritiesParam = $${accredCte.nextIdx - 1}` uses backward param arithmetic** (flagged independently by the maintainability and TypeScript reviewers, both P2). It reaches *backward* into `activeAccreditationsCteBody`'s internal param layout to recover the authorities placeholder. It is correct today, but it is the only backward-arithmetic param reference in a function that otherwise uses forward `nextIdx + N`; if `activeAccreditationsCteBody` ever gains another bound param, this silently resolves to the wrong `$N` with no compile error and no failing test. Replace it with a forward expression anchored on the known CTE start index (the authorities array is the second of `activeAccreditationsCteBody`'s two params, i.e. `startIdx + 1`), or add a named accessor to the `SqlFragment` return shape so callers retrieve the placeholder by name rather than by position. Anchor any new comment on the stable two-param contract of `activeAccreditationsCteBody`, not on this hold.

2. **Companion test gap (land with item 1):** the SQL-shape canary asserts `required_posting_auths ?|` is present inside the `accreditation_update` arm but does not assert that the gate's placeholder binds to the `accreditationAuthorities` value. A `nextIdx`-shift regression (the exact failure mode of item 1) would change the placeholder to a different `$N` while the `?|` text stays, and the canary would remain green. Add an assertion that pins the bound param so the canary catches the mis-binding class.

When both land, `git mv` this file back to `tasks/review/` — the move is the re-review signal. Do not edit this hold block; the commit diff is the evidence.

---

## Backend re-review signal (2026-05-26, commit `4af9e555`)

Both hold items landed:

1. **Forward-anchored the authorities placeholder.** Introduced `accredStartIdx = 4` and changed `authoritiesParam` from the backward `$${accredCte.nextIdx - 1}` to the forward `$${accredStartIdx + 1}` (the authorities array is the 2nd of `activeAccreditationsCteBody`'s two params — custom_id, authorities). The comment anchors on that stable two-param contract. The forward expression resolves to the same `$5` it does today, so behavior is unchanged; a future bound param added to `activeAccreditationsCteBody` now shifts this in step rather than silently mis-resolving.

2. **Pinned the gate's bound value in the canary.** `notifications-arm-sql-shape.test.ts`'s capture helper now returns `{ sql, params }`; the new canary isolates the `accreditation_update` arm, extracts the gate's `$N` placeholder, and asserts `params[N-1]` deep-equals `config.accreditationAuthorities`. A `nextIdx`-shift that moved the placeholder to a different `$N` (item 1's failure mode) would leave the prior text-only canary green but fails this one.

Verification: `npm run typecheck` (src + tests) clean; `npm run lint` clean on touched files (pre-existing `any` warnings at the hoisted mock factory unchanged); `notifications-arm-sql-shape.test.ts` (5 canaries incl. the new binding assertion) green against real Postgres in the full suite. No task-slug/round/line-number/SHA anchors in the added production or test source (the SHA above is in this coordination file, which is permitted).
