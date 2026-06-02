# BACKEND-CASCADE-PENDING-VOUCHEES-INCLUDE-SLICE — `cascadeRevocation` drops same-level unprocessed vouchees from `pending` when nested call throws `PartialCascadeError`

**Owner:** backend
**Created:** 2026-05-30 (surfaced by HAF-query multi-lens review, rank #24 medium severity, correctness)
**Priority:** P2 (operator follow-up logs miss accounts that should be re-revoked, defeating the `PartialCascadeError` surface's whole purpose)

## Problem

[wot.ts:382-397](backend/src/wot.ts#L382-L397) — when a nested `cascadeRevocation` throws `PartialCascadeError` mid-iteration, the catch folds `nested.completed` / `nested.pending` but never includes `result.rows.slice(i+1)` (current-level vouchees identified but never attempted).

The deadline-check branch at lines 313-318 correctly does `slice(i)` — the nested-error branch is asymmetric. Operator follow-up logs miss accounts that should be re-revoked, defeating the `PartialCascadeError` surface's whole purpose.

## Goal

Make the nested-error catch include the unprocessed slice symmetrically with the deadline-check branch.

### Suggested approach

Before re-throwing in the nested catch:

```typescript
for (const r of result.rows.slice(i + 1)) {
  pending.push(r.vouchee as string);
}
```

Use `i + 1` (not `i`) because the current vouchee at `i` was successfully broadcast and is already in `completed`.

## Acceptance

- Regression test: seed children for the first vouchee so the budget blows inside the nested call; assert `pending` includes the unprocessed same-level vouchees (`slice(i+1)`).
- The deadline-check branch's behavior unchanged.
- `PartialCascadeError`'s `completed` + `pending` cover all originally-identified vouchees (their union matches the seeded set).
- Comment anchors clean.
- `npm run typecheck` + `npm run lint` clean.

## Notes

- Land BEFORE #12 (`backend-wot-cascade-single-discovery-query`) so #12's rewrite uses the correct accounting shape, OR land together as one task. The bug exists in the current loop shape; the single-discovery rewrite should preserve the correct accounting from the start.

## Cross-references

- [backend/src/wot.ts](backend/src/wot.ts) lines 382-397 (nested-error catch), lines 313-318 (deadline-check branch — the correct symmetric form).
- HAF-query review run `w274tijk0` rank #24.
