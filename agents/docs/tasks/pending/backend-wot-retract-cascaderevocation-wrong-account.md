# BACKEND-WOT-RETRACT-CASCADEREVOCATION-WRONG-ACCOUNT — `/api/wot/retract` invokes `cascadeRevocation` with the voucher; the vouchee never gets re-evaluated and unrelated vouchees get cascaded

**Owner:** backend
**Created:** 2026-05-30 (surfaced by HAF-query multi-lens review, rank #6 high severity, correctness)
**Priority:** P0 (retract semantics are broken outright — WoT auto-accreditations that should be revoked silently aren't; unrelated vouchees get cascaded)

## Problem

[routes/wot.ts:124-155](backend/src/routes/wot.ts#L124-L155) calls `cascadeRevocation(voucher)` after a retract, but [wot.ts:270-419](backend/src/wot.ts#L270-L419)'s `cascadeRevocation` is designed for the case where an account's **accreditation** was revoked — not where a single vouch was withdrawn.

Its first query returns the voucher's STILL-ACTIVE vouchees — by definition not the just-retracted vouchee — so the one account that actually lost a vouch is never re-evaluated for WoT-threshold loss. Worse, voucher's other still-vouched accounts get recounted with `av.voucher != $voucher`, potentially triggering unrelated revocations.

Net: WoT auto-accreditations that should be revoked on retract silently aren't; unrelated vouchees get cascaded.

## Goal

Make `/api/wot/retract` correctly re-evaluate the **vouchee** (not the voucher) after the vouch is dropped, while leaving `cascadeRevocation(account)` reserved for actual accreditation revocations.

### Suggested approach

In `/api/wot/retract` (after the on-chain retract broadcasts), replace `cascadeRevocation(voucher)` with a vouchee-targeted check:

1. Invalidate `vouch_status:${vouchee}` in the cache.
2. Call `getVouchStatus(vouchee)`.
3. If `vouches.length < threshold` AND `active_accreditations.method === 'wot'`, broadcast a single `revoke_accreditation` and call `invalidateOnRevocation(vouchee)`.

Keep `cascadeRevocation(account)` reserved for actual accreditation revocations (its current consumers from accreditation-revocation paths are correct).

## Acceptance

- Regression test: retract a vouch that drops the vouchee below threshold; assert the vouchee's WoT accreditation is revoked.
- Regression test: retract a vouch that does NOT drop the vouchee below threshold; assert no revocation broadcasts fire.
- Regression test: voucher's OTHER vouchees (unrelated to the retract) are NOT recounted/cascaded by this code path.
- The vouchee-targeted check is a single SQL query, not the multi-step `cascadeRevocation` loop.
- Comment anchors clean.
- `npm run typecheck` + `npm run lint` clean.

## Notes

- Independent of #5 (vouch signer gate). Land both this week.
- Related: #12 (`backend-wot-cascade-single-discovery-query`) collapses `cascadeRevocation`'s 1+2N query shape. That cleanup is orthogonal — but the `cascadeRevocation` function should stay; only the `/api/wot/retract` caller swaps to the new vouchee-targeted check.

## Cross-references

- [backend/src/routes/wot.ts](backend/src/routes/wot.ts) lines 124-155 (`/api/wot/retract` handler).
- [backend/src/wot.ts](backend/src/wot.ts) lines 270-419 (`cascadeRevocation`, `getVouchStatus`, `invalidateOnRevocation`).
- Existing `cascadeRevocation` consumers from real accreditation-revocation paths (those callers stay).
- HAF-query review run `w274tijk0` rank #6.

## Backend completion note (2026-06-05)

Implemented inline against HEAD (the worktree fan-out forked from a 112-commit-stale base; see session report). Landed in commit `6e1b61b3`.

- `/api/wot/retract` now routes through `revokeVoucheeIfBelowThreshold(vouchee, retractingVoucher)` in `wot.ts`: a single discovery query (no cascade loop) returns the vouchee iff it is currently WoT-accredited (`method = 'wot'`) and, excluding the retracting voucher from its accredited-voucher count, now sits below the threshold. Excluding the voucher in SQL makes the decision independent of whether HAF has ingested the retract_vouch yet (a robustness improvement over a plain post-retract recount, mirroring the exclusion `cascadeRevocation` already does). On a positive result it invalidates the reputation batch entry before broadcasting exactly one revoke. `cascadeRevocation` is untouched and stays reserved for accreditation-revocation paths.
- Tests: `tests/routes/wot-retract-cascaderevocation.test.ts` (8 cases, lib + route layers, 3.3s) pins below/at-threshold, the wrong-account regression (the discovery target resolved from `aa_target.account = $N` is the vouchee, never the voucher), single-discovery-query-not-cascade-loop, DEL-before-broadcast on the timeout path, and the timeout/chain_error outcomes. `wot.test.ts` and `wot-broadcast-timeout.test.ts` stay green. typecheck + lint clean.

[TODO Architect] API contract update required (`agents/docs/api-contracts/accreditation.md`, `POST /api/wot/retract`): the response shape changed. Dropped `partial_cascade` (it was tied to the cascade-budget mechanic, which no longer applies to a single-broadcast path). Added `revocation_outcome` with values `revoked`, `skipped`, `timeout`, `chain_error`. `revocations` is now an array of 0 or 1 tx id (was the cascade's N). Frontend impact verified none: `frontend/src/api.js`'s `notifyRetractVouch` returns the raw response and reads no specific field.

## Architect re-review (2026-06-09) — HELD PENDING FIXES (7 items)

`/ce-code-review` (correctness + security + adversarial on Opus; testing/reliability/performance/api-contract/maintainability/project-standards/kieran-typescript on Sonnet; learnings unstructured; ce-agent-native-reviewer skipped per PEvO) on commit `6e1b61b3`. The core wrong-account fix is verified CORRECT: the discovery query resolves the VOUCHEE (`aa_target.account = $vouchee`, never the voucher), the `av_all.voucher != $voucher` exclusion is HAF-ingestion-independent with no double-subtraction, the cascade-terminal zero-remaining-voucher case is selected via the LEFT JOIN + NULL-skipping `COUNT(DISTINCT ...) FILTER` HAVING, the outcome→switch mapping is exhaustive at runtime, and the invalidate-before-broadcast leak guard holds with a verified self-heal path. But re-evaluating the vouchee is newly reachable, which opens an authorization gap (item 1), and the route's error/response surface needs hardening.

### Items held (must fix before archive)

1. (P1, security + adversarial) **Unverified-retract authorization / griefing.** The handler trusts that the frontend already broadcast `retract_vouch` and the discovery query UNCONDITIONALLY excludes the retracting voucher from the vouchee's accredited-voucher count (`av_all.voucher != $voucher`). An accredited voucher A of an at-threshold vouchee B can POST `/api/wot/retract` with `vouchee = B` while broadcasting NO on-chain retract; the exclusion drops B below threshold and fires an admin revoke. With latest-action-wins accreditation (`accreditation-state-read-latest-action-wins`) the revoke STICKS and B does not self-heal: B's on-chain vouches still stand, so no re-accreditation event fires. REQUIRED property: an unverified or non-existent retraction must not drop a victim below threshold or trigger a revoke. Candidate approaches (implementer's call): verify the `retract_vouch` actually landed on-chain before honoring it (mirror `/vouch`'s `pollForVouch`), OR only exclude the retracting voucher when their active vouch edge to the vouchee is genuinely gone / verified-retracted (note this re-introduces ingestion dependence the unconditional exclusion was avoiding — that tradeoff is the point). ALSO add, for parity with `/vouch`: a signer-accreditation gate (`getAccreditedSet([voucher])` → 403) and a self-target guard (`voucher === vouchee` → 422). Regression tests: a signer who is NOT an accredited voucher of B cannot revoke B; a self-retract is rejected; the legitimate-retract revoke path still works.

2. (P2, reliability + correctness) **`'skipped'` masks a discovery-query failure.** A HAF throw in `revokeVoucheeIfBelowThreshold`'s discovery query is caught and returns `{ outcome: 'skipped' }`, which the route renders as "No revocation needed" — so a needed revocation silently never happens and is not retried (no batch path re-evaluates the retract case). Add a distinct outcome (e.g. `'query_error'`) and a route message / `revocation_outcome` value that distinguishes "could not determine" from "no revocation needed."

3. (P2, testing) **Route-layer `timeout` / `chain_error` arms untested.** Those two `switch` arms (each with a distinct message and `revocation_outcome`) are exercised only at the lib layer; a wrong-outcome / message-swap mutation passes every test. Add supertest cases driving the broadcast to throw `BroadcastTimeoutError` and a plain error, asserting `revocation_outcome`, `revocations: []`, and the message.

4. (P2, security, pre-existing — secondary to item 1; split or drop if you prefer) **No per-account write limit on `/retract`.** `/api/wot` mounts only the `byIp` readLimiter; `/retract` triggers an admin broadcast with no `byAccount` write limit. Add a per-account write limiter to `/retract` (and `/vouch`) as defense-in-depth bounding the item-1 abuse surface. This is secondary: item 1's verification gate is the actual fix.

5. (P3, maintainability + kieran-typescript) **Make the retract handler switch exhaustive.** It uses `default` for `'skipped'`, silently absorbing any future `VoucheeRevocationOutcome` variant. Add an explicit `case 'skipped':` plus a `never`-asserting `default` so a new variant becomes a compile error.

6. (P3, kieran-typescript) **Type the discovery query.** `revokeVoucheeIfBelowThreshold`'s `pool.query(...)` is untyped; add `pool.query<{ account: string }>(...)` to match the typed-generic idiom now enforced on the sibling cascade query. Optional same-file sweep: `getVouchStatus`'s query carries the same untyped `as string` pattern.

7. (P3, maintainability, discretionary) **Shared revoke payload.** `cascadeRevocation` and `revokeVoucheeIfBelowThreshold` build the identical `{ action: 'revoke', account, reason, timestamp }` object. Extract a `buildRevocationPayload(account)` helper only if you are already touching this area.

When all items land, `git mv` this file back to `tasks/review/`. Do not edit the held-items list above — the commit diff is the evidence; the architect updates this block at re-review.

[Architect, deferred to archive] The API contract update flagged in the completion note above is sequenced AFTER item 1: the architect will rewrite the `accreditation.md` `POST /api/wot/retract` section to match the final response shape (`revocation_outcome`, dropped `partial_cascade`) AND the new error surface (403 / 422 from the item-1 gate) at archive time, and fix the pre-existing emdash in that section. Do not update the doc yourself.
