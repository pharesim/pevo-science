# BACKEND-WOT-CASCADE-SINGLE-DISCOVERY-QUERY — `cascadeRevocation` runs 1+2N HAF round-trips per cascade level in a trust-layer hot path

**Owner:** backend
**Created:** 2026-05-30 (surfaced by HAF-query multi-lens review, ranks #12 + #30 high+medium severity, performance/simplification; merged into one task per the synthesis recommendation)
**Priority:** P1 (rebuilds heavyweight `accred_ranked`+`vouch_ranked` CTEs over `operation_custom_json_view` 1+2K times per level; cascade recursion multiplies geometrically)

## Problem

After fetching a voucher's vouchees, the loop in [wot.ts:297-344](backend/src/wot.ts#L297-L344) fires two extra HAF queries per vouchee:
1. A `method='wot'` check.
2. A recount excluding the revoked voucher.

Each rebuilds the heavyweight `accred_ranked + vouch_ranked` CTEs over `operation_custom_json_view`. K vouchees = `1 + 2K` round-trips per level; cascade recursion multiplies geometrically.

Production path via `/api/wot/retract` (once #6 lands, this path is invoked correctly only for actual accreditation revocations); also invoked on every accreditation revocation.

## Goal

Replace the per-vouchee 2-query pair with a single discovery query per cascade level that returns the set of vouchees-to-revoke directly.

### Suggested approach

Single discovery query per cascade level:

```sql
WITH ...
SELECT av.vouchee
FROM active_vouches av
JOIN active_accreditations aa ON aa.account = av.vouchee AND aa.method = 'wot'
WHERE av.voucher = $revoked
GROUP BY av.vouchee
HAVING (
  SELECT COUNT(*) FROM active_vouches av2
  WHERE av2.vouchee = av.vouchee
    AND av2.voucher != $revoked
) < $threshold;
```

The loop then only broadcasts (and the per-iteration budget/deadline check stays unchanged). Drops discovery from `1+2N` to `1` per level.

## Acceptance

- Regression test: a cascade with K vouchees fires exactly 1 discovery query per level (not 1+2K), verified via mock-call count or query log.
- The set of vouchees-to-revoke matches the previous loop's selection exactly (no false positives, no false negatives). Pin with a test seeding multiple vouchees with varying recount results.
- The per-iteration budget/deadline check still fires on the broadcast loop (not the discovery query) — pin the deadline-stop behavior.
- The `PartialCascadeError` `completed` / `pending` accounting still reports correctly (interacts with #24 — `backend-cascade-pending-vouchees-include-slice`; land #24 first or together).
- Comment anchors clean.
- `npm run typecheck` + `npm run lint` clean.

## Notes

- Subsumes rank #30 (`Two queries per vouchee in cascade can collapse to one`) — the synthesis flagged that as standalone only if this rewrite gets descoped. Merged here.
- Independent of #6 (`/api/wot/retract` wrong-account) — but #6 changes the upstream caller. Land both; either order works. After #6, `cascadeRevocation` is reserved for actual accreditation revocations, and this fix optimizes that hot path.
- Independent of #5 (vouch signer gate). Land both.

## Cross-references

- [backend/src/wot.ts](backend/src/wot.ts) lines 297-344 (cascade loop), 321-344 (per-vouchee 2-query pair), 382-397 (nested-error pending slice — task #24).
- HAF-query review run `w274tijk0` ranks #12 + #30 (merged).

---

## Architect re-review (2026-05-30) — HELD PENDING FIXES

Round-1 review on commit `ebddaf66`. SQL param binding clean; the per-iteration deadline/budget check and the `PartialCascadeError` completed/pending accounting are unchanged and correct. Three items hold archive (item 1 is a P1 correctness regression):

1. **INNER-JOIN selection-parity break** (P1, correctness). The discovery query's INNER joins on `av_all`/`aa_voucher` mean a vouchee whose count of currently-accredited, non-revoked vouchers is exactly zero never forms a `GROUP` and is silently NOT revoked — but the old 1+2K loop revoked it (recount 0 < threshold). This is the cascade-terminal case the mechanism exists to catch (an account left WoT-accredited with zero accredited vouchers); reachable in deep recursive chains and whenever an upstream revoke is already indexed when the deeper level runs. Found independently by the correctness and adversarial reviewers, both with full traces. Fix: `LEFT JOIN` `av_all`/`aa_voucher` with `HAVING COUNT(aa_voucher.account) < $threshold` (NULL-skipping) so a zero-remaining vouchee still forms a group and is selected, matching the old loop exactly.

2. **Parity test is mock-blind** (P2, tests). `makeCascadeHafMock` returns the to-be-revoked set directly, bypassing the real JOIN/HAVING SQL, so it cannot detect item 1. Add a real-path SQL regression (seeded HAF/Postgres per the test-mock carve-out) covering: a vouchee whose only accredited voucher is the revoked one (must be selected); a vouchee at exactly threshold remaining (must NOT) vs threshold-1 (must); and a non-wot vouchee (excluded). Also pin the threshold bind value (`params[last] === DEFAULT_WOT_THRESHOLD`, not just `typeof === 'number'`).

3. **CTE re-materialization** (P2, perf). The discovery query references `active_vouches`/`active_accreditations` twice each; without `MATERIALIZED` (PG12+ inlines CTEs) the heavy window scans over `operation_custom_json_view` may run 2-4x. Still far better than the old 1+2K shape, but consider adding `MATERIALIZED` — verify with `EXPLAIN (ANALYZE, BUFFERS)` on the HAF node before committing to it; do not apply blindly.
