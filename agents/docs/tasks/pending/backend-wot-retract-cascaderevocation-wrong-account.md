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

## Backend re-review signal (2026-06-09, working tree)

All 7 held items landed. Touched: `backend/src/wot.ts`, `backend/src/routes/wot.ts`, `backend/tests/routes/wot-retract-cascaderevocation.test.ts`, `backend/tests/routes/wot-retract-poll.test.ts` (new), `backend/tests/routes/wot-vouch-broadcast-outcomes.test.ts` (Redis-null mock so the new write limiter is process-local).

- **Item 1 (authz / griefing).** `/api/wot/retract` now (a) rejects self-target (`voucher === vouchee` → 422), (b) gates the signer via `getAccreditedSet([voucher])` → 403 (parity with `/vouch`), and (c) verifies the retraction landed on-chain through a new exported `pollForRetraction(vouchee, voucher)` (bust-and-poll until the signer's vouch edge is gone, mirroring `pollForVouch`) before re-evaluating. On an unverified poll result the handler fail-closes: `revocation_outcome: 'unverified'`, `revocations: []`, no broadcast. Root fix: `revokeVoucheeIfBelowThreshold` dropped its `retractingVoucher` parameter and the unconditional `av_all.voucher != $voucher` recount exclusion — the recount now counts the vouchee's CURRENT accredited vouchers honestly, so a fabricated retraction cannot drop a victim (the poll guarantees the edge is genuinely gone before the recount runs; this is the deliberate re-introduction of ingestion-dependence the hold block sanctioned). Tests: lib `recounts without excluding any voucher in SQL or params`; route `403`/`422`; the full-poll-cap `does NOT revoke when the retraction is unverified`; and `pollForRetraction` verified/unverified/null cases in the new `wot-retract-poll.test.ts`.
- **Item 2 (query_error).** `VoucheeRevocationOutcome` gains `{ outcome: 'query_error' }`; the discovery-query catch returns it instead of `'skipped'`. Route renders a distinct message + `revocation_outcome`. Tests: lib `returns query_error (not skipped) when the discovery query throws`, route `maps a discovery-query failure to revocation_outcome=query_error`.
- **Item 3 (route timeout/chain_error).** Added route supertest cases driving the revoke broadcast to throw `BroadcastTimeoutError` → `timeout` and a plain `Error` → `chain_error`, asserting `revocation_outcome`, `revocations: []`, and message.
- **Item 4 (per-account write limiter).** New `wotWriteLimiter` (`byAccount`, max 10 / 60s) applied AFTER `verifyHiveSignature` on both `/vouch` and `/retract`.
- **Item 5 (exhaustive switch).** Retract `switch` has explicit `case 'skipped'` + `default: return assertNever(revocation)` (project `assertNever` util); a new outcome variant is now a compile error (confirmed by `typecheck`).
- **Item 6 (typed query).** Discovery query is `pool.query<{ account: string }>`; same-file sweep typed `getVouchStatus`'s query and dropped its `as string` casts.
- **Item 7 (shared payload).** Extracted `buildRevocationPayload(account)`, used by both `cascadeRevocation` and `revokeVoucheeIfBelowThreshold`.

Verification: `npm run typecheck` (src + tests) + `npm run lint` clean (the single lint warning is a pre-existing unused-directive in `lib/author-supersession.ts`, untouched). wot suites green — `wot-retract-cascaderevocation` (16) + `wot-retract-poll` (4) + `wot-vouch-poll` + `wot-vouch-broadcast-outcomes` (5) + `wot.test` (3) + `wot-broadcast-timeout` + `active-vouches-signer-gate` + `wot-threshold-signer-gate`, 54 tests passing.

[TODO Architect] Contract (`agents/docs/api-contracts/accreditation.md`, `POST /api/wot/retract`) — in addition to the deferred-to-archive items above, the `revocation_outcome` enum now ALSO includes `'unverified'` (retraction not yet reflected on-chain; nothing evaluated; `revocations: []`) and `'query_error'` (re-evaluation lookup failed; `revocations: []`), beyond the `revoked`/`skipped`/`timeout`/`chain_error` the original completion note listed. Backend does not edit contract files; flagging for the architect's archive-time rewrite.

## Architect re-review (2026-06-09) — HELD PENDING FIXES (1 item)

`/ce-code-review` (correctness + security + adversarial on Opus; testing/reliability/api-contract/performance/maintainability/project-standards/kieran-typescript/learnings on Sonnet; ce-agent-native skipped per PEvO) on commit `36e9f977`, scoped to the 7-item round-3 fix. **All 7 held items are verified landed and correct, and the core authz/griefing fix is SOUND:** security and adversarial independently confirmed the fabricate-a-retraction-you-never-broadcast vector is fully closed — `pollForRetraction` requires the voucher's vouch edge to actually disappear from `active_vouches` before the retract is honored; the handler fail-closes to `revocation_outcome: 'unverified'` on HAF-down / timeout / no-broadcast; and the recount now counts the vouchee's current accredited vouchers honestly with no per-voucher SQL exclusion. Signer binding (`req.hiveUsername`, never the body), the 403 accreditation gate, the 422 self-target guard, the exhaustive `assertNever` switch, the typed queries, the shared `buildRevocationPayload`, and the per-account `wotWriteLimiter` (placed after `verifyHiveSignature`) are all verified correct. Only one doc-accuracy item holds archive:

1. (P3, maintainability + correctness convergence) **Stale "mirroring" docblock in `cascadeDiscoverySelect`.** Its docblock states the LEFT-join + NULL-skipping HAVING is "mirroring `revokeVoucheeIfBelowThreshold`." After this commit the two HAVINGs still share that structural shape, but their FILTER exclusion clauses have DIVERGED: `cascadeDiscoverySelect` keeps `av_all.voucher != <revoked>` (excludes the revoked root from the recount), while `revokeVoucheeIfBelowThreshold` dropped its exclusion entirely (the route pre-verifies the retracting edge is gone, so the recount counts honestly). A reader following the "mirroring" pointer lands on a HAVING that looks different with no explanation. Replace the bare "mirroring" phrase with one sentence that names the shared LEFT-join + NULL-skip structure AND the one-clause divergence (cascade excludes the revoked root in the FILTER; the retract recount excludes nobody because the route verifies the edge is already absent). Anchor on stable symbols / behavioral semantics only — no slug / round-N / SHA / line-number citations in the docblock.

When the docblock fix lands, `git mv` this file back to `tasks/review/`. Do not edit the held item above — the commit diff is the evidence; the architect updates this block at re-review.

**Dismissed at triage (NOT holds):**
- A re-vouch-between-poll-and-recount TOCTOU: a genuinely-retracting voucher could re-vouch in the narrow window where the recount's HAF read straddles the re-vouch's ~3s ingestion lag, firing a sticky wrong-revoke. Security and adversarial disagreed on exploitability (the recount reads HAF-ingested state, which lags actual chain). Routed to a separate P2 follow-up `backend-wot-retract-poll-recount-single-read` (NOT held) because the targeted griefing vector IS closed and the clean fix is non-trivial (the recount additionally gates on the vouchee's `method='wot'`, which `getVouchStatus` does not expose).
- The signer (`retractingVoucher`) dropped from the revoke log fields: dismissed per the logging-minimal stance (revoke `txId` + `vouchee` suffice; the signer is recoverable from chain).
- Two preemptive test-hardening gaps (a route-level null-HAF unverified test; message-text assertions on the timeout/chain_error arms): dismissed as theoretical-only.

**Architect-side (DONE, not a hold):** the contract `agents/docs/api-contracts/accreditation.md` `POST /api/wot/retract` was rewritten to document the `revocation_outcome` enum (including `unverified` / `query_error`), the 403/422 errors, the nullable `vouch_status`, and the corrected non-recursive semantics. The frontend coordination gap (the SPA ignores `revocation_outcome` and shows a success message for the fail-closed `unverified` arm) is routed to new UI task `ui-wot-retract-outcome-messaging`.
