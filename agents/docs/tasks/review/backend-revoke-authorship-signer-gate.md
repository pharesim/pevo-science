# BACKEND-REVOKE-AUTHORSHIP-SIGNER-GATE — `revoke_authorship` has no signer gate; any third party can void an approved co-author claim

**Owner:** backend
**Created:** 2026-05-30 (surfaced by HAF-query multi-lens review, rank #3 high severity, correctness/security)
**Priority:** P0 (free targeted reputation-denial vector once the co-author credit fix lands; today silently strips claims from the read surface)

## Problem

`claim_events` in [reputation.ts:468-516](backend/src/reputation.ts#L468-L516) and `authorshipClaimsCteBody` in [hafsql.ts:713-738](backend/src/hafsql.ts#L713-L738) filter only on `custom_id` + `action` for the revoke arm. The approve arm was recently signer-gated (per the just-archived `backend-approve-authorship-signer-gate`), but the revoke arm checks **no signer**.

Per [hive-schemas.md § 2.11](agents/docs/hive-schemas.md), valid `revoke_authorship` requires signer ∈ `{paper_author, hiveBridgeAccount, hiveAdminAccount, claimer}`. As coded, any Hive account can broadcast:

```json
{"action": "revoke_authorship", "claimer": "<victim>", "paper_author": "Y", "paper_permlink": "Z"}
```

and the `NOT EXISTS` clause treats it as authoritative — silently stripping the victim's accepted claim from the read surface AND from `accepted_claims`. Once the co-author-credit bug (rank #2) is fixed, this becomes a free targeted reputation-denial attack.

## Goal

Add the missing signer gate to the revoke arm in both query sites so only the schema-permitted authorities can void a claim.

### Suggested approach

Mirror the approve-gate shape. In both [reputation.ts](backend/src/reputation.ts) (`accepted_claims`) and [hafsql.ts](backend/src/hafsql.ts) (`authorship_claims` CASE), add to the revoke EXISTS:

```sql
AND rv.approver IN (rv.paper_author, $bridgeIdx, $hiveAdminIdx, rv.claimer)
```

Thread `config.hiveBridgeAccount` and `config.hiveAdminAccount` through both query builders. (`config.hiveAdminAccount` is singular by design — do not widen to a plural authorities array.)

## Acceptance

- Forged revoke (signed only by a stranger) does NOT remove an accepted claim. Pin with a test mirroring `backend/tests/.../authorship-approve-signer-gate.test.ts`.
- Each schema-permitted signer (paper_author, bridge, admin, claimer) DOES validly revoke. Pin one positive case per signer (4 cases).
- SQL-shape canary asserts the `IN (paper_author, $bridge, $admin, claimer)` clause is present in both `reputation.ts`'s `accepted_claims` and `hafsql.ts`'s `authorship_claims` builders.
- Comment anchors clean.
- `npm run typecheck` + `npm run lint` clean.

## Notes

- This is a pure-defense fix; the read shape and cycle math stay the same for legitimate revokes. The acceptance test pair (forged absent, legitimate present) is the load-bearing canary.
- Compounds with rank #2 (co-author credit zero score): until #2 lands, the practical impact is read-surface only. Land both within the same week.
- The shared duplication between the two query sites is rank #28's scope (`backend-reputation-claims-cte-dedup`); land this fix first so the dedup merge target is correct.

## Cross-references

- [backend/src/reputation.ts](backend/src/reputation.ts) lines 468-516 (`claim_events` / `accepted_claims`).
- [backend/src/hafsql.ts](backend/src/hafsql.ts) lines 713-738 (`authorshipClaimsCteBody`).
- [agents/docs/hive-schemas.md](agents/docs/hive-schemas.md) § 2.11 (`revoke_authorship` signer enumeration).
- Just-archived `backend-approve-authorship-signer-gate` (pattern + test shape).
- HAF-query review run `w274tijk0` rank #3.
