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

## Architect review (2026-06-09) — HELD PENDING FIXES (1 item)

First-review `/ce-code-review` on commit `5190927e` (correctness/security/adversarial on Opus; testing/maintainability/project-standards/performance/kieran-typescript/learnings on Sonnet; ce-agent-native skipped per PEvO). **The P0 signer gate itself is verified CORRECT and COMPLETE at both sites and is NOT in question:** the `rv.approver IN (rv.paper_author, $bridge, $admin, rv.claimer)` predicate matches hive-schemas.md § 2.11's four authorities exactly; `approver = required_posting_auths ->> 0` is the chain-verified signer; the gate fails closed on NULL / malformed payloads; params bind correctly (cycle `$17` bridge / `$21` admin, read surface `bridgeIdx`/`adminIdx` threaded with `nextIdx + 1`); and the cycle `accepted_claims` and read-surface `authorshipClaimsCteBody` resolve revokes identically. Adversarial constructed forged-revoke, false-positive-suppression, cross-surface-divergence, and `->> 0`-element-0 attacks — all refuted. No second ungated revoke-resolution path (the notification arm carries its own independent § 2.11 gate). Only one test-doc-accuracy fix holds.

### Item held (must fix before archive)

1. (P3, maintainability + kieran-typescript + testing) The cycle SQL-shape canary's file-header comment in `reputation-revoke-signer-gate-cycle-sql-shape.test.ts` overclaims its coverage. The header says a "param insertion before `$17`" / "bridge/admin-param drift" is caught, but the canary asserts the literal string `rv.approver IN (rv.paper_author, $17, $21, rv.claimer)` — so it catches a predicate removal or a literal edit of the IN-list, but NOT positional drift: a new bind inserted ahead of `$17` that leaves the gate's `$17`/`$21` references stale breaks the gate while the canary stays green. Unlike the read surface (whose param positions are pinned structurally by the `authorshipClaimsCteBody` param-arithmetic assertions in `hafsql.test.ts`), the cycle's `$17`/`$21` positions have no structural test. Reword the header so it accurately bounds what the canary protects (predicate removal + literal IN-list edits on the emitted cycle SQL) and stops implying it catches a param-position insertion ahead of `$17`. Comment-only change; do NOT weaken the existing regex assertion.

### Deferred / dismissed (no action on this task — recorded so re-review does not re-raise them)

- **Deferred to `backend-reputation-claims-cte-dedup`:** a structural `$17`/`$21` param-position assertion for the cycle (mirroring `hafsql.test.ts`) would fully close the positional-drift gap, but the dedup task merges the two hand-mirrored surfaces and removes the cycle's hardcoded literals — the structural test belongs there.
- **Dismissed (consistent with precedent):** the synthetic-VALUES FROM-redirect in `authorship-revoke-signer-gate.test.ts` lacks a `not.toContain(...)` redirect-took-effect guard. The sibling precedents (`authorship-approve-signer-gate.test.ts`, `hafsql.test.ts`) also lack it; that guard was introduced and codified as convention after this test was authored. Optional to add for consistency; not a blocker.
- **Already fixed:** the `base[3] = 0` stale-comment mutation that existed in commit `5190927e` was removed by the later co-author-credit cleanup; the current test tree no longer carries it.
- **Soft testing gaps (no reachable failure mode):** no explicit `rv.claimer` self-loop negative case, no single-rowset read-vs-cycle parity case. Obviated when the dedup task merges the surfaces.

## Backend re-review signal (2026-06-09, working tree)

Item 1 landed (comment-only). Reworded the file header of `tests/routes/reputation-revoke-signer-gate-cycle-sql-shape.test.ts` to accurately bound what the canary protects: it asserts the predicate's presence and the literal `rv.approver IN (rv.paper_author, $17, $21, rv.claimer)` text, so it catches a predicate removal or a literal IN-list edit on the emitted cycle SQL — but it does NOT catch a param-position insertion ahead of `$17` (a new bind added earlier shifts what `$17`/`$21` resolve to while the hand-written SQL text still reads `$17, $21`, so the regex stays green). The header now states the cycle's `$17`/`$21` positions have no structural test (unlike the read surface's `hafsql.test.ts` param-arithmetic assertions) and that closing the positional gap is left to the planned merge of the two mirrored claim-resolution surfaces once the hardcoded literals are gone. Also fixed the carve-out (c) phrase ("a removal/param-drift tripwire" → "a predicate-removal / literal-IN-list-edit tripwire") and the inline comment above the assertion (which had claimed pinning `$17`/`$21` "catches a param insertion that would drift either signer").

Per the comment-anchor convention (`task-slug-citations-in-comments-go-stale-on-archive`), the deferral is described behaviorally ("the planned merge of the two mirrored claim-resolution surfaces") rather than by citing the `backend-reputation-claims-cte-dedup` slug — auditing the replacement text for rot per `convention-enforcing-fix-must-audit-its-own-new-code`.

The existing regex assertion is unchanged (not weakened). Verification: `npm run typecheck:tests` clean; `reputation-revoke-signer-gate-cycle-sql-shape.test.ts` green (1/1). No `src/` change, so `npm run lint` (eslint src/) is unaffected.
