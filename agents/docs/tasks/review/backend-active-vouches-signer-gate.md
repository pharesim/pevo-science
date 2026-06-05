# BACKEND-ACTIVE-VOUCHES-SIGNER-GATE — `vouch_ranked` accepts unsigned voucher claims; direct path to unauthorized auto-accreditation via WoT

**Owner:** backend
**Created:** 2026-05-30 (surfaced by HAF-query multi-lens review, rank #5 high severity, correctness/security)
**Priority:** P0 (direct path to unauthorized WoT auto-accreditation; mirror retract attack silently drops legitimate vouches)

## Problem

`vouch_ranked` in [hafsql.ts:251-278](backend/src/hafsql.ts#L251-L278) derives `voucher` from `cj.json` with **NO** `required_posting_auths` check. Sibling CTEs (`activeAccreditationsCteBody`, `retractedPapersCteBody`) correctly enforce this; `vouch_ranked` is the outlier.

Any account can broadcast:

```json
{"action": "vouch", "voucher": "alice", "vouchee": "mallory"}
```

signed only by Mallory. [wot.ts](backend/src/wot.ts) then JOINs `active_accreditations.account = av.voucher`, resolves Alice's accreditation, and counts the forged vouch toward `broadcastWotAccreditation`'s threshold — admitting Mallory.

The mirror `retract_vouch` attack is just as direct: a forged retract signed by anyone supersedes a legitimate prior vouch via latest-block-wins ordering, silently dropping legitimate vouches.

## Goal

Gate `vouch_ranked` on the signer matching the encoded `voucher` field, covering both `vouch` and `retract_vouch` actions.

### Suggested approach

Add to `vouch_ranked`'s WHERE clause:

```sql
AND cj.required_posting_auths ? (cj.json::jsonb ->> 'voucher')
```

The `?` operator covers both `vouch` and `retract_vouch` — both encode the signer in the same `voucher` field.

## Acceptance

- Two regression tests:
  1. Forged `vouch` (Mallory signs, names Alice as `voucher`) is absent from `active_vouches`.
  2. Forged `retract_vouch` does NOT supersede a legitimate prior `vouch` (the legitimate vouch remains active).
- Legitimate vouches and retracts (signer == voucher) continue to work end-to-end. Pin a positive case per action.
- SQL-shape canary asserts the `required_posting_auths ?` predicate is present in `vouchRankedCteBody`.
- One real-HAF dev run confirms the `getVouchStatus` / threshold computation for a known accredited account is unchanged for legitimate vouches.
- Comment anchors clean.
- `npm run typecheck` + `npm run lint` clean.

## Notes

- Independent of #6 (`/api/wot/retract` cascade-with-wrong-account). Land both this week — they're sibling WoT trust-layer defects.
- The `cascadeRevocation` rewrite (#12) is downstream of this in the trust-layer hot path. Land this fix first.

## Cross-references

- [backend/src/hafsql.ts](backend/src/hafsql.ts) lines 251-278 (`vouch_ranked`).
- [backend/src/wot.ts](backend/src/wot.ts) — primary consumer (`getVouchStatus`, `broadcastWotAccreditation`).
- Sibling correctly-gated CTEs: `activeAccreditationsCteBody`, `retractedPapersCteBody` — same shape, reference for the gate clause.
- HAF-query review run `w274tijk0` rank #5.

## Architect re-review (2026-06-05) — HELD PENDING FIXES (2 items)

`/ce-code-review` (correctness/security/adversarial on Opus; testing/maintainability/project-standards/kieran-typescript on Sonnet; learnings unstructured; ce-agent-native-reviewer skipped per PEvO) on commit 42785f7b. The P0 fix itself is verified CLOSED: security grepped every vouch-edge derivation (`getVouchStatus` and the cascade discovery both route through the now-gated `activeVouchesCteBody`; the notification arm is independently gated and never feeds accreditation; no ungated sibling path remains), the chain invariant holds (`required_posting_auths` entries are chain-verified signers), the frontend broadcasts vouch/retract with posting authority only (no legitimate active-auth path gets filtered out), the gate sits pre-`ROW_NUMBER` so a forged retract cannot claim rn=1, the `->>`/`?` NULL semantics fail closed on malformed payloads, and adversarial verified the scenario matrix empirically against real Postgres (both new tests green live). The one-time audit for accreditations already broadcast off forged-vouch thresholds pre-gate was run by the architect at review time. Two test-file nits hold.

### Items held (must fix before archive)

1. (P3, testing + project-standards) The carve-out header's clause-(c) paragraph overclaims: it cites `broadcastWotAccreditation` as running "against the live HAF corpus", but that function is exercised only in mocked form (`wot-broadcast-timeout.test.ts`). The genuine live-HAF companion is `getVouchStatus` via the `GET /api/wot/:username` coverage in `tests/routes/wot.test.ts`. Reword the paragraph to name `getVouchStatus`/`wot.test.ts` as the real-path companion and note `broadcastWotAccreditation` is covered mocked-only.
2. (P3, maintainability) The FROM redirection uses `body.sql.replace(\`${T.customJson} cj\`, 'synthetic_cj cj')`, baking in the `cj` alias; the four precedent files (`hafsql.test.ts`, `authorship-approve-signer-gate.test.ts`, `reputation-orcid-auto-accept-authority-gate.test.ts`) use the alias-free `replace(T.customJson, 'synthetic_cj')`. Switch to the alias-free form and add a one-line replace-took-effect guard (`expect(redirected).not.toContain(T.customJson)`) so an alias/table-reference drift fails immediately instead of indirectly via the downstream positive assertions.

## Backend re-review signal (2026-06-05, working tree)

Both 2026-06-05 hold items landed in `active-vouches-signer-gate.test.ts` (test-only; the P0 SQL gate is unchanged):
1. (P3, testing/project-standards) Clause-(c) header paragraph reworded to name `getVouchStatus` via `GET /api/wot/:username` (`tests/routes/wot.test.ts`) as the live-HAF companion, and to note `broadcastWotAccreditation` is exercised mocked-only (`wot-broadcast-timeout.test.ts`).
2. (P3, maintainability) FROM redirect switched to the alias-free precedent form `body.sql.replace(T.customJson, 'synthetic_cj')`, plus a `expect(redirected).not.toContain(T.customJson)` replace-took-effect guard so a table-reference drift fails immediately.
`npm run typecheck` + `npm run lint` clean.
