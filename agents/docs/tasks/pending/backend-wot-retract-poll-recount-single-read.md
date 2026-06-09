# BACKEND-WOT-RETRACT-POLL-RECOUNT-SINGLE-READ — /api/wot/retract verifies the retraction and recounts in two separate HAF reads, leaving a narrow sticky-revoke race

**Owner:** backend
**Created:** 2026-06-09 (surfaced by the wot-retract-cascaderevocation re-review, adversarial finding)
**Priority:** P2 (narrow timing window, accredited-only surface, sticky consequence; this is NOT the targeted fabricate-a-retraction griefing vector, which is already closed)

## Problem

`POST /api/wot/retract` verifies the retraction landed on-chain via `pollForRetraction(vouchee, voucher)` (a HAF read through `getVouchStatus`, cache-busted), then calls `revokeVoucheeIfBelowThreshold(vouchee)`, which runs a SEPARATE, independent HAF discovery query to recount the vouchee's accredited vouchers. The two reads are not one snapshot.

A genuinely-retracting accredited voucher A can: broadcast `retract_vouch(A→B)`, let the poll confirm the edge is gone, then broadcast a fresh `vouch(A→B)` on-chain WITHOUT calling `POST /api/wot/vouch`. If the recount's HAF read straddles the re-vouch's ~3s HAF-ingestion lag, it counts A→B as still-absent, sees B below threshold, and fires an admin revoke of B even though B's latest on-chain action from A is a standing vouch. Under latest-action-wins accreditation, with re-accreditation triggered ONLY by `POST /api/wot/vouch`, the wrong revoke is STICKY (B does not self-heal).

Reviewer split: security judged the recount authoritative; adversarial showed the recount reads HAF-*ingested* state, which lags actual chain by the same ~3s the polls exist to absorb, so a window exists. Exploitability is fragile (mistiming flips it to the fail-closed `unverified` arm), hence P2, not P1.

## Goal

Collapse the on-chain verification and the threshold recount into one consistent read so a re-vouch cannot land between them.

### Suggested approach

Derive the revoke decision from the SAME `VouchStatus` the poll already returned, instead of re-reading via a second query. Note the join-parity caveat: `revokeVoucheeIfBelowThreshold`'s recount additionally gates on the vouchee's own accreditation method (`aa_target.method = 'wot'`), which `getVouchStatus` does not currently expose. So either:
- (a) extend `getVouchStatus` (or a shared lower-level read) to carry the vouchee's wot-accreditation flag, and compute `shouldRevoke` from `status.eligible` + that flag; or
- (b) have the poll and the recount share one query / one snapshot.

Before substituting, confirm `getVouchStatus`'s accredited-only `vouches[]` count is equal to the recount's `COUNT(DISTINCT av_all.voucher) FILTER (WHERE aa_voucher.account IS NOT NULL)`.

## Acceptance

- The verification and the recount read the same `active_vouches` / `active_accreditations` snapshot (one read, or the poll's returned status object reused).
- Regression test: a retract followed by a re-vouch that lands between the (former) two reads does NOT revoke a vouchee that is at-threshold on-chain.
- The existing fail-closed behavior (`unverified` on HAF-down / timeout / no-broadcast) and the honest-recount griefing defense are preserved.
- typecheck + lint clean; wot suites green.

## Related

- The fabricate-a-retraction griefing vector is already closed (archived under the wot-retract-cascaderevocation work); this task closes only the residual re-vouch-window race.
