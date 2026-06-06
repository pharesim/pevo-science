# BACKEND-REPUTATION-WEIGHTS-SIGNER-GATE — `loadReputationWeights` accepts `update_weights` custom_json from ANY Hive account

**Owner:** backend
**Created:** 2026-06-06 (surfaced by architect review of the reputation cluster: correctness + adversarial lenses on the decayMultiplierSql commit independently flagged it; verified by direct read)
**Priority:** P0 (any Hive account can take control of the reputation algorithm parameters on the live beta)

## Problem

`loadReputationWeights` in `backend/src/reputation.ts` selects the latest weights payload with:

```sql
SELECT cj.json FROM <custom_json view> cj
WHERE cj.custom_id = $1                            -- config.appTag
  AND cj.json::jsonb ->> 'action' = 'update_weights'
ORDER BY cj.block_num DESC
LIMIT 1
```

There is NO filter on the signing account. Hive `custom_json` ops can be broadcast by any account, so any account that broadcasts `{"action":"update_weights","weights":{...}}` with `custom_id = <appTag>` controls every reputation weight from the next 30-minute cache refresh onward: paper/review/citation weights, downvote multiplier, decay grace/rate/floor, accreditation bonus. The payload is spread raw over the defaults (`{ ...DEFAULT_REPUTATION_WEIGHTS, ...payload.weights }`) with no value validation; only `cycle_blocks` is defended downstream (`reputation-batch.ts` clamps it).

Every sibling custom_json consumer already gates on the signer:

- `accreditation.ts` — `cj.required_posting_auths ?| $2::text[]`
- `wot.ts` — `required_posting_auths ?| $2::text[]`
- `consent-ops.ts` — `cj.required_posting_auths ->> 0 IN (...)`
- `notification-queries.ts` — multiple signer-gated arms

`loadReputationWeights` is the outlier. The write side (`hive.ts` broadcastCustomJson) signs with `required_posting_auths: [config.hiveAdminAccount]`, so legitimate ops already carry the right authority; the read side just never checks it.

## Goal

Only `config.hiveAdminAccount`-signed `update_weights` ops may set reputation weights, and accepted values must be sane.

### Suggested approach

1. **Signer gate:** add `AND cj.required_posting_auths ?| ARRAY[$2]` (or the `->> 0 =` form matching how the write side signs) to BOTH weights queries (the cheap existence probe and the latest-op read), parameterized on `config.hiveAdminAccount`. Mirror the `accreditation.ts` shape. `config.hiveAdminAccount` is singular by design; do not widen to an authorities array.
2. **Value validation/clamp:** validate `payload.weights` before spreading: every accepted field numeric and finite; clamp `decay_floor` to `[0, 1]`, `decay_rate >= 0`, `decay_grace_months >= 0`; non-numeric or unknown-shaped fields fall back to defaults. Keep the existing downstream `cycle_blocks` clamp.
3. **Docblock follow-through:** once `decay_floor <= 1.0` is enforced, the `decayMultiplierSql` docblock claim in `hafsql.ts` ("the grace arm returns 1.0 >= decay_floor") becomes unconditionally true; confirm the wording needs no change, or tighten it while in the area.

## Acceptance

- An `update_weights` op signed by a non-admin account is ignored (weights stay at defaults / at the last admin-signed value). Pinned by test.
- An admin-signed op still applies. Pinned by test (real-path per project conventions where feasible; the SQL-shape canary pattern used by the reputation suite is acceptable for the signer-gate predicate).
- Out-of-range values (e.g. `decay_floor: 1.5`, `decay_rate: -1`, `paper: "abc"`) are rejected or clamped; pinned by test.
- Existing weights-cache tests stay green; `npm run typecheck` + `npm run lint` clean.
- Comment anchors clean (no task slug, round number, line number, SHA).

## Cross-references

- `backend/src/reputation.ts` — `loadReputationWeights` (both queries), `WEIGHTS_TTL` cache.
- `backend/src/accreditation.ts` — the established `required_posting_auths ?|` gate shape to mirror.
- `backend/src/hive.ts` — write side signs with `required_posting_auths: [config.hiveAdminAccount]`.
- `backend/src/reputation-batch.ts` — existing `cycle_blocks` clamp (defense-in-depth precedent).
- `backend/src/hafsql.ts` — `decayMultiplierSql` docblock (item 3).

## On final archive (architect)

Invoke `/ce-compound` to capture the convention this defect instantiates: a HAF custom_json read gated only on `custom_id` + `action` is an authentication bypass, because any Hive account can broadcast any custom_id; every consumer must additionally gate on the signing authority (`required_posting_auths`), the way the accreditation, WoT, and consent-op readers already do. Deferred until the fix lands and this task archives clean, so the documented solution reflects the verified gate shape.
